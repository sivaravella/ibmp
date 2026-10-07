import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { monthsBack } from '../src/routes/analytics.js';

test('months window: ends with the month of the date, oldest first, across a year boundary', () => {
  assert.deepEqual(monthsBack('2026-10-20', 3), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(monthsBack('2026-02-01', 4), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(monthsBack('2026-10-31', 12).length, 12);
  assert.equal(monthsBack('2026-10-31', 12)[0], '2025-11');
});

let call;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels: simulatedChannels() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
let seq = 0;
const register = async () => (await call('POST', '/auth/register', { name: 'T', email: `an${++seq}@example.com`, password: 'password123', company: `An Co ${seq}`, sector: 'trading', stateCode: '29' }, null)).body.token;

test('analytics: trends, KPIs, ageing, top lists, GST, cash and expenses on a hand-worked set of documents', async () => {
  const t = await register();
  const widget = await ok(call('POST', '/items', { name: 'Widget', hsn: '8471', rate: 1000, gstPct: 18, stock: 1000 }, t));
  const A = await ok(call('POST', '/parties', { type: 'customer', name: 'Alpha Retail', stateCode: '29' }, t));
  const B = await ok(call('POST', '/parties', { type: 'customer', name: 'Beta Stores', stateCode: '29' }, t));
  const V = await ok(call('POST', '/parties', { type: 'vendor', name: 'Supplier One', stateCode: '29' }, t));
  const sale = (party, date, qty) => ok(call('POST', '/invoices', { partyId: party.id, date, lines: [{ itemId: widget.id, qty }] }, t));
  const i1 = await sale(A, '2026-08-10', 10);     // 10,000 + 1,800 GST = 11,800
  const i2 = await sale(B, '2026-09-15', 5);      //  5,000 +   900     =  5,900
  const i3 = await sale(A, '2026-10-05', 20);     // 20,000 + 3,600     = 23,600
  await ok(call('POST', `/invoices/${i3.id}/payments`, { amount: 10000, mode: 'bank', date: '2026-10-10' }, t));
  const lines = (await ok(call('GET', `/invoices/${i3.id}/returnable`, undefined, t))).lines;
  await ok(call('POST', `/invoices/${i3.id}/returns`, { date: '2026-10-12', lines: [{ lineId: lines[0].id, qty: 2 }] }, t));   // credit note 2,000 + 360
  const bill = await ok(call('POST', '/purchases', { partyId: V.id, supplierBillNo: 'S-1', date: '2026-10-08', lines: [{ itemId: widget.id, qty: 10, rate: 600 }] }, t));   // 6,000 + 1,080
  await ok(call('POST', `/purchases/${bill.id}/payments`, { amount: 2000, mode: 'bank', date: '2026-10-15' }, t));
  void i1; void i2;

  const a = await ok(call('GET', '/analytics?asOf=2026-10-20&months=6', undefined, t));
  assert.deepEqual(a.months, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(a.trend.map((x) => x.sales), [0, 0, 0, 10000, 5000, 20000]);
  assert.deepEqual(a.trend.map((x) => x.purchases), [0, 0, 0, 0, 0, 6000]);
  assert.deepEqual(a.trend.map((x) => x.received), [0, 0, 0, 0, 0, 10000]);
  assert.equal(a.trend[5].returns, 2000);
  assert.deepEqual(a.trend.slice(3).map((x) => [x.outputGst, x.inputGst, x.netGst]), [[1800, 0, 1800], [900, 0, 900], [3240, 1080, 2160]], 'credit note reduces output tax');

  const sales = a.kpis.find((k) => k.key === 'sales');
  assert.deepEqual([sales.value, sales.previous, sales.changePct, sales.spark.length], [20000, 5000, 300, 6]);
  assert.equal(a.kpis.find((k) => k.key === 'purchases').changePct, null, 'no change figure against a zero month');
  assert.equal(a.kpis.find((k) => k.key === 'netGst').value, 2160);
  assert.deepEqual([a.totals.sales, a.totals.purchases, a.totals.received, a.totals.paidOut, a.totals.invoices, a.totals.bills], [35000, 6000, 10000, 2000, 3, 1]);

  // as of 20 Oct: i1 is 71 days old (11,800), i2 35 days (5,900), i3 15 days (23,600 less 10,000 paid and 2,360 credited = 11,240)
  assert.equal(a.receivables.total, 28940);
  assert.deepEqual(a.receivables.buckets.map((b) => [b.label, b.amount, b.count]), [['0-30', 11240, 1], ['31-60', 5900, 1], ['61-90', 11800, 1], ['90+', 0, 0]]);
  assert.equal(a.payables.total, 5080, '7,080 less 2,000 paid');
  assert.deepEqual(a.payables.buckets.map((b) => b.amount), [5080, 0, 0, 0]);

  assert.deepEqual(a.topCustomers.map((c) => [c.name, c.amount]), [['Alpha Retail', 30000], ['Beta Stores', 5000]]);
  assert.deepEqual(a.topItems, [{ name: 'Widget', amount: 35000 }]);
  assert.deepEqual([a.invoiceStatus.paid.count, a.invoiceStatus.partial.count, a.invoiceStatus.unpaid.count], [0, 1, 2]);
  assert.deepEqual(a.cash, { cash: 0, bank: 8000 }, '10,000 received less 2,000 paid');
  assert.equal(a.expenses.top[0].name, 'Purchases');
  assert.equal(a.expenses.top[0].amount, 6000);

  // the month in progress is compared with the same days of the month before, not with its full total
  assert.deepEqual([sales.comparedWith, sales.previousFullMonth], ['2026-09 up to day 20', 5000]);
  const early = (await ok(call('GET', '/analytics?asOf=2026-10-10&months=6', undefined, t))).kpis.find((k) => k.key === 'sales');
  assert.deepEqual([early.value, early.previous, early.previousFullMonth, early.changePct], [20000, 0, 5000, null], 'nothing was sold in September by the 10th: no change figure, not -100%');

  // collection: paid so far against billed (11,800 + 5,900 + 23,600 less 2,360 credited = 38,940)
  assert.deepEqual([a.collection.billed, a.collection.collected, a.collection.ratePct], [38940, 10000, 25.68]);

  // the window, bounds and a clean company
  assert.equal((await ok(call('GET', '/analytics?asOf=2026-10-20&months=3', undefined, t))).trend.length, 3);
  assert.equal((await ok(call('GET', '/analytics?asOf=2026-10-20&months=99', undefined, t))).trend.length, 24, 'capped at 24');
  assert.equal((await ok(call('GET', '/analytics?asOf=2026-09-30&months=3', undefined, t))).totals.sales, 15000, 'as of an earlier date');
  assert.equal((await call('GET', '/analytics?asOf=nope', undefined, t)).status, 400);
  const empty = await ok(call('GET', '/analytics?asOf=2026-10-20', undefined, await register()));
  assert.deepEqual([empty.totals.sales, empty.receivables.total, empty.cash.bank, empty.topCustomers.length, empty.kpis[0].changePct, empty.collection.ratePct], [0, 0, 0, 0, null, null]);
  assert.equal((await call('GET', '/analytics')).status, 401);
});

test('analytics is private to the company', async () => {
  const t = await register();
  const other = await register();
  const item = await ok(call('POST', '/items', { name: 'Thing', rate: 100, gstPct: 18, stock: 10 }, t));
  const p = await ok(call('POST', '/parties', { type: 'customer', name: 'Mine', stateCode: '29' }, t));
  await ok(call('POST', '/invoices', { partyId: p.id, date: '2026-10-05', lines: [{ itemId: item.id, qty: 1 }] }, t));
  assert.equal((await ok(call('GET', '/analytics?asOf=2026-10-20', undefined, t))).totals.sales, 100);
  const o = await ok(call('GET', '/analytics?asOf=2026-10-20', undefined, other));
  assert.deepEqual([o.totals.sales, o.topCustomers.length, o.receivables.total], [0, 0, 0]);
});
