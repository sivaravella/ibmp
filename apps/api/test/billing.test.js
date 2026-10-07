import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider, razorpayProvider, hmac } from '../src/gateway.js';
import { fyOf } from '../src/compliance.js';
import { addDays, periodEnd } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';

const today = todayFn();
let pool, base, gw;
const gwFor = (url) => async (method, path, body, tok, rawHeaders) => {
  const r = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(rawHeaders ?? {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
let call;
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
let seq = 0;
const register = async (stateCode = '29', gstin) => (await call('POST', '/auth/register', {
  name: 'B', email: `billing${++seq}@example.com`, password: 'password123', company: `Billing Co ${seq}`, sector: 'trading', ...(gstin ? { gstin } : { stateCode }),
}, null)).body.token;
const sub = async (t) => (await call('GET', '/billing/subscription', undefined, t)).body;
const checkout = (t, plan, months = 1) => call('POST', '/billing/checkout', { plan, months }, t);
const simulate = (t, orderId, outcome = 'success') => call('POST', '/billing/dev/simulate', { orderId, outcome }, t);
const buy = async (t, plan, months = 1) => {
  const c = await ok(checkout(t, plan, months));
  await ok(simulate(t, c.order.orderId));
  return c;
};
const invoices = async (t) => (await call('GET', '/billing/invoices', undefined, t)).body;
const cid = async (t) => (await call('GET', '/auth/me', undefined, t)).body.companyId;
const setSub = (companyId, fields) => {
  const keys = Object.keys(fields);
  return pool.query(`UPDATE subscriptions SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE company_id=$${keys.length + 1}`, [...keys.map((k) => fields[k]), companyId]);
};

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  gw = mockProvider();
  const server = createApp(pool, { gateway: gw }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  call = gwFor(base);
});

test('a new company starts a 14-day trial with every feature', async () => {
  const t = await register();
  const s = await sub(t);
  assert.deepEqual([s.status, s.planCode, s.daysLeft, s.writable, s.trialEnds], ['trialing', 'trial', 14, true, addDays(today, 14)]);
  assert.deepEqual(s.features, ['accounting', 'hr']);
  assert.deepEqual([s.gateway.provider, s.gateway.mode, s.gstPct], ['mock', 'simulated', 18]);
  assert.deepEqual(s.plans.map((p) => [p.code, p.monthly]), [['starter', 999], ['professional', 2499], ['enterprise', 4999]]);
  assert.equal((await call('POST', '/payroll/employees', { name: 'Trial user', doj: '2020-01-01', basic: 20000 }, t)).status, 201, 'HR works during the trial');
  assert.equal((await call('GET', '/billing/subscription', undefined, null)).status, 401);
});

test('quotes: GST follows the customer state; invalid requests are refused', async () => {
  const intra = await register('36'), inter = await register('29');
  const a = (await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, intra)).body;
  assert.deepEqual([a.kind, a.cgst, a.sgst, a.igst, a.total], ['new', 89.91, 89.91, 0, 1178.82]);
  const b = (await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, inter)).body;
  assert.deepEqual([b.cgst, b.sgst, b.igst, b.total], [0, 0, 179.82, 1178.82]);
  assert.deepEqual([a.periodStart, a.periodEnd], [today, periodEnd(today, 1)]);
  assert.equal((await call('POST', '/billing/quote', { plan: 'trial', months: 1 }, inter)).status, 400);
  assert.equal((await call('POST', '/billing/quote', { plan: 'starter', months: 2 }, inter)).status, 400);
  assert.equal((await call('POST', '/billing/quote', { plan: 'gold', months: 1 }, inter)).status, 400);
});

