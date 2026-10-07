import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysBetween, periodEnd, quote, subscriptionStatus, unusedCredit } from '../src/billing.js';
import { hmac, mockProvider, razorpayProvider, resolveGateway, safeEqual } from '../src/gateway.js';
import { featureForPath } from '../src/plans.js';

const trial = (o = {}) => ({ plan_code: 'trial', trial_ends: '2026-10-20', period_start: null, period_end: null, ...o });
const paid = (plan, end, o = {}) => ({ plan_code: plan, trial_ends: '2026-09-01', period_start: '2026-10-01', period_end: end, ...o });
const inv = (id, taxable, period_start, period_end) => ({ id, taxable, period_start, period_end });

test('date helpers: month arithmetic clamps, a period covers exactly n months', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29', 'leap year');
  assert.equal(addMonths('2026-12-15', 2), '2027-02-15');
  assert.equal(addMonths('2026-10-06', 12), '2027-10-06');
  assert.equal(periodEnd('2026-10-06', 1), '2026-11-05');
  assert.equal(periodEnd('2026-10-01', 1), '2026-10-31');
  assert.equal(periodEnd('2026-10-06', 12), '2027-10-05');
  assert.equal(periodEnd('2026-01-31', 1), '2026-02-27');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-10-11', '2026-10-31'), 20);
});

test('status: trial, active, grace (3 days), expired', () => {
  const s = (sub, today) => { const x = subscriptionStatus(sub, today); return [x.status, x.daysLeft, x.writable]; };
  assert.deepEqual(s(trial(), '2026-10-06'), ['trialing', 14, true]);
  assert.deepEqual(s(trial(), '2026-10-20'), ['trialing', 0, true], 'the last trial day still counts');
  assert.deepEqual(s(trial(), '2026-10-21'), ['expired', null, false]);
  assert.deepEqual(s(paid('starter', '2026-10-31'), '2026-10-31'), ['active', 0, true]);
  assert.deepEqual(s(paid('starter', '2026-10-31'), '2026-11-02'), ['grace', -2, true]);
  assert.deepEqual(s(paid('starter', '2026-10-31'), '2026-11-03'), ['grace', -3, true]);
  assert.deepEqual(s(paid('starter', '2026-10-31'), '2026-11-04'), ['expired', null, false]);
});

test('quote: a new Starter month, GST split by place of supply', () => {
  const q = quote({ plan: 'starter', months: 1, sub: trial(), today: '2026-10-06', providerState: '36', customerState: '36' });
  // 999.00 + 18% = 179.82 -> CGST 89.91 + SGST 89.91 -> 1,178.82
  assert.deepEqual([q.kind, q.period_start, q.period_end, q.base, q.credit, q.taxable], ['new', '2026-10-06', '2026-11-05', 99900, 0, 99900]);
  assert.deepEqual([q.cgst, q.sgst, q.igst, q.total], [8991, 8991, 0, 117882]);
  const inter = quote({ plan: 'starter', months: 1, sub: trial(), today: '2026-10-06', providerState: '36', customerState: '29' });
  assert.deepEqual([inter.cgst, inter.sgst, inter.igst, inter.total], [0, 0, 17982, 117882]);

  // Professional for a year: 2,499 x 12 = 29,988 + 5,397.84 GST = 35,385.84
  const y = quote({ plan: 'professional', months: 12, sub: trial(), today: '2026-10-06', providerState: '36', customerState: '29' });
  assert.deepEqual([y.base, y.igst, y.total, y.period_end], [2998800, 539784, 3538584, '2027-10-05']);
  const odd = quote({ plan: 'professional', months: 1, sub: trial(), today: '2026-10-06', providerState: '36', customerState: '36' });
  assert.deepEqual([odd.cgst + odd.sgst, odd.total], [44982, 294882], 'an odd paise of tax goes to SGST: 449.82 -> 224.91 + 224.91');
});

