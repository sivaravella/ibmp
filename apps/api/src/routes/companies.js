import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { h, httpError, today as todayFn } from '../util.js';
import { GSTIN_RE, stateFromGstin } from '../gst.js';
import { seedAccounts } from '../ledger.js';
import { loadSubscription } from '../subscription.js';
import { companyLimit, subscriptionStatus } from '../billing.js';
import { PLANS } from '../plans.js';
import { createPlatformAdmin } from '../platform.js';
import { SECTORS, consultantSchema, memberCompanies, saveConsultantProfile } from './auth.js';

const err = (status, message, code, extra = {}) => Object.assign(httpError(status, message), { code, ...extra });

/** Constant-time comparison of the admin key. Admin endpoints do not exist unless ADMIN_API_KEY is set. */
const adminKeyOk = (req) => {
  const key = process.env.ADMIN_API_KEY;
  const got = String(req.headers['x-admin-key'] ?? '');
  return !!key && got.length === key.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
};

export function companyRoutes(pool, { complianceSummary } = {}) {
  const r = Router();

  const user = async (q, id) => (await q.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  const requireConsultant = (u) => { if (u.account_type !== 'consultant') throw err(403, 'This is for consultant accounts. Register as a consultant under Companies first.', 'NOT_CONSULTANT'); };

  /** Companies this consultant manages (their own plus clients), and how many their plan allows. */
  async function usage(q, u) {
    const home = u.company_id;
    const used = Number((await q.query('SELECT COUNT(*) AS n FROM companies WHERE (id=$1 OR billing_company_id=$1) AND archived=false', [home])).rows[0].n);
    const sub = await loadSubscription(q, home);
    const today = todayFn();
    return { home, used, limit: companyLimit({ accountType: u.account_type, sub, today }), sub, status: subscriptionStatus(sub, today) };
  }

  const nextSlab = (plan) => (plan === 'consultant_10' ? null : 'consultant_10');

  // ---- consultant profile ----
  r.get('/account/consultant', h(async (req, res) => {
    const u = await user(pool, req.user.id);
    const profile = (await pool.query('SELECT body, membership_no, registered_name, status, note FROM consultant_profiles WHERE user_id=$1', [u.id])).rows[0] ?? null;
    res.json({ account_type: u.account_type, profile });
  }));

  // Turn an individual account into a consultant account. Verification of the credentials is manual and does not block use.
  r.post('/account/consultant', h(async (req, res) => {
    const b = consultantSchema.parse(req.body);
    const u = await user(pool, req.user.id);
    await pool.query("UPDATE users SET account_type='consultant' WHERE id=$1", [u.id]);
    await saveConsultantProfile(pool, u.id, b);
    res.status(u.account_type === 'consultant' ? 200 : 201).json({ account_type: 'consultant', status: 'pending' });
  }));

  // ---- companies ----
  r.get('/companies', h(async (req, res) => {
    const u = await user(pool, req.user.id);
    const mine = await memberCompanies(pool, u.id);
    const u1 = u.account_type === 'consultant' ? await usage(pool, u) : null;
    res.json({
      account_type: u.account_type, home_company_id: u.company_id, active_company_id: req.user.companyId,
      limit: u1?.limit ?? 1, used: u1?.used ?? mine.filter((c) => !c.archived).length, plan: u1 ? PLANS[u1.sub.plan_code].name : null,
      companies: mine.map((c) => ({ id: c.id, name: c.name, gstin: c.gstin, state_code: c.state_code, sector: c.sector, archived: c.archived, is_home: c.id === u.company_id, active: c.id === req.user.companyId })),
    });
  }));

  r.post('/companies', h(async (req, res) => {
    const b = z.object({
      name: z.string().min(1).max(120), sector: z.enum(SECTORS),
      gstin: z.string().regex(GSTIN_RE).optional(), stateCode: z.string().regex(/^\d{2}$/).optional(),
    }).parse(req.body);
    const u = await user(pool, req.user.id);
    requireConsultant(u);
    const state = stateFromGstin(b.gstin) || b.stateCode;
    if (!state) throw httpError(400, 'Provide a GSTIN or a stateCode');

    const info = await usage(pool, u);
    if (!info.status.writable) throw err(402, 'Your subscription has expired. Renew under Billing to add companies.', 'SUBSCRIPTION_EXPIRED');
    if (info.used >= info.limit) {
      const up = nextSlab(info.sub.plan_code === 'trial' ? 'consultant_5' : info.sub.plan_code);
      if (!up) throw err(409, `You are using all ${info.limit} companies on the largest slab. Contact us for a larger plan.`, 'COMPANY_LIMIT_MAX');
      throw err(402, `Your plan allows ${info.limit} companies and you are using ${info.used}. Move to ${PLANS[up].name} to add more.`, 'COMPANY_LIMIT', { requiredPlan: up });
    }

    const company = await withTx(pool, async (q) => {
      const c = (await q.query('INSERT INTO companies (name, sector, gstin, state_code, billing_company_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, gstin, state_code, sector', [b.name, b.sector, b.gstin || null, state, info.home])).rows[0];
      await seedAccounts(q, c.id);
      await q.query("INSERT INTO user_companies (user_id, company_id, role) VALUES ($1,$2,'owner')", [u.id, c.id]);
      return c;
    });
    res.status(201).json(company);
  }));

  // Archive a finished client: hidden from the switcher and no longer counted against the slab. Data is kept.
  r.post('/companies/:id/archive', h(async (req, res) => {
    const u = await user(pool, req.user.id);
    requireConsultant(u);
    const id = Number(req.params.id);
    if (id === u.company_id) throw httpError(409, 'Your own company cannot be archived');
    if (id === req.user.companyId) throw httpError(409, 'Switch to another company before archiving this one');
    const c = (await pool.query('SELECT id FROM companies WHERE id=$1 AND billing_company_id=$2', [id, u.company_id])).rows[0];
    if (!c) throw httpError(404, 'Not found');
    await pool.query('UPDATE companies SET archived=true WHERE id=$1', [id]);
    res.json({ ok: true });
  }));

  r.post('/companies/:id/unarchive', h(async (req, res) => {
    const u = await user(pool, req.user.id);
    requireConsultant(u);
    const id = Number(req.params.id);
    const c = (await pool.query('SELECT id, archived FROM companies WHERE id=$1 AND billing_company_id=$2', [id, u.company_id])).rows[0];
    if (!c) throw httpError(404, 'Not found');
    if (c.archived) {
      const info = await usage(pool, u);
      if (info.used >= info.limit) throw err(402, `Your plan allows ${info.limit} companies and all are in use. Archive another or move to a larger slab.`, 'COMPANY_LIMIT', { requiredPlan: nextSlab(info.sub.plan_code === 'trial' ? 'consultant_5' : info.sub.plan_code) });
      await pool.query('UPDATE companies SET archived=false WHERE id=$1', [id]);
    }
    res.json({ ok: true });
  }));

  // ---- practice overview: what is due across all of a consultant's companies ----
  r.get('/consultant/overview', h(async (req, res) => {
    const u = await user(pool, req.user.id);
    requireConsultant(u);
    const asOf = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOf)) ? String(req.query.asOf) : todayFn();
    const mine = (await memberCompanies(pool, u.id)).filter((c) => !c.archived);
    const rows = [];
    for (const c of mine) {
      const s = await complianceSummary(c.id, asOf);
      rows.push({ id: c.id, name: c.name, gstin: c.gstin, is_home: c.id === u.company_id, active: c.id === req.user.companyId, overdue: s.overdue, due_soon: s.due_soon, next: s.next[0] ?? null, most_overdue: s.most_overdue[0] ?? null });
    }
    rows.sort((a, b) => b.overdue - a.overdue || b.due_soon - a.due_soon || a.name.localeCompare(b.name));
    res.json({ as_of: asOf, totals: { companies: rows.length, overdue: rows.reduce((s, x) => s + x.overdue, 0), due_soon: rows.reduce((s, x) => s + x.due_soon, 0) }, companies: rows });
  }));

  return r;
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