test('checkout, a failed payment, then a successful one: invoice numbered only when paid; Starter has no HR', async () => {
  const t = await register();
  const c = await ok(checkout(t, 'starter'));
  assert.equal(c.order.provider, 'mock');
  assert.equal(c.order.amount, 117882, 'in paise');
  assert.deepEqual([c.invoice.status, c.invoice.number, c.invoice.total], ['pending', null, 1178.82]);

  const fail = await ok(simulate(t, c.order.orderId, 'failure'));
  assert.equal(fail.ok, false);
  assert.equal((await sub(t)).status, 'trialing', 'a failed payment changes nothing');

  await ok(simulate(t, c.order.orderId));
  const s = await sub(t);
  assert.deepEqual([s.status, s.planCode, s.periodStart, s.periodEnd, s.cancelAtPeriodEnd], ['active', 'starter', today, periodEnd(today, 1), false]);

  const [inv] = await invoices(t);
  assert.deepEqual([inv.status, inv.paidOn], ['paid', today]);
  assert.match(inv.number, new RegExp(`^IBMP/${fyOf(today)}/\\d{5}$`));
  const detail = (await call('GET', `/billing/invoices/${inv.id}`, undefined, t)).body;
  assert.deepEqual([detail.planName, detail.seller.stateCode, detail.customerState, detail.gstPct], ['Starter', '36', '29', 18]);

  // Starter: accounting yes, HR no
  const hr = await call('GET', '/payroll/employees', undefined, t);
  assert.equal(hr.status, 402);
  assert.deepEqual([hr.body.code, hr.body.requiredPlan], ['PLAN_REQUIRED', 'professional']);
  assert.match(hr.body.error, /Professional plan and above/);
  assert.equal((await call('GET', '/leave/types', undefined, t)).status, 402);
  assert.equal((await call('GET', '/attendance?month=2026-04', undefined, t)).status, 402);
  assert.equal((await call('GET', '/invoices', undefined, t)).status, 200);
  assert.equal((await call('GET', '/gst/gstr1?period=2026-04', undefined, t)).status, 200);
});

test('invoice numbers are sequential across companies and never reused', async () => {
  const a = await register(), b = await register();
  await buy(a, 'starter'); await buy(b, 'starter');
  const na = (await invoices(a))[0].number, nb = (await invoices(b))[0].number;
  assert.equal(Number(nb.split('/').pop()), Number(na.split('/').pop()) + 1);
  const c = await ok(checkout(a, 'starter'));          // abandoned: no number is consumed
  void c;
  await buy(b, 'starter');
  const nb2 = (await invoices(b))[0].number;
  assert.equal(Number(nb2.split('/').pop()), Number(nb.split('/').pop()) + 1, 'the abandoned checkout did not burn a number');
});

test('the browser callback: bad signatures are rejected, good ones settle once', async () => {
  const t = await register(), other = await register();
  const c = await ok(checkout(t, 'professional'));
  const order = c.order.orderId;

  const bad = await call('POST', '/billing/verify', { orderId: order, paymentId: 'pay_1', signature: 'deadbeef' }, t);
  assert.equal(bad.status, 400);
  assert.equal((await sub(t)).status, 'trialing');
  assert.equal((await call('POST', '/billing/verify', { orderId: order, paymentId: 'pay_1', signature: gw.sign({ orderId: order, paymentId: 'pay_1' }) }, other)).status, 404, "another company's order");
  assert.equal((await call('POST', '/billing/verify', { orderId: 'order_nope', paymentId: 'p', signature: 's' }, t)).status, 404);

  const sig = gw.sign({ orderId: order, paymentId: 'pay_1' });
  const first = await ok(call('POST', '/billing/verify', { orderId: order, paymentId: 'pay_1', signature: sig }, t));
  assert.deepEqual([first.alreadySettled, first.subscription.planCode, first.subscription.status], [false, 'professional', 'active']);
  const end = first.subscription.periodEnd;
  const again = await ok(call('POST', '/billing/verify', { orderId: order, paymentId: 'pay_1', signature: sig }, t));
  assert.deepEqual([again.alreadySettled, again.subscription.periodEnd], [true, end], 'replaying the callback extends nothing');
  assert.equal((await invoices(t)).filter((i) => i.status === 'paid').length, 1);

  // a signature for a different payment id does not verify
  const c2 = await ok(checkout(t, 'professional'));
  assert.equal((await call('POST', '/billing/verify', { orderId: c2.order.orderId, paymentId: 'pay_2', signature: gw.sign({ orderId: c2.order.orderId, paymentId: 'pay_X' }) }, t)).status, 400);
});

