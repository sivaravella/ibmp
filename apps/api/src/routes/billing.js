import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { fyOf } from '../compliance.js';
import { ALLOWED_MONTHS, GST_PCT, GRACE_DAYS, PLANS, PLAN_FOR_FEATURE, featureForPath } from '../plans.js';
import { addDays, periodEnd, quote, quoteForApi, subscriptionStatus, toPaise, toRupees } from '../billing.js';
import { loadSubscription } from '../subscription.js';

const FEATURE_LABEL = { hr: 'Payroll, attendance and leave', accounting: 'This feature' };

/** The party issuing the subscription invoices (IBMP itself). Configure through the environment before going live. */
export const seller = (env = process.env) => ({
  name: env.IBMP_LEGAL_NAME || 'IBMP (set IBMP_LEGAL_NAME)',
  gstin: env.IBMP_GSTIN || null,
  state_code: env.IBMP_STATE_CODE || '36',
  address: env.IBMP_ADDRESS || null,
  prefix: env.IBMP_INVOICE_PREFIX || 'IBMP',
});

const fixInv = (i) => ({
  ...i, period_start: ymd(i.period_start), period_end: ymd(i.period_end), paid_on: i.paid_on ? ymd(i.paid_on) : null,
  base: Number(i.base), credit: Number(i.credit), taxable: Number(i.taxable), cgst: Number(i.cgst), sgst: Number(i.sgst), igst: Number(i.igst), total: Number(i.total),
  credited_ids: i.credited_ids ? JSON.parse(i.credited_ids) : [],
});

/** The company whose subscription pays for this request: the consultant's home company for a client company. */
export const bid = (req) => req.billingCompanyId ?? req.user.companyId;

/**
 * Express middleware for every authenticated business route.
 *  1. The user must still belong to the active company (the token alone is not enough), and it must not be archived.
 *  2. The plan is that of the billing company, so a consultant's client companies share the consultant's subscription.
 *  3. A plan without the needed feature gets 402; an expired subscription keeps read access but cannot write.
 * Billing routes stay reachable so the customer can always pay.
 */
export function subscriptionGate(pool) {
  return h(async (req, res, next) => {
    const m = (await pool.query(
      'SELECT c.billing_company_id, c.archived FROM user_companies uc JOIN companies c ON c.id=uc.company_id WHERE uc.user_id=$1 AND uc.company_id=$2',
      [req.user.id, req.user.companyId])).rows[0];
    if (!m) return res.status(403).json({ error: 'You no longer have access to this company. Sign in again.', code: 'NO_ACCESS' });
    if (m.archived) return res.status(403).json({ error: 'This company is archived.', code: 'COMPANY_ARCHIVED' });
    req.billingCompanyId = m.billing_company_id ?? req.user.companyId;

    if (req.path.startsWith('/billing')) return next();
    const today = todayFn();
    const sub = await loadSubscription(pool, req.billingCompanyId, today);
    const st = subscriptionStatus(sub, today);
    const plan = PLANS[sub.plan_code];
    const feature = featureForPath(req.path);
    if (!plan.features.includes(feature))
      return res.status(402).json({ error: `${FEATURE_LABEL[feature]} is available on the ${PLANS[PLAN_FOR_FEATURE[feature]].name} plan and above.`, code: 'PLAN_REQUIRED', feature, requiredPlan: PLAN_FOR_FEATURE[feature] });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !st.writable)
      return res.status(402).json({ error: 'Your subscription has expired, so the portal is read-only. Renew under Billing to continue.', code: 'SUBSCRIPTION_EXPIRED' });
    next();
  });
}

/**
 * Mark an invoice paid and extend the subscription. Idempotent: a callback and a webhook for the same payment, or a
 * retried webhook, settle it once. A payment that arrives for an abandoned (void) checkout is still honoured.
 */