/**
 * Back-office endpoints for IBMP staff, outside user authentication. They exist only when ADMIN_API_KEY is set, and then
 * require it in the x-admin-key header. This is the manual verification step for consultants' professional credentials.
 */
export function adminRoutes(pool, { bcryptRounds = 12 } = {}) {
  const r = Router();
  r.use((req, res, next) => (adminKeyOk(req) ? next() : res.status(process.env.ADMIN_API_KEY ? 401 : 404).json({ error: process.env.ADMIN_API_KEY ? 'Unauthorized' : 'Not found' })));

  // Bootstrap: create a platform console login (the console itself has no sign-up). Also available as scripts/create-platform-admin.js.
  r.post('/platform-admins', h(async (req, res) => {
    const b = z.object({ email: z.string(), name: z.string(), password: z.string(), role: z.string().optional() }).parse(req.body);
    res.status(201).json(await createPlatformAdmin(pool, { ...b, rounds: bcryptRounds }));
  }));

  r.get('/consultants', h(async (req, res) => {
    const status = ['pending', 'verified', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS user_name, u.email FROM consultant_profiles p JOIN users u ON u.id=p.user_id ${status ? 'WHERE p.status=$1' : ''} ORDER BY p.submitted_at`, status ? [status] : []);
    res.json(rows);
  }));

  r.post('/consultants/:userId/decision', h(async (req, res) => {
    const b = z.object({ status: z.enum(['verified', 'rejected']), note: z.string().max(300).optional() }).parse(req.body);
    const x = await pool.query('UPDATE consultant_profiles SET status=$1, note=$2, verified_at=$3 WHERE user_id=$4', [b.status, b.note ?? null, b.status === 'verified' ? new Date() : null, req.params.userId]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    res.json({ ok: true });
  }));
  return r;
}