test('webhook: signed events settle idempotently; bad signature, wrong amount, unknown order and failures are handled', async () => {
  const t = await register();
  const c = await ok(checkout(t, 'starter'));
  const order = c.order.orderId;
  const hook = (event, extra = {}, secret = gw.webhookSecret) => {
    const raw = JSON.stringify({ event, orderId: order, paymentId: 'pay_w1', amountPaise: 117882, ...extra });
    return call('POST', '/webhooks/payments', raw, null, { 'x-mock-signature': hmac(secret, raw) });
  };

  assert.equal((await hook('payment.captured', {}, 'wrong-secret')).status, 400, 'bad signature');
  assert.equal((await call('POST', '/webhooks/payments', '{"event":"payment.captured"}', null)).status, 400, 'no signature');
  assert.equal((await hook('payment.captured', { amountPaise: 100 })).status, 400, 'amount does not match the invoice');
  assert.equal((await sub(t)).status, 'trialing', 'nothing settled by the rejected calls');

  assert.equal((await hook('payment.failed')).status, 200);
  assert.equal((await sub(t)).status, 'trialing');
  assert.equal((await hook('refund.created')).body.ignored, true, 'events we do not handle are acknowledged and ignored');
  assert.equal((await hook('payment.captured', { orderId: 'order_unknown' })).body.ignored, true);

  assert.equal((await hook('payment.captured')).status, 200);
  const s = await sub(t);
  assert.deepEqual([s.status, s.planCode], ['active', 'starter']);
  const [inv] = await invoices(t);
  assert.equal(inv.paymentId, 'pay_w1');
  assert.equal((await hook('payment.captured')).status, 200, 'a retried webhook is accepted');
  assert.deepEqual([(await sub(t)).periodEnd, (await invoices(t))[0].number], [s.periodEnd, inv.number], 'and changes nothing');

  const events = (await pool.query('SELECT outcome FROM billing_events ORDER BY id')).rows.map((x) => x.outcome);
  for (const o of ['rejected', 'failed', 'ignored', 'paid']) assert.ok(events.includes(o), `logged a ${o} event`);
});

test('renewal queues after the current period; a double payment is queued, not lost', async () => {
  const t = await register();
  await buy(t, 'starter');
  const first = await sub(t);

  const q = (await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, t)).body;
  assert.deepEqual([q.kind, q.periodStart, q.credit], ['renewal', addDays(first.periodEnd, 1), 0]);
  await buy(t, 'starter');
  const s = await sub(t);
  assert.deepEqual([s.periodStart, s.periodEnd], [first.periodStart, periodEnd(addDays(first.periodEnd, 1), 1)]);

  // two checkouts open at once: the first becomes void, but paying it is still honoured and the second queues after it
  const c1 = await ok(checkout(t, 'starter')), c2 = await ok(checkout(t, 'starter'));
  assert.equal((await invoices(t)).find((i) => i.orderId === c1.order.orderId).status, 'void');
  await ok(simulate(t, c1.order.orderId));
  const mid = await sub(t);
  await ok(simulate(t, c2.order.orderId));
  const end = await sub(t);
  assert.equal(end.periodEnd, periodEnd(addDays(mid.periodEnd, 1), 1), 'the second payment starts the day after the first ends');
  const [i2, i1] = (await invoices(t)).filter((i) => i.status === 'paid').slice(0, 2);
  assert.equal(i2.periodStart, addDays(i1.periodEnd, 1));
});

