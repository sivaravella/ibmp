import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { signPlatformToken, verifyPlatformToken } from '../auth.js';
import { passwordProblem } from '../platform.js';
import { PLANS } from '../plans.js';
import { addDays, subscriptionStatus } from '../billing.js';
import { loadSubscription } from '../subscription.js';
import { monthsBack } from './analytics.js';

const code = (err, c) => Object.assign(err, { code: c });
const MAX_FAILED = 5, LOCK_MINUTES = 15;
// Compared against when the email is unknown, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/**
 * The platform owner console API (/v1/platform). Sign-in is separate from business sign-in. A platform admin sees how the
 * platform is doing and manages accounts, subscriptions and consultant verification: companies' own books (invoices, ledger,
 * payroll) are not exposed here, only counts, and nobody can sign in as a customer. Every change is written to the audit log.
 */
export function platformRoutes(pool) {
  const r = Router();
  const ip = (req) => req.ip ?? '';

  // ---------- sign-in ----------
  r.post('/login', h(async (req, res) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(req.body);
    const a = (await pool.query('SELECT * FROM platform_admins WHERE email=$1', [b.email.toLowerCase()])).rows[0];
    if (a?.locked_until && new Date(a.locked_until) > new Date()) throw code(httpError(429, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`), 'LOCKED');
    const good = await bcrypt.compare(b.password, a?.password_hash ?? DUMMY_HASH);
    if (!a || !a.active || !good) {
      if (a) {
        const n = a.failed_logins + 1;
        await pool.query('UPDATE platform_admins SET failed_logins=$1, locked_until=$2 WHERE id=$3', [n >= MAX_FAILED ? 0 : n, n >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null, a.id]);
      }
      throw httpError(401, 'Invalid email or password.');
    }
    await pool.query('UPDATE platform_admins SET failed_logins=0, locked_until=NULL, last_login_at=$1 WHERE id=$2', [new Date(), a.id]);
    await pool.query('INSERT INTO platform_audit (admin_id, admin_email, action, detail) VALUES ($1,$2,$3,$4)', [a.id, a.email, 'login', JSON.stringify({ ip: ip(req) })]);
    res.json({ token: signPlatformToken(a), admin: { name: a.name, email: a.email, role: a.role } });
  }));

  // ---------- everything below needs a platform token ----------
  r.use(h(async (req, res, next) => {
    let p;
    try { p = verifyPlatformToken(req.headers.authorization); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const a = (await pool.query('SELECT * FROM platform_admins WHERE id=$1', [p.id])).rows[0];
    if (!a || !a.active) return res.status(401).json({ error: 'Unauthorized' });     // switching an admin off takes effect at once
    req.admin = { id: a.id, email: a.email, name: a.name, role: a.role };
    next();
  }));

  const needOwner = (req) => { if (req.admin.role !== 'owner') throw code(httpError(403, 'This is a read-only platform account.'), 'READ_ONLY'); };
  const audit = (req, action, targetType, targetId, detail) =>
    pool.query('INSERT INTO platform_audit (admin_id, admin_email, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.admin.id, req.admin.email, action, targetType ?? null, targetId === undefined ? null : String(targetId), JSON.stringify({ ...detail, ip: ip(req) })]);
  const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters): it goes in the audit log.').max(300);

  r.get('/me', h(async (req, res) => res.json(req.admin)));

  r.post('/password', h(async (req, res) => {
    const b = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const a = (await pool.query('SELECT * FROM platform_admins WHERE id=$1', [req.admin.id])).rows[0];
    if (!(await bcrypt.compare(b.current, a.password_hash))) throw httpError(400, 'The current password is not right.');
    const problem = passwordProblem(b.next);
    if (problem) throw httpError(400, problem);
    await pool.query('UPDATE platform_admins SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(b.next, 12), a.id]);
    await audit(req, 'password_changed', 'admin', a.id, {});
    res.json({ ok: true });
  }));

  // ---------- data helpers ----------
  const today = () => todayFn();
  const subRows = async () => new Map((await pool.query('SELECT * FROM subscriptions')).rows.map((s) => [s.company_id, {
    ...s, trial_ends: ymd(s.trial_ends), period_start: s.period_start ? ymd(s.period_start) : null, period_end: s.period_end ? ymd(s.period_end) : null,
  }]));
  const statusOf = (sub, t) => (sub ? subscriptionStatus(sub, t) : { status: 'none', plan: null, daysLeft: null, writable: false });

  // ---------- overview ----------
  r.get('/overview', h(async (req, res) => {
    const t = today();
    const users = (await pool.query('SELECT account_type, COUNT(*) AS n FROM users GROUP BY account_type')).rows;
    const cos = (await pool.query('SELECT id, billing_company_id, archived, suspended_at, created_at FROM companies')).rows;
    const subs = await subRows();
    const home = cos.filter((c) => !c.billing_company_id);
    const byStatus = {}, byPlan = {};
    for (const c of home) {
      const st = statusOf(subs.get(c.id), t);
      byStatus[st.status] = (byStatus[st.status] ?? 0) + 1;
      if (st.status === 'active' || st.status === 'grace') byPlan[st.plan] = (byPlan[st.plan] ?? 0) + 1;
    }
    const since = (d) => cos.filter((c) => ymd(c.created_at) >= addDays(t, -d)).length;
    const pay = (await pool.query("SELECT paid_on, taxable, total FROM billing_invoices WHERE status='paid'")).rows;
    const sum = (rows, k) => rows.reduce((s, x) => s + Number(x[k]), 0);
    const last30 = pay.filter((x) => x.paid_on && ymd(x.paid_on) >= addDays(t, -30));
    const cons = (await pool.query('SELECT status, COUNT(*) AS n FROM consultant_profiles GROUP BY status')).rows;
    const recent = (await pool.query('SELECT id, name, created_at, suspended_at FROM companies ORDER BY id DESC LIMIT 5')).rows;
    // Twelve-month trends, and what the paying accounts would bill per month at list price (an estimate: grants and discounts differ).
    const months = monthsBack(t, 12);
    const signupSeries = Object.fromEntries(months.map((m) => [m, 0])), revenueSeries = Object.fromEntries(months.map((m) => [m, 0]));
    for (const c of cos) { const m = ymd(c.created_at).slice(0, 7); if (m in signupSeries && !c.billing_company_id) signupSeries[m] += 1; }
    for (const x of pay) { const m = x.paid_on ? ymd(x.paid_on).slice(0, 7) : null; if (m && m in revenueSeries) revenueSeries[m] += Number(x.taxable); }
    const mrr = Object.entries(byPlan).reduce((sum, [plan, n]) => sum + (PLANS[plan]?.monthly ?? 0) * n, 0);
    res.json({
      asOf: t,
      trends: { months, signups: months.map((m) => signupSeries[m]), revenue: months.map((m) => Math.round(revenueSeries[m] * 100) / 100) },
      mrrEstimate: mrr,
      users: { total: users.reduce((s, x) => s + Number(x.n), 0), individual: Number(users.find((x) => x.account_type === 'individual')?.n ?? 0), consultant: Number(users.find((x) => x.account_type === 'consultant')?.n ?? 0) },
      companies: { total: cos.length, accounts: home.length, clients: cos.length - home.length, archived: cos.filter((c) => c.archived).length, suspended: cos.filter((c) => c.suspended_at).length, signupsLast7: since(7), signupsLast30: since(30) },
      subscriptions: { byStatus, activeByPlan: byPlan },
      revenue: { invoicesPaid: pay.length, taxableTotal: sum(pay, 'taxable'), grossTotal: sum(pay, 'total'), taxableLast30: sum(last30, 'taxable'), grossLast30: sum(last30, 'total'), invoicesLast30: last30.length },
      consultants: Object.fromEntries(['pending', 'verified', 'rejected'].map((s) => [s, Number(cons.find((x) => x.status === s)?.n ?? 0)])),
      recentCompanies: recent.map((c) => ({ id: c.id, name: c.name, createdAt: ymd(c.created_at), suspended: !!c.suspended_at })),
    });
  }));

  // ---------- consultants ----------
  r.get('/consultants', h(async (req, res) => {
    const status = ['pending', 'verified', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS user_name, u.email, u.company_id FROM consultant_profiles p JOIN users u ON u.id=p.user_id ${status ? 'WHERE p.status=$1' : ''} ORDER BY p.submitted_at DESC`, status ? [status] : []);
    const clients = (await pool.query('SELECT uc.user_id, COUNT(*) AS n FROM user_companies uc JOIN companies c ON c.id=uc.company_id WHERE c.billing_company_id IS NOT NULL GROUP BY uc.user_id')).rows;
    res.json(rows.map((p) => ({
      userId: p.user_id, name: p.user_name, email: p.email, body: p.body, membershipNo: p.membership_no, registeredName: p.registered_name, status: p.status, note: p.note,
      submittedAt: ymd(p.submitted_at), verifiedAt: p.verified_at ? ymd(p.verified_at) : null, homeCompanyId: p.company_id,
      nameMatches: p.registered_name.trim().toLowerCase() === p.user_name.trim().toLowerCase().replace(/^(ca|cs|cma|adv)\.?\s+/, ''),
      clientCompanies: Number(clients.find((c) => c.user_id === p.user_id)?.n ?? 0),
    })));
  }));

  r.post('/consultants/:userId/decision', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ status: z.enum(['verified', 'rejected', 'pending']), note: z.string().trim().max(300).optional() }).parse(req.body);
    if (b.status === 'rejected' && !b.note) throw httpError(400, 'Say why the credentials were rejected: the consultant sees this note.');
    const before = (await pool.query('SELECT status FROM consultant_profiles WHERE user_id=$1', [req.params.userId])).rows[0];
    if (!before) throw httpError(404, 'Not found');
    await pool.query('UPDATE consultant_profiles SET status=$1, note=$2, verified_at=$3 WHERE user_id=$4', [b.status, b.note ?? null, b.status === 'verified' ? new Date() : null, req.params.userId]);
    await audit(req, `consultant_${b.status}`, 'user', req.params.userId, { before: before.status, note: b.note ?? null });
    res.json({ ok: true });
  }));

  // ---------- companies ----------
  const owners = async (ids) => {
    if (!ids.length) return new Map();
    const rows = (await pool.query(
      `SELECT uc.company_id, u.id, u.name, u.email, u.account_type FROM user_companies uc JOIN users u ON u.id=uc.user_id WHERE uc.role='owner' AND uc.company_id IN (${ids.map(Number).filter(Number.isInteger).join(',') || 0}) ORDER BY u.id`)).rows;
    const m = new Map();
    for (const x of rows) if (!m.has(x.company_id)) m.set(x.company_id, x);
    return m;
  };

  r.get('/companies', h(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100), page = Math.max(Number(req.query.page) || 1, 1);
    const like = `%${q}%`;
    const where = q ? `WHERE lower(c.name) LIKE $1 OR lower(COALESCE(c.gstin,'')) LIKE $1 OR c.id IN (SELECT uc.company_id FROM user_companies uc JOIN users u ON u.id=uc.user_id WHERE lower(u.email) LIKE $1 OR lower(u.name) LIKE $1)` : '';
    const total = Number((await pool.query(`SELECT COUNT(*) AS n FROM companies c ${where}`, q ? [like] : [])).rows[0].n);
    const rows = (await pool.query(`SELECT c.* FROM companies c ${where} ORDER BY c.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, q ? [like] : [])).rows;
    const own = await owners(rows.map((c) => c.id));
    const subs = await subRows(), t = today();
    res.json({
      total, page, limit,
      companies: rows.map((c) => {
        const home = c.billing_company_id ?? c.id;
        const st = statusOf(subs.get(home), t);
        const o = own.get(c.id);
        return { id: c.id, name: c.name, gstin: c.gstin, stateCode: c.state_code, createdAt: ymd(c.created_at), archived: c.archived, suspended: !!c.suspended_at,
          owner: o ? { name: o.name, email: o.email, accountType: o.account_type } : null, clientOf: c.billing_company_id, plan: st.plan, subscription: st.status, daysLeft: st.daysLeft };
      }),
    });
  }));

  r.get('/companies/:id', h(async (req, res) => {
    const c = (await pool.query('SELECT * FROM companies WHERE id=$1', [req.params.id])).rows[0];
    if (!c) throw httpError(404, 'Not found');
    const home = c.billing_company_id ?? c.id, t = today();
    const sub = (await subRows()).get(home);
    const members = (await pool.query('SELECT u.id, u.name, u.email, u.account_type, uc.role FROM user_companies uc JOIN users u ON u.id=uc.user_id WHERE uc.company_id=$1 ORDER BY u.id', [c.id])).rows;
    const invoices = (await pool.query('SELECT id, number, plan_code, months, kind, total, status, paid_on, created_at FROM billing_invoices WHERE company_id=$1 ORDER BY id DESC LIMIT 10', [home])).rows;
    const count = async (table) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id=$1`, [c.id])).rows[0].n);   // table names are literals below
    const clients = c.billing_company_id ? [] : (await pool.query('SELECT id, name FROM companies WHERE billing_company_id=$1 ORDER BY id', [c.id])).rows;
    res.json({
      id: c.id, name: c.name, gstin: c.gstin, stateCode: c.state_code, sector: c.sector, createdAt: ymd(c.created_at), archived: c.archived,
      suspended: c.suspended_at ? { at: ymd(c.suspended_at), reason: c.suspended_reason } : null,
      billingCompanyId: c.billing_company_id, clients,
      subscription: sub ? { ...statusOf(sub, t), planName: PLANS[sub.plan_code]?.name, trialEnds: sub.trial_ends, periodStart: sub.period_start, periodEnd: sub.period_end, cancelAtPeriodEnd: sub.cancel_at_period_end } : null,
      members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, accountType: m.account_type, role: m.role })),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, plan: i.plan_code, months: i.months, kind: i.kind, total: Number(i.total), status: i.status, paidOn: i.paid_on ? ymd(i.paid_on) : null })),
      activity: { invoices: await count('invoices'), purchases: await count('purchases'), parties: await count('parties'), employees: await count('employees') },
    });
  }));

  const companyOr404 = async (id) => {
    const c = (await pool.query('SELECT * FROM companies WHERE id=$1', [id])).rows[0];
    if (!c) throw httpError(404, 'Not found');
    return c;
  };

  r.post('/companies/:id/suspend', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ reason }).parse(req.body);
    const c = await companyOr404(req.params.id);
    if (c.suspended_at) throw httpError(409, 'This company is already suspended.');
    await pool.query('UPDATE companies SET suspended_at=$1, suspended_reason=$2 WHERE id=$3', [new Date(), b.reason, c.id]);
    await audit(req, 'company_suspended', 'company', c.id, { name: c.name, reason: b.reason });
    res.json({ ok: true });
  }));

  r.post('/companies/:id/unsuspend', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ reason }).parse(req.body);
    const c = await companyOr404(req.params.id);
    if (!c.suspended_at) throw httpError(409, 'This company is not suspended.');
    await pool.query('UPDATE companies SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1', [c.id]);
    await audit(req, 'company_unsuspended', 'company', c.id, { name: c.name, reason: b.reason, wasSuspendedFor: c.suspended_reason });
    res.json({ ok: true });
  }));

  // Subscriptions belong to the account's home company; a consultant's client companies share it.
  const homeOnly = (c) => { if (c.billing_company_id) throw code(httpError(400, `This is a client company: its subscription is the consultant's (company ${c.billing_company_id}).`), 'CLIENT_COMPANY'); };

  r.post('/companies/:id/extend-trial', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ days: z.number().int().min(1).max(90), reason }).parse(req.body);
    const c = await companyOr404(req.params.id);
    homeOnly(c);
    const sub = await loadSubscription(pool, c.id, today());
    if (sub.plan_code !== 'trial') throw httpError(409, 'This company is on a paid plan. Use a complimentary plan grant instead.');
    const from = sub.trial_ends > today() ? sub.trial_ends : today();
    const to = addDays(from, b.days);
    await pool.query('UPDATE subscriptions SET trial_ends=$1 WHERE company_id=$2', [to, c.id]);
    await audit(req, 'trial_extended', 'company', c.id, { name: c.name, days: b.days, before: sub.trial_ends, after: to, reason: b.reason });
    res.json({ trialEnds: to });
  }));

  r.post('/companies/:id/grant', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ planCode: z.string(), days: z.number().int().min(1).max(366), reason }).parse(req.body);
    const c = await companyOr404(req.params.id);
    homeOnly(c);
    const plan = PLANS[b.planCode];
    if (!plan || !plan.purchasable) throw httpError(400, 'Choose a paid plan.');
    const owner = (await pool.query('SELECT account_type FROM users WHERE company_id=$1 ORDER BY id LIMIT 1', [c.id])).rows[0];
    if (plan.audience !== (owner?.account_type ?? 'individual')) throw code(httpError(400, `${plan.name} is for ${plan.audience} accounts; this is a ${owner?.account_type ?? 'individual'} account.`), 'PLAN_AUDIENCE');
    const sub = await loadSubscription(pool, c.id, today());
    const start = today(), end = addDays(start, b.days - 1);
    await pool.query('UPDATE subscriptions SET plan_code=$1, period_start=$2, period_end=$3, cancel_at_period_end=false WHERE company_id=$4', [b.planCode, start, end, c.id]);
    await audit(req, 'plan_granted', 'company', c.id, { name: c.name, plan: b.planCode, days: b.days, before: { plan: sub.plan_code, periodEnd: sub.period_end, trialEnds: sub.trial_ends }, after: { periodStart: start, periodEnd: end }, reason: b.reason, note: 'complimentary: no invoice raised' });
    res.json({ planCode: b.planCode, periodStart: start, periodEnd: end });
  }));

  // ---------- billing ----------
  r.get('/billing', h(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = (await pool.query(
      `SELECT i.id, i.number, i.company_id, i.plan_code, i.months, i.kind, i.taxable, i.cgst, i.sgst, i.igst, i.total, i.paid_on, i.provider, c.name AS company
       FROM billing_invoices i JOIN companies c ON c.id=i.company_id WHERE i.status='paid' ORDER BY i.id DESC LIMIT ${limit}`)).rows;
    const pending = Number((await pool.query("SELECT COUNT(*) AS n FROM billing_invoices WHERE status='pending'")).rows[0].n);
    res.json({
      pendingCheckouts: pending,
      invoices: rows.map((i) => ({ id: i.id, number: i.number, companyId: i.company_id, company: i.company, plan: i.plan_code, months: i.months, kind: i.kind, taxable: Number(i.taxable), gst: Number(i.cgst) + Number(i.sgst) + Number(i.igst), total: Number(i.total), paidOn: i.paid_on ? ymd(i.paid_on) : null, provider: i.provider })),
    });
  }));

  // ---------- audit log ----------
  r.get('/audit', h(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const hideLogins = req.query.logins !== 'true';
    const rows = (await pool.query(`SELECT * FROM platform_audit ${hideLogins ? "WHERE action <> 'login'" : ''} ORDER BY id DESC LIMIT ${limit}`)).rows;
    res.json(rows.map((x) => { let d = {}; try { d = JSON.parse(x.detail ?? '{}'); } catch { /* keep empty */ } return { id: x.id, at: x.created_at, admin: x.admin_email, action: x.action, targetType: x.target_type, targetId: x.target_id, detail: d }; }));
  }));

  r.get('/admins', h(async (req, res) => {
    needOwner(req);
    const rows = (await pool.query('SELECT id, email, name, role, active, last_login_at, created_at FROM platform_admins ORDER BY id')).rows;
    res.json(rows.map((a) => ({ id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, lastLoginAt: a.last_login_at, createdAt: ymd(a.created_at) })));
  }));

  r.put('/admins/:id', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    if (Number(req.params.id) === req.admin.id && !b.active) throw httpError(400, 'You cannot switch off your own account.');
    const x = await pool.query('UPDATE platform_admins SET active=$1 WHERE id=$2', [b.active, req.params.id]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    await audit(req, b.active ? 'admin_enabled' : 'admin_disabled', 'admin', req.params.id, {});
    res.json({ ok: true });
  }));

  return r;
}