test('quote: renewal starts after the current period; upgrade credits unused time; downgrade waits', () => {
  const sub = paid('starter', '2026-10-31');
  const renew = quote({ plan: 'starter', months: 1, sub, creditable: [inv(1, 999, '2026-10-01', '2026-10-31')], today: '2026-10-11', providerState: '36', customerState: '36' });
  assert.deepEqual([renew.kind, renew.period_start, renew.period_end, renew.credit], ['renewal', '2026-11-01', '2026-11-30', 0]);

  // 20 of 31 days unused: round(99,900 x 20 / 31) = 64,452 paise credit
  const up = quote({ plan: 'professional', months: 1, sub, creditable: [inv(1, 999, '2026-10-01', '2026-10-31')], today: '2026-10-11', providerState: '36', customerState: '36' });
  assert.deepEqual([up.kind, up.period_start, up.period_end, up.base, up.credit, up.taxable], ['upgrade', '2026-10-11', '2026-11-10', 249900, 64452, 185448]);
  // 185,448 x 18% = 33,380.64 -> 33,381
  assert.deepEqual([up.cgst + up.sgst, up.total, up.credited_ids], [33381, 218829, [1]]);

  assert.throws(() => quote({ plan: 'starter', months: 1, sub: paid('professional', '2026-10-31'), today: '2026-10-11', providerState: '36', customerState: '36' }),
    (e) => e.status === 409 && e.code === 'DOWNGRADE_LATER' && /Professional until 2026-10-31/.test(e.message));
  // The same downgrade is fine once the period is over (grace or expired): it is just a new purchase.
  assert.equal(quote({ plan: 'starter', months: 1, sub: paid('professional', '2026-10-31'), today: '2026-11-02', providerState: '36', customerState: '36' }).kind, 'new');
  assert.equal(quote({ plan: 'professional', months: 1, sub: paid('professional', '2026-10-31'), today: '2026-12-01', providerState: '36', customerState: '36' }).period_start, '2026-12-01');
});

test('unused credit: partial current period plus a prepaid future renewal; credit larger than the price is refused', () => {
  assert.equal(unusedCredit([inv(1, 999, '2026-10-01', '2026-10-31')], '2026-10-11'), 64452);
  assert.equal(unusedCredit([inv(1, 999, '2026-10-01', '2026-10-31')], '2026-10-31'), 0, 'nothing is left on the last day');
  assert.equal(unusedCredit([inv(1, 999, '2026-10-01', '2026-10-31')], '2026-11-15'), 0);
  // plus a renewal covering 1-30 Nov that has not started: all 30 days are unused
  assert.equal(unusedCredit([inv(1, 999, '2026-10-01', '2026-10-31'), inv(2, 999, '2026-11-01', '2026-11-30')], '2026-10-11'), 64452 + 99900);

  const sub = paid('starter', '2027-09-30');
  const big = [inv(1, 11988, '2026-10-01', '2027-09-30')];
  assert.throws(() => quote({ plan: 'enterprise', months: 1, sub, creditable: big, today: '2026-10-02', providerState: '36', customerState: '36' }),
    (e) => e.status === 409 && e.code === 'CREDIT_EXCEEDS_PRICE');
  assert.equal(quote({ plan: 'enterprise', months: 12, sub, creditable: big, today: '2026-10-02', providerState: '36', customerState: '36' }).kind, 'upgrade');
});

test('quote validation', () => {
  const args = { sub: trial(), today: '2026-10-06', providerState: '36', customerState: '36' };
  assert.throws(() => quote({ plan: 'trial', months: 1, ...args }), (e) => e.status === 400);
  assert.throws(() => quote({ plan: 'gold', months: 1, ...args }), (e) => e.status === 400);
  assert.throws(() => quote({ plan: 'starter', months: 2, ...args }), (e) => e.status === 400);
  assert.throws(() => quote({ plan: 'starter', months: 0, ...args }), (e) => e.status === 400);
  for (const m of [1, 3, 6, 12]) assert.equal(quote({ plan: 'starter', months: m, ...args }).base, 99900 * m);
});

test('feature gating by path', () => {
  assert.deepEqual(['/payroll/runs', '/attendance', '/leave/types', '/payroll', '/statutory/pf', '/statutory/runs/3/refs'].map(featureForPath), ['hr', 'hr', 'hr', 'hr', 'hr', 'hr']);
  assert.deepEqual(['/invoices', '/ledger', '/gst/gstr1', '/compliance', '/payrollish', '/leaves'].map(featureForPath), ['accounting', 'accounting', 'accounting', 'accounting', 'accounting', 'accounting']);
});