test('upgrade credits the unused part of the old plan once; downgrade is refused until the period ends', async () => {
  const t = await register();
  await buy(t, 'starter', 12);                                   // a year of Starter
  // Almost the whole year is unused (11,988 x 364/365 = 11,955.16), which exceeds one Professional month: pick a longer period
  const short = await call('POST', '/billing/quote', { plan: 'professional', months: 1 }, t);
  assert.deepEqual([short.status, short.body.code], [409, 'CREDIT_EXCEEDS_PRICE']);
  assert.equal((await checkout(t, 'professional', 1)).status, 409);
  const q = (await call('POST', '/billing/quote', { plan: 'professional', months: 12 }, t)).body;
  assert.deepEqual([q.kind, q.credit], ['upgrade', 11955.16]);

  await buy(t, 'professional', 12);
  const inv = await invoices(t);
  const up = inv.find((i) => i.planCode === 'professional' && i.status === 'paid');
  assert.equal(up.kind, 'upgrade');
  assert.ok(up.credit > 0 && up.credit < up.base, 'credit is part of the base price');
  assert.equal(Math.round((up.base - up.credit) * 100), Math.round(up.taxable * 100));
  assert.equal(Math.round((up.taxable + up.cgst + up.sgst + up.igst) * 100), Math.round(up.total * 100));
  assert.equal(inv.find((i) => i.planCode === 'starter').supersededBy, up.id, 'the old invoice is marked as absorbed');
  assert.equal(up.credit, 11955.16);

  const s = await sub(t);
  assert.deepEqual([s.planCode, s.periodStart], ['professional', today]);
  assert.equal((await call('GET', '/payroll/employees', undefined, t)).status, 200, 'HR unlocks on Professional');

  const down = await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, t);
  assert.equal(down.status, 409);
  assert.equal(down.body.code, 'DOWNGRADE_LATER');
  assert.equal((await checkout(t, 'starter')).status, 409);

  // upgrading again (to Enterprise) credits only the Professional time, not the Starter time counted before
  const q2 = (await call('POST', '/billing/quote', { plan: 'enterprise', months: 12 }, t)).body;
  assert.equal(q2.kind, 'upgrade');
  // Only the Professional year counts: bought today, 364 of its 365 days are unused. The Starter year was already absorbed.
  assert.equal(q2.credit, Math.round(up.taxable * 100 * 364 / 365) / 100);
  assert.deepEqual(q2.creditedIds, [up.id]);
});

test('expiry: grace keeps access; expired is read-only but billing still works; paying restores access', async () => {
  const t = await register();
  await buy(t, 'professional');
  const id = await cid(t);

  await setSub(id, { period_start: addDays(today, -32), period_end: addDays(today, -2) });
  let s = await sub(t);
  assert.deepEqual([s.status, s.writable, s.daysLeft], ['grace', true, -2]);
  assert.equal((await call('POST', '/payroll/employees', { name: 'Still fine', doj: '2020-01-01', basic: 20000 }, t)).status, 201);

  await setSub(id, { period_end: addDays(today, -10) });
  s = await sub(t);
  assert.deepEqual([s.status, s.writable], ['expired', false]);
  assert.equal((await call('GET', '/payroll/employees', undefined, t)).status, 200, 'reads still work so data can be exported');
  assert.equal((await call('GET', '/invoices', undefined, t)).status, 200);
  const blocked = await call('POST', '/parties', { type: 'customer', name: 'Blocked', stateCode: '29' }, t);
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.code, 'SUBSCRIPTION_EXPIRED');
  assert.equal((await call('POST', '/payroll/employees', { name: 'No', doj: '2020-01-01', basic: 20000 }, t)).status, 402);
  assert.equal((await call('GET', '/billing/invoices', undefined, t)).status, 200, 'billing stays reachable');

  const q = (await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, t)).body;
  assert.deepEqual([q.kind, q.periodStart], ['new', today], 'after expiry any plan can be bought, starting today');
  await buy(t, 'starter');
  s = await sub(t);
  assert.deepEqual([s.status, s.planCode, s.writable], ['active', 'starter', true]);
  assert.equal((await call('POST', '/parties', { type: 'customer', name: 'Allowed', stateCode: '29' }, t)).status, 201);
});

test('an expired trial is read-only; cancel and resume only apply to a paid plan', async () => {
  const t = await register();
  assert.equal((await call('POST', '/billing/cancel', {}, t)).status, 409);
  await setSub(await cid(t), { trial_ends: addDays(today, -1) });
  const s = await sub(t);
  assert.deepEqual([s.status, s.writable], ['expired', false]);
  assert.equal((await call('POST', '/items', { name: 'X', rate: 1, gstPct: 18 }, t)).status, 402);
  await buy(t, 'starter');
  assert.equal((await call('POST', '/billing/cancel', {}, t)).body.cancelAtPeriodEnd, true);
  assert.equal((await sub(t)).status, 'active', 'cancelling keeps access until the period ends');
  assert.equal((await call('POST', '/billing/resume', {}, t)).body.cancelAtPeriodEnd, false);
  await buy(t, 'starter');                                        // renewing clears a pending cancellation
  assert.equal((await sub(t)).cancelAtPeriodEnd, false);
});