export async function settle(q, invoiceId, paymentId, today = todayFn()) {
  const claimed = await q.query("UPDATE billing_invoices SET status='paid', payment_id=$1, paid_on=$2 WHERE id=$3 AND status IN ('pending','void') RETURNING *", [paymentId, today, invoiceId]);
  if (!claimed.rowCount) return { changed: false };
  const inv = fixInv(claimed.rows[0]);
  const sub = await loadSubscription(q, inv.company_id, today);

  // Paying twice for the same plan, or paying a stale renewal: queue this period after the one already held.
  // (a renewal is normally contiguous: it starts the day after the held period ends)
  let start = inv.period_start, end = inv.period_end;
  const extending = sub.plan_code === inv.plan_code && sub.period_end && addDays(sub.period_end, 1) >= start && inv.kind !== 'upgrade';
  if (extending) { start = addDays(sub.period_end, 1); end = periodEnd(start, inv.months); }

  const seller1 = seller();
  const counterKey = `${seller1.prefix}/${fyOf(today)}`;
  const n = (await q.query('INSERT INTO billing_counters (key, n) VALUES ($1, 1) ON CONFLICT (key) DO UPDATE SET n = billing_counters.n + 1 RETURNING n', [counterKey])).rows[0].n;
  const number = `${counterKey}/${String(n).padStart(5, '0')}`;
  await q.query('UPDATE billing_invoices SET number=$1, period_start=$2, period_end=$3 WHERE id=$4', [number, start, end, inv.id]);

  for (const id of inv.credited_ids) await q.query('UPDATE billing_invoices SET superseded_by=$1 WHERE id=$2 AND company_id=$3', [inv.id, id, inv.company_id]);
  await q.query('UPDATE subscriptions SET plan_code=$1, period_start=$2, period_end=$3, cancel_at_period_end=false WHERE company_id=$4',
    [inv.plan_code, extending ? sub.period_start : start, end, inv.company_id]);
  return { changed: true, number };
}

