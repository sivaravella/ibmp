import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';
import { today } from '../src/util.js';
import { readTable } from '../src/sheets.js';
import { addYears, previousPeriod, previousYearEnd } from '../src/reports.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
let call, raw, seq = 0;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels: simulatedChannels() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  raw = (path, tok) => fetch(url + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (name) => (await call('POST', '/auth/register', { name: 'T', email: `rep${++seq}@example.com`, password: 'password123', company: name, sector: 'trading', gstin: gstin('29REPRT5555Q1Z') })).body.token;

// One company with a hand-countable year. Dates are fixed so the numbers never depend on today.
//  FY 2025-26: sale 2,000 (customer B)                                                    -> profit 2,000
//  FY 2026-27: sales 10,000 + 5,000 + 1,000 (the 1,000 is returned in full), purchases 4,000 + 1,000, rent 2,000
//              revenue 16,000 - 1,000 = 15,000; expenses 5,000 + 2,000 = 7,000; profit 8,000
let world;
async function setup() {
  if (world) return world;
  const t = await register('Reports Co');
  const a = await ok(call('POST', '/parties', { type: 'customer', name: 'Alpha Traders', gstin: gstin('29AAAAA1111A1Z') }, t));
  const b = await ok(call('POST', '/parties', { type: 'customer', name: 'Beta Stores', gstin: gstin('29BBBBB2222B1Z') }, t));
  const v = await ok(call('POST', '/parties', { type: 'vendor', name: 'Supplier One', stateCode: '29' }, t));
  await ok(call('POST', '/items', { name: 'Widget', hsn: '8471', rate: 1000, gstPct: 18, stock: 100, unit: 'Nos' }, t));
  const item = (await ok(call('GET', '/items', undefined, t))).find((i) => i.name === 'Widget');
  const inv = (party, date, qty) => ok(call('POST', '/invoices', { partyId: party.id, date, lines: [{ itemId: item.id, qty }] }, t));
  const bill = (date, rate) => ok(call('POST', '/purchases', { partyId: v.id, supplierBillNo: `S-${++seq}`, date, lines: [{ itemId: item.id, qty: 1, rate, gstPct: 18 }] }, t));
  const accounts = await ok(call('GET', '/accounts', undefined, t));
  const acct = (code) => accounts.find((x) => x.code === code).id;

  await ok(call('POST', '/journal', { date: '2026-04-01', narration: 'Capital introduced', lines: [{ accountId: acct('1010'), debit: 50000 }, { accountId: acct('3000'), credit: 50000 }] }, t));
  await inv(b, '2025-09-01', 2);                                   // 2,000 + 360 tax = 2,360
  const i1 = await inv(a, '2026-05-10', 10);                       // 10,000 + 1,800 = 11,800
  await inv(a, '2026-08-20', 5);                                   // 5,000 + 900 = 5,900
  const i3 = await inv(a, '2026-09-01', 1);                        // 1,000 + 180 = 1,180
  const b1 = await bill('2026-06-01', 4000);                       // 4,000 + 720 = 4,720
  await bill('2026-09-20', 1000);                                  // 1,000 + 180 = 1,180, unpaid
  await ok(call('POST', `/invoices/${i1.id}/payments`, { amount: 5000, mode: 'bank', date: '2026-06-15' }, t));
  await ok(call('POST', `/purchases/${b1.id}/payments`, { amount: 4720, mode: 'cash', date: '2026-07-01' }, t));
  await ok(call('POST', `/invoices/${i3.id}/returns`, { date: '2026-09-05', full: true }, t));
  await ok(call('POST', '/journal', { date: '2026-07-05', narration: 'Office rent', lines: [{ accountId: acct('5410'), debit: 2000 }, { accountId: acct('1000'), credit: 2000 }] }, t));
  world = { t };
  return world;
}

const find = (rows, key) => rows.find((r) => r.key === key);
const pl = (t, q) => ok(call('GET', `/reports/profit-loss${q}`, undefined, t));

test('profit and loss for the financial year matches the hand calculation and shows the previous year', async () => {
  const { t } = await setup();
  const r = await pl(t, '?from=2026-04-01&to=2027-03-31');
  assert.equal(r.totals.revenueFromOperations.amount, 15000);       // 16,000 sales less 1,000 returned
  assert.equal(r.totals.otherIncome.amount, 0);
  assert.equal(r.totals.costOfGoods.amount, 5000);
  assert.equal(r.totals.otherExpenses.amount, 2000);                // rent
  assert.equal(r.totals.employeeCosts.amount, 0);
  assert.equal(r.totals.totalExpenses.amount, 7000);
  assert.equal(r.totals.profitBeforeTax.amount, 8000);
  assert.deepEqual([r.previous.from, r.previous.to], ['2025-04-01', '2026-03-31']);
  assert.equal(r.totals.revenueFromOperations.previous, 2000);
  assert.equal(r.totals.profitBeforeTax.previous, 2000);
  const lines = r.rows.filter((x) => x.kind === 'line').map((x) => [x.label, x.amount]);
  assert.deepEqual(lines.find(([l]) => l === 'Sales'), ['Sales', 16000]);
  assert.deepEqual(lines.find(([l]) => l === 'Sales Returns'), ['Sales Returns', -1000]);
  assert.deepEqual(lines.find(([l]) => l === 'Rent'), ['Rent', 2000]);
  assert.equal(find(r.rows, 'profitBeforeTax').amount, 8000);
  assert.equal(r.company.name, 'Reports Co');
});

test('profit and loss respects the date range and compares with an equal period before it', async () => {
  const { t } = await setup();
  const q1 = await pl(t, '?from=2026-04-01&to=2026-06-30');           // sale 10,000, bill 4,000
  assert.equal(q1.totals.profitBeforeTax.amount, 6000);
  assert.deepEqual([q1.previous.from, q1.previous.to], ['2025-04-01', '2025-06-30']);
  assert.equal(q1.totals.profitBeforeTax.previous, 0);

  const july = await pl(t, '?from=2026-07-01&to=2026-07-31');         // only the rent
  assert.equal(july.totals.profitBeforeTax.amount, -2000);
  assert.equal(find(july.rows, 'profitBeforeTax').label, 'Loss before tax');
  assert.deepEqual([july.previous.from, july.previous.to], ['2026-05-31', '2026-06-30']);
  assert.equal(july.totals.profitBeforeTax.previous, -4000);   // bill 4,000 on 1 June, no sale in the window

  const bad = await call('GET', '/reports/profit-loss?from=2026-05-01&to=2026-04-01', undefined, t);
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/reports/profit-loss?from=2026-02-31', undefined, t)).status, 400);
  assert.equal((await call('GET', '/reports/profit-loss?format=pdf', undefined, t)).status, 400);
});

test('with no dates the profit and loss covers the current financial year to today', async () => {
  const { t } = await setup();
  const r = await pl(t, '');
  assert.match(r.from, /^\d{4}-04-01$/);
  assert.equal(r.to, today());
  assert.ok(r.from <= r.to);
});

test('the balance sheet balances and its retained profit equals the profit and loss to date', async () => {
  const { t } = await setup();
  const b = await ok(call('GET', '/reports/balance-sheet?asOf=2026-10-09', undefined, t));
  assert.equal(b.balanced, true);
  assert.equal(b.difference, 0);
  assert.equal(b.totals.totalAssets, b.totals.totalLiabilities + b.totals.totalEquity);
  const all = await pl(t, '?from=2020-04-01&to=2026-10-09');
  assert.equal(b.totals.retainedEarnings, all.totals.profitBeforeTax.amount);
  assert.equal(b.totals.retainedEarnings, 10000);                       // 2,000 last year + 8,000 this year
  assert.equal(b.totals.totalEquity, 60000);                            // capital 50,000 + retained 10,000
  const line = (key, label) => b.rows.filter((r) => r.kind === 'line' && r.label === label).map((r) => r.amount)[0];
  assert.equal(line('x', 'Bank Account'), 55000);                       // capital + 5,000 receipt
  assert.equal(line('x', 'Cash in Hand'), -6720);                       // bill payment and rent
  assert.equal(line('x', 'Sundry Debtors'), 15060);                     // 2,360 + 6,800 + 5,900
  assert.equal(line('x', 'Sundry Creditors'), 1180);
  // comparative at the previous financial year end
  assert.equal(b.previousAsOf, '2026-03-31');
  assert.equal(b.totals.previous.retainedEarnings, 2000);
  assert.equal(b.totals.previous.totalAssets, 2360);
  assert.equal(b.totals.previous.totalEquity, 2000);
  assert.equal(b.totals.previous.totalAssets, b.totals.previous.totalLiabilities + b.totals.previous.totalEquity);
  // earlier date, earlier numbers
  const june = await ok(call('GET', '/reports/balance-sheet?asOf=2026-06-30', undefined, t));
  assert.equal(june.balanced, true);
  assert.equal(june.totals.retainedEarnings, 2000 + 10000 - 4000);
});

test('outstanding amounts are aged from the document date, net of payments and returns', async () => {
  const { t } = await setup();
  const o = await ok(call('GET', '/reports/outstanding?asOf=2026-10-09', undefined, t));
  const alpha = o.receivables.parties.find((p) => p.name === 'Alpha Traders'), beta = o.receivables.parties.find((p) => p.name === 'Beta Stores');
  assert.deepEqual([alpha.b0, alpha.b1, alpha.b2, alpha.b3, alpha.total], [0, 5900, 0, 6800, 12700]);   // 20 Aug 50 days; 10 May 152 days, 5,000 received
  assert.deepEqual([beta.b0, beta.b1, beta.b2, beta.b3, beta.total], [0, 0, 0, 2360, 2360]);
  assert.deepEqual(o.receivables.totals, { b0: 0, b1: 5900, b2: 0, b3: 9160, total: 15060 });
  assert.equal(alpha.documents.length, 2);                              // the returned invoice is not open
  assert.equal(o.payables.parties.length, 1);                           // the paid bill is gone
  assert.deepEqual([o.payables.totals.b0, o.payables.totals.total], [1180, 1180]);
  // as at an earlier date the first bill was still owed and the receipt had not come in
  const early = await ok(call('GET', '/reports/outstanding?asOf=2026-06-10', undefined, t));
  assert.equal(early.payables.totals.total, 4720);
  assert.equal(early.receivables.parties.find((p) => p.name === 'Alpha Traders').total, 11800);
});

test('downloads: xlsx and csv carry the same totals as the report', async () => {
  const { t } = await setup();
  const x = await raw('/reports/profit-loss?from=2026-04-01&to=2027-03-31&format=xlsx', t);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  assert.match(x.headers.get('content-disposition'), /attachment; filename="Reports-Co-profit-and-loss-2026-04-01-to-2027-03-31\.xlsx"/);
  const rows = await readTable(Buffer.from(await x.arrayBuffer()), 'xlsx');
  assert.match(rows[0][0], /Reports Co - Profit and Loss/);
  assert.match(rows[1][0], /GSTIN 29REPRT5555Q1Z/);
  const row = (label) => rows.find((r) => String(r[0]).trim() === label);
  assert.equal(row('Profit before tax')[2], 8000);
  assert.equal(row('Profit before tax')[3], 2000);
  assert.equal(row('Total revenue from operations')[2], 15000);
  assert.equal(typeof row('Rent')[2], 'number');

  const c = await raw('/reports/profit-loss?from=2026-04-01&to=2027-03-31&format=csv', t);
  assert.match(c.headers.get('content-type'), /text\/csv/);
  assert.match(c.headers.get('content-disposition'), /\.csv"/);
  const crows = await readTable(Buffer.from(await c.arrayBuffer()), 'csv');
  assert.equal(crows.find((r) => r[0].trim() === 'Total expenses')[2], '7000.00');

  const bs = await raw('/reports/balance-sheet?asOf=2026-10-09&format=xlsx', t);
  assert.match(bs.headers.get('content-disposition'), /balance-sheet-as-at-2026-10-09\.xlsx/);
  const brows = await readTable(Buffer.from(await bs.arrayBuffer()), 'xlsx');
  const total = (l) => brows.find((r) => String(r[0]).trim() === l)[2];
  assert.equal(total('Total assets'), total('Total equity and liabilities'));

  const os = await raw('/reports/outstanding?asOf=2026-10-09&format=csv', t);
  const orows = await readTable(Buffer.from(await os.arrayBuffer()), 'csv');
  assert.equal(orows.find((r) => r[0] === 'Receivable total')[6], '15060.00');
  assert.equal(orows.find((r) => r[0] === 'Payable total')[6], '1180.00');
  const ox = await raw('/reports/outstanding?asOf=2026-10-09&format=xlsx', t);
  assert.equal(ox.status, 200);
});

test('the report index lists the reports and the current financial year', async () => {
  const { t } = await setup();
  const i = await ok(call('GET', '/reports/index', undefined, t));
  assert.deepEqual(i.reports.map((r) => r.id), ['profit-loss', 'balance-sheet', 'outstanding']);
  assert.match(i.financialYear, /^\d{4}-\d{2}$/);
  assert.match(i.from, /-04-01$/);
  assert.equal((await raw('/reports/index')).status, 401);
});

test('a new company sees zeros and none of another company\'s entries', async () => {
  await setup();
  const t2 = await register('Empty Co');
  const p = await pl(t2, '?from=2026-04-01&to=2027-03-31');
  assert.equal(p.empty, true);
  assert.equal(p.totals.profitBeforeTax.amount, 0);
  const b = await ok(call('GET', '/reports/balance-sheet?asOf=2026-10-09', undefined, t2));
  assert.equal(b.balanced, true);
  assert.equal(b.totals.totalAssets, 0);
  assert.equal(b.empty, true);
  const o = await ok(call('GET', '/reports/outstanding?asOf=2026-10-09', undefined, t2));
  assert.deepEqual([o.receivables.parties.length, o.payables.parties.length, o.receivables.totals.total], [0, 0, 0]);
  for (const f of ['xlsx', 'csv']) {
    assert.equal((await raw(`/reports/profit-loss?from=2026-04-01&to=2027-03-31&format=${f}`, t2)).status, 200);
    assert.equal((await raw(`/reports/balance-sheet?format=${f}`, t2)).status, 200);
    assert.equal((await raw(`/reports/outstanding?format=${f}`, t2)).status, 200);
  }
});

test('comparative period helpers', () => {
  assert.deepEqual(previousPeriod('2026-04-01', '2027-03-31'), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(previousPeriod('2026-04-01', '2026-10-09'), { from: '2025-04-01', to: '2025-10-09' });
  assert.deepEqual(previousPeriod('2026-07-01', '2026-07-31'), { from: '2026-05-31', to: '2026-06-30' });
  assert.equal(previousYearEnd('2027-03-31'), '2026-03-31');
  assert.equal(previousYearEnd('2026-10-09'), '2026-03-31');
  assert.equal(addYears('2024-02-29', -1), '2023-02-28');
});