test('isolation and no-gateway behaviour', async () => {
  const a = await register(), b = await register();
  await buy(a, 'starter');
  const [inv] = await invoices(a);
  assert.equal((await call('GET', `/billing/invoices/${inv.id}`, undefined, b)).status, 404);
  assert.equal((await invoices(b)).length, 0);

  const { Pool } = newDb().adapters.createPg();
  const p2 = new Pool();
  await migrate(p2);
  const server = createApp(p2, { gateway: null }).listen(0);
  server.unref();
  const call2 = gwFor(`http://127.0.0.1:${server.address().port}/v1`);
  const tok = (await call2('POST', '/auth/register', { name: 'N', email: 'n@example.com', password: 'password123', company: 'No GW', sector: 'retail', stateCode: '29' }, null)).body.token;
  const s = (await call2('GET', '/billing/subscription', undefined, tok)).body;
  assert.equal(s.gateway, null);
  const co = await call2('POST', '/billing/checkout', { plan: 'starter', months: 1 }, tok);
  assert.deepEqual([co.status, co.body.code], [503, 'NO_GATEWAY']);
  assert.equal((await call2('POST', '/billing/dev/simulate', { orderId: 'x', outcome: 'success' }, tok)).status, 404);
  const raw = JSON.stringify({ event: 'payment.captured' });
  assert.equal((await call2('POST', '/webhooks/payments', raw, null, { 'x-mock-signature': hmac('mock_webhook_secret', raw) })).status, 400, 'webhooks are refused without a gateway');
});

test('Razorpay end to end with a stubbed HTTP layer: order created with the right amount, checkout signature settles it, no simulator', async () => {
  const seen = [];
  const keySecret = 'rzp_secret';
  const rzp = razorpayProvider({
    keyId: 'rzp_test_demo', keySecret, webhookSecret: 'rzp_hook',
    fetchImpl: async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ id: `order_rzp_${seen.length}` }) }; },
  });
  const { Pool } = newDb().adapters.createPg();
  const p3 = new Pool();
  await migrate(p3);
  const server = createApp(p3, { gateway: rzp }).listen(0);
  server.unref();
  const c3 = gwFor(`http://127.0.0.1:${server.address().port}/v1`);
  const tok = (await c3('POST', '/auth/register', { name: 'R', email: 'r@example.com', password: 'password123', company: 'Rzp Co', sector: 'retail', stateCode: '36' }, null)).body.token;

  const s = (await c3('GET', '/billing/subscription', undefined, tok)).body;
  assert.deepEqual([s.gateway.provider, s.gateway.mode, s.gateway.keyId], ['razorpay', 'test', 'rzp_test_demo']);
  const co = await ok(c3('POST', '/billing/checkout', { plan: 'enterprise', months: 3 }, tok));
  // 4,999 x 3 = 14,997 + 18% (2,699.46) = 17,696.46
  assert.equal(co.order.amount, 1769646);
  assert.equal(seen[0].url, 'https://api.razorpay.com/v1/orders');
  assert.deepEqual([seen[0].body.amount, seen[0].body.currency, seen[0].body.notes.plan], [1769646, 'INR', 'enterprise']);
  assert.equal(co.invoice.cgst, 1349.73);
  assert.equal((await c3('POST', '/billing/dev/simulate', { orderId: co.order.orderId, outcome: 'success' }, tok)).status, 404, 'the simulator is not available with a real gateway');

  const orderId = co.order.orderId;
  assert.equal((await c3('POST', '/billing/verify', { orderId, paymentId: 'pay_real', signature: hmac('someone-elses-secret', `${orderId}|pay_real`) }, tok)).status, 400);
  const good = await ok(c3('POST', '/billing/verify', { orderId, paymentId: 'pay_real', signature: hmac(keySecret, `${orderId}|pay_real`) }, tok));
  assert.deepEqual([good.subscription.planCode, good.subscription.status], ['enterprise', 'active']);

  // And the signed Razorpay-shaped webhook for the same payment is a harmless repeat
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_real', orderId: orderId, amount: 1769646 } } } });
  const hook = await c3('POST', '/webhooks/payments', raw, null, { 'x-razorpay-signature': hmac('rzp_hook', raw) });
  assert.equal(hook.status, 200);
  assert.equal((await c3('GET', '/billing/invoices', undefined, tok)).body.filter((i) => i.status === 'paid').length, 1);
});