test('HMAC: matches the standard test vector; comparison is constant-time and length-safe', () => {
  assert.equal(hmac('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.deepEqual([safeEqual('abc', 'abd'), safeEqual('abc', 'abcd'), safeEqual('abc', undefined), safeEqual(undefined, undefined)], [false, false, false, true]);
});

test('Razorpay adapter: order request, error handling, checkout signature, webhook signature and parsing', async () => {
  const calls = [];
  const fakeFetch = (reply) => async (url, opts) => { calls.push({ url, opts }); if (reply instanceof Error) throw reply; return { ok: reply.ok, json: async () => reply.body }; };
  const mk = (reply) => razorpayProvider({ keyId: 'rzp_test_abc', keySecret: 'shh', webhookSecret: 'hook', fetchImpl: fakeFetch(reply) });

  const p = mk({ ok: true, body: { id: 'order_123' } });
  assert.deepEqual([p.name, p.mode, p.keyId], ['razorpay', 'test', 'rzp_test_abc']);
  assert.equal((await p.createOrder({ amountPaise: 117882, receipt: 'inv_1', notes: { plan: 'starter' } })).orderId, 'order_123');
  const c = calls[0];
  assert.equal(c.url, 'https://api.razorpay.com/v1/orders');
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers.authorization, `Basic ${Buffer.from('rzp_test_abc:shh').toString('base64')}`);
  assert.deepEqual(JSON.parse(c.opts.body), { amount: 117882, currency: 'INR', receipt: 'inv_1', notes: { plan: 'starter' } });
  assert.equal(razorpayProvider({ keyId: 'rzp_live_x', keySecret: 's' }).mode, 'live');

  await assert.rejects(mk({ ok: false, body: { error: { description: 'Authentication failed' } } }).createOrder({ amountPaise: 1 }), (e) => e.status === 502 && /Authentication failed/.test(e.message));
  await assert.rejects(mk(new Error('ECONNRESET')).createOrder({ amountPaise: 1 }), (e) => e.status === 502 && /Could not reach/.test(e.message));
  await assert.rejects(mk({ ok: true, body: {} }).createOrder({ amountPaise: 1 }), (e) => e.status === 502);

  const sig = hmac('shh', 'order_123|pay_456');
  assert.equal(p.verifyPayment({ orderId: 'order_123', paymentId: 'pay_456', signature: sig }), true);
  assert.equal(p.verifyPayment({ orderId: 'order_123', paymentId: 'pay_999', signature: sig }), false, 'a different payment id');
  assert.equal(p.verifyPayment({ orderId: 'order_124', paymentId: 'pay_456', signature: sig }), false, 'a different order');

  const raw = Buffer.from('{"event":"payment.captured"}');
  assert.equal(p.verifyWebhook(raw, { 'x-razorpay-signature': hmac('hook', raw) }), true);
  assert.equal(p.verifyWebhook(raw, { 'x-razorpay-signature': hmac('wrong', raw) }), false);
  assert.equal(p.verifyWebhook(raw, {}), false);
  assert.equal(razorpayProvider({ keyId: 'rzp_test_a', keySecret: 's' }).verifyWebhook(raw, { 'x-razorpay-signature': hmac('', raw) }), false, 'no webhook secret configured: never trust');

  const ev = (event) => ({ event, payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 5000 } } } });
  assert.deepEqual(p.parseWebhook(ev('payment.captured')), { orderId: 'order_1', paymentId: 'pay_1', amountPaise: 5000, paid: true });
  assert.equal(p.parseWebhook(ev('order.paid')).paid, true);
  assert.equal(p.parseWebhook(ev('payment.failed')).paid, false);
  assert.equal(p.parseWebhook(ev('refund.created')), null);
  assert.equal(p.parseWebhook({ event: 'payment.captured', payload: {} }), null);
});

test('gateway resolution: Razorpay when keyed, simulator outside production, nothing in production', () => {
  assert.equal(resolveGateway({ RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's' }).name, 'razorpay');
  assert.equal(resolveGateway({}).name, 'mock');
  assert.equal(resolveGateway({ NODE_ENV: 'production' }), null);
  assert.equal(resolveGateway({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_a', RAZORPAY_KEY_SECRET: 's' }).mode, 'live');
  const m = mockProvider();
  const o = 'order_x', pay = 'pay_x';
  assert.equal(m.verifyPayment({ orderId: o, paymentId: pay, signature: m.sign({ orderId: o, paymentId: pay }) }), true);
});