export function billingRoutes(pool, gateway) {
  const r = Router();

  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  const requireGateway = () => { if (!gateway) throw Object.assign(httpError(503, 'Online payments are not configured on this server.'), { code: 'NO_GATEWAY' }); };
  const log = (q, invoiceId, source, orderId, paymentId, outcome, detail) =>
    q.query('INSERT INTO billing_events (invoice_id, source, order_id, payment_id, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6)', [invoiceId, source, orderId, paymentId, outcome, detail ?? null]);

  /** Paid invoices of the current plan that still hold unused time: the basis for upgrade credit. */
  async function creditable(q, cid, sub, today) {
    if (sub.plan_code === 'trial') return [];
    const rows = (await q.query("SELECT * FROM billing_invoices WHERE company_id=$1 AND status='paid' AND superseded_by IS NULL AND plan_code=$2", [cid, sub.plan_code])).rows.map(fixInv);
    return rows.filter((i) => i.period_end > today);
  }

  async function quoteFor(q, req, plan, months) {
    const today = todayFn();
    const sub = await loadSubscription(q, bid(req), today);
    const company = (await q.query('SELECT * FROM companies WHERE id=$1', [bid(req)])).rows[0];
    const accountType = (await q.query('SELECT account_type FROM users WHERE id=$1', [req.user.id])).rows[0].account_type;
    const q1 = quote({ accountType, plan, months, sub, creditable: await creditable(q, bid(req), sub, today), today, providerState: seller().state_code, customerState: company.state_code });
    return { q: q1, company, sub };
  }

  const body = z.object({ plan: z.enum(['starter', 'professional', 'enterprise', 'consultant_5', 'consultant_10']), months: z.number().int().refine((m) => ALLOWED_MONTHS.includes(m), `months must be one of ${ALLOWED_MONTHS.join(', ')}`) });

  async function currentView(q, cid) {
    const today = todayFn();
    const sub = await loadSubscription(q, cid, today);
    const st = subscriptionStatus(sub, today);
    const plan = PLANS[sub.plan_code];
    return {
      plan_code: sub.plan_code, plan_name: plan.name, status: st.status, days_left: st.daysLeft, writable: st.writable,
      trial_ends: sub.trial_ends, period_start: sub.period_start, period_end: sub.period_end, cancel_at_period_end: sub.cancel_at_period_end,
      features: plan.features, grace_days: GRACE_DAYS,
    };
  }

  r.get('/billing/subscription', h(async (req, res) => {
    const who = (await pool.query('SELECT account_type FROM users WHERE id=$1', [req.user.id])).rows[0];
    const billing = (await pool.query('SELECT id, name FROM companies WHERE id=$1', [bid(req)])).rows[0];
    res.json({
      account_type: who.account_type, billing_company: billing, billed_via_other_company: bid(req) !== req.user.companyId,
      ...(await currentView(pool, bid(req))),
      gateway: gateway ? { provider: gateway.name, mode: gateway.mode, key_id: gateway.keyId } : null,
      gst_pct: GST_PCT, months: ALLOWED_MONTHS,
      plans: Object.values(PLANS).filter((p) => p.purchasable && p.audience === who.account_type).map((p) => ({ code: p.code, name: p.name, tier: p.tier, monthly: p.monthly, features: p.features, highlights: p.highlights, max_companies: p.max_companies })),
    });
  }));

  r.post('/billing/quote', h(async (req, res) => {
    const b = body.parse(req.body);
    res.json(quoteForApi((await quoteFor(pool, req, b.plan, b.months)).q));
  }));

  // Create a pending invoice and a gateway order for the customer to pay.
  r.post('/billing/checkout', h(async (req, res) => {
    requireGateway();
    const b = body.parse(req.body);
    const cid = bid(req);
    const { q: pq, company } = await quoteFor(pool, req, b.plan, b.months);

    const inv = await withTx(async (q) => {
      await q.query("UPDATE billing_invoices SET status='void' WHERE company_id=$1 AND status='pending'", [cid]);   // an abandoned checkout is replaced
      return fixInv((await q.query(
        `INSERT INTO billing_invoices (company_id, plan_code, months, kind, period_start, period_end, base, credit, taxable, cgst, sgst, igst, total, credited_ids, customer_name, customer_gstin, customer_state, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [cid, pq.plan, pq.months, pq.kind, pq.period_start, pq.period_end, toRupees(pq.base), toRupees(pq.credit), toRupees(pq.taxable), toRupees(pq.cgst), toRupees(pq.sgst), toRupees(pq.igst), toRupees(pq.total),
          JSON.stringify(pq.credited_ids), company.name, company.gstin, company.state_code, gateway.name])).rows[0]);
    });

    let order;
    try {
      order = await gateway.createOrder({ amountPaise: pq.total, receipt: `inv_${inv.id}`, notes: { company_id: String(cid), invoice_id: String(inv.id), plan: pq.plan } });
    } catch (e) {
      await pool.query("UPDATE billing_invoices SET status='void' WHERE id=$1", [inv.id]);
      throw e;
    }
    await pool.query('UPDATE billing_invoices SET order_id=$1 WHERE id=$2', [order.orderId, inv.id]);
    res.status(201).json({
      invoice: { ...inv, order_id: order.orderId },
      order: { provider: gateway.name, mode: gateway.mode, key_id: gateway.keyId, order_id: order.orderId, amount: pq.total, currency: 'INR', description: `${PLANS[pq.plan].name} plan, ${pq.months} month(s)` },
    });
  }));

  async function verifyAndSettle(source, req, { orderId, paymentId, signature }) {
    const cid = bid(req);
    const inv = (await pool.query('SELECT * FROM billing_invoices WHERE order_id=$1 AND company_id=$2', [orderId, cid])).rows[0];
    if (!inv) throw httpError(404, 'No such order');
    if (!gateway.verifyPayment({ orderId, paymentId, signature })) {
      await log(pool, inv.id, source, orderId, paymentId, 'rejected', 'Signature mismatch');
      throw httpError(400, 'The payment could not be verified.');
    }
    const result = await withTx((q) => settle(q, inv.id, paymentId));
    await log(pool, inv.id, source, orderId, paymentId, result.changed ? 'paid' : 'ignored', result.changed ? result.number : 'Already settled');
    return result;
  }

  // Called by the browser after the gateway's checkout succeeds.
  r.post('/billing/verify', h(async (req, res) => {
    requireGateway();
    const b = z.object({ orderId: z.string().min(1), paymentId: z.string().min(1), signature: z.string().min(1) }).parse(req.body);
    const result = await verifyAndSettle('verify', req, b);
    res.json({ ok: true, already_settled: !result.changed, subscription: await currentView(pool, bid(req)) });
  }));

  // Development only: stand in for the gateway's checkout page.
  r.post('/billing/dev/simulate', h(async (req, res) => {
    if (!gateway || gateway.name !== 'mock') throw httpError(404, 'Not found');
    const b = z.object({ orderId: z.string().min(1), outcome: z.enum(['success', 'failure']) }).parse(req.body);
    const paymentId = `pay_mock_${Math.random().toString(36).slice(2, 12)}`;
    if (b.outcome === 'failure') {
      const inv = (await pool.query('SELECT id FROM billing_invoices WHERE order_id=$1 AND company_id=$2', [b.orderId, bid(req)])).rows[0];
      if (!inv) throw httpError(404, 'No such order');
      await log(pool, inv.id, 'simulator', b.orderId, paymentId, 'failed', 'Simulated failure');
      return res.json({ ok: false, subscription: await currentView(pool, bid(req)) });
    }
    await verifyAndSettle('simulator', req, { orderId: b.orderId, paymentId, signature: gateway.sign({ orderId: b.orderId, paymentId }) });
    res.json({ ok: true, subscription: await currentView(pool, bid(req)) });
  }));

  r.get('/billing/invoices', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM billing_invoices WHERE company_id=$1 ORDER BY id DESC', [bid(req)]);
    res.json(rows.map(fixInv).map(({ credited_ids, ...i }) => i));
  }));

  r.get('/billing/invoices/:id', h(async (req, res) => {
    const row = (await pool.query('SELECT * FROM billing_invoices WHERE id=$1 AND company_id=$2', [req.params.id, bid(req)])).rows[0];
    if (!row) throw httpError(404, 'Not found');
    const i = fixInv(row);
    res.json({ ...i, plan_name: PLANS[i.plan_code].name, seller: seller(), gst_pct: GST_PCT });
  }));

  r.post('/billing/cancel', h(async (req, res) => {
    const sub = await loadSubscription(pool, bid(req));
    if (!['active', 'grace'].includes(subscriptionStatus(sub, todayFn()).status)) throw httpError(409, 'There is no paid plan to cancel.');
    await pool.query('UPDATE subscriptions SET cancel_at_period_end=true WHERE company_id=$1', [bid(req)]);
    res.json(await currentView(pool, bid(req)));
  }));

  r.post('/billing/resume', h(async (req, res) => {
    await pool.query('UPDATE subscriptions SET cancel_at_period_end=false WHERE company_id=$1', [bid(req)]);
    res.json(await currentView(pool, bid(req)));
  }));

  return r;
}

/** Server-to-server notifications from the gateway. Unauthenticated: trust comes from the signature on the raw body. */
export function webhookRoutes(pool, gateway) {
  const r = Router();
  r.post('/payments', h(async (req, res) => {
    if (!gateway || !req.rawBody || !gateway.verifyWebhook(req.rawBody, req.headers)) {
      await pool.query("INSERT INTO billing_events (source, outcome, detail) VALUES ('webhook','rejected','Bad or missing signature')");
      throw httpError(400, 'Invalid signature');
    }
    const ev = gateway.parseWebhook(req.body);
    if (!ev) return res.json({ ok: true, ignored: true });

    const inv = (await pool.query('SELECT * FROM billing_invoices WHERE order_id=$1', [ev.orderId])).rows[0];
    const ins = (invoiceId, outcome, detail) => pool.query('INSERT INTO billing_events (invoice_id, source, order_id, payment_id, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6)', [invoiceId, 'webhook', ev.orderId, ev.paymentId ?? null, outcome, detail ?? null]);
    if (!inv) { await ins(null, 'ignored', 'Unknown order'); return res.json({ ok: true, ignored: true }); }
    if (!ev.paid) { await ins(inv.id, 'failed', 'Payment failed'); return res.json({ ok: true }); }
    if (ev.amountPaise !== toPaise(inv.total)) {
      await ins(inv.id, 'rejected', `Amount mismatch: got ${ev.amountPaise} paise, expected ${toPaise(inv.total)}`);
      throw httpError(400, 'Amount mismatch');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await settle(client, inv.id, ev.paymentId);
      await client.query('COMMIT');
      await ins(inv.id, result.changed ? 'paid' : 'ignored', result.changed ? result.number : 'Already settled');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ ok: true });
  }));
  return r;
}
