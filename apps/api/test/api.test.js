import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';

let base, token;
const api = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  const reg = await api('POST', '/auth/register', {
    name: 'Siva', email: 'siva@example.com', password: 'password123',
    company: 'Demo Traders', sector: 'trading', stateCode: '29',
  }, null);
  assert.equal(reg.status, 201);
  token = reg.body.token;
});

test('rejects unauthenticated access', async () => {
  assert.equal((await api('GET', '/items', null, null)).status, 401);
});

test('invoice: intra-state splits CGST/SGST, inter-state uses IGST, stock decrements', async () => {
  const item = (await api('POST', '/items', { name: 'Widget', rate: 500, gstPct: 12, stock: 20 })).body;
  const local = (await api('POST', '/parties', { type: 'customer', name: 'Local Co', stateCode: '29' })).body;
  const far = (await api('POST', '/parties', { type: 'customer', name: 'Far Co', stateCode: '27' })).body;

  const a = await api('POST', '/invoices', { partyId: local.id, date: '2026-10-06', lines: [{ itemId: item.id, qty: 10 }] });
  assert.equal(a.status, 201);
  assert.equal(a.body.number, 'INV-0001');
  assert.deepEqual(
    [a.body.taxable, a.body.cgst, a.body.sgst, a.body.igst, a.body.total].map(Number),
    [5000, 300, 300, 0, 5600]);

  const b = await api('POST', '/invoices', { partyId: far.id, date: '2026-10-06', lines: [{ itemId: item.id, qty: 5 }] });
  assert.deepEqual([b.body.cgst, b.body.sgst, b.body.igst].map(Number), [0, 0, 300]);

  const items = (await api('GET', '/items')).body;
  assert.equal(Number(items[0].stock), 5);

  const over = await api('POST', '/invoices', { partyId: local.id, date: '2026-10-06', lines: [{ itemId: item.id, qty: 99 }] });
  assert.equal(over.status, 400);
  assert.equal(Number((await api('GET', '/items')).body[0].stock), 5, 'failed invoice must not change stock');
});

test('payments update status and dashboard', async () => {
  const [inv] = (await api('GET', '/invoices')).body.filter((i) => i.number === 'INV-0001');
  const p1 = await api('POST', `/invoices/${inv.id}/payments`, { amount: 600 });
  assert.equal(p1.body.status, 'partial');
  const p2 = await api('POST', `/invoices/${inv.id}/payments`, { amount: 5000 });
  assert.equal(p2.body.status, 'paid');
  assert.equal((await api('POST', `/invoices/${inv.id}/payments`, { amount: 1 })).status, 400);
  const d = (await api('GET', '/dashboard')).body;
  assert.equal(d.invoices, 2);
});

test('tenant isolation', async () => {
  const other = (await api('POST', '/auth/register', {
    name: 'Other', email: 'o@example.com', password: 'password123', company: 'Other Ltd', sector: 'retail', stateCode: '29',
  }, null)).body.token;
  assert.equal((await api('GET', '/invoices', null, other)).body.length, 0);
  assert.equal((await api('GET', '/invoices/1', null, other)).status, 404);
});

test('purchase: exclusive GST (10 x 500 @12% = 5,600), ITC split, stock increases, duplicate bill rejected', async () => {
  const item = (await api('POST', '/items', { name: 'Gadget', rate: 800, gstPct: 12, stock: 0 })).body;
  const local = (await api('POST', '/parties', { type: 'vendor', name: 'Local Supplier', stateCode: '29' })).body;
  const far = (await api('POST', '/parties', { type: 'vendor', name: 'Far Supplier', stateCode: '27' })).body;
  const body = (partyId, no, qty = 10) => ({ partyId, supplierBillNo: no, date: '2026-10-06', lines: [{ itemId: item.id, qty, rate: 500 }] });

  const a = await api('POST', '/purchases', body(local.id, 'S-1'));
  assert.equal(a.status, 201);
  assert.equal(a.body.number, 'BILL-0001');
  assert.deepEqual([a.body.taxable, a.body.cgst, a.body.sgst, a.body.igst, a.body.total].map(Number), [5000, 300, 300, 0, 5600]);

  const b = await api('POST', '/purchases', body(far.id, 'S-1', 4));
  assert.equal(b.status, 201, 'same bill no. from a different vendor is allowed');
  assert.deepEqual([b.body.cgst, b.body.sgst, b.body.igst].map(Number), [0, 0, 240]);

  assert.equal((await api('POST', '/purchases', body(local.id, 'S-1'))).status, 409);
  const gadget = (await api('GET', '/items')).body.find((i) => i.name === 'Gadget');
  assert.equal(Number(gadget.stock), 14);

  const cust = (await api('POST', '/parties', { type: 'customer', name: 'C', stateCode: '29' })).body;
  assert.equal((await api('POST', '/purchases', body(cust.id, 'X-1'))).status, 400, 'customers are not vendors');
});

test('purchase payments + dashboard payables/input GST; GST slab override', async () => {
  const [bill] = (await api('GET', '/purchases')).body.filter((x) => x.number === 'BILL-0001');
  assert.equal((await api('POST', `/purchases/${bill.id}/payments`, { amount: 1600 })).body.status, 'partial');
  assert.equal((await api('POST', `/purchases/${bill.id}/payments`, { amount: 4000 })).body.status, 'paid');
  assert.equal((await api('POST', `/purchases/${bill.id}/payments`, { amount: 1 })).status, 400);

  const d = (await api('GET', '/dashboard')).body;
  assert.equal(d.bills, 2);
  assert.equal(d.inputGst, 840);
  assert.equal(d.payable, 2240);

  const item = (await api('GET', '/items')).body[0];
  const v = (await api('GET', '/parties?type=vendor')).body[0];
  const o = await api('POST', '/purchases', { partyId: v.id, supplierBillNo: 'S-9', date: '2026-10-07',
    lines: [{ itemId: item.id, qty: 1, rate: 1000, gstPct: 5 }] });
  assert.equal(Number(o.body.total), 1050);
});

test('purchase tenant isolation', async () => {
  const other = (await api('POST', '/auth/register', {
    name: 'O2', email: 'o2@example.com', password: 'password123', company: 'Other 2', sector: 'retail', stateCode: '29',
  }, null)).body.token;
  assert.equal((await api('GET', '/purchases', null, other)).body.length, 0);
  assert.equal((await api('GET', '/purchases/1', null, other)).status, 404);
  assert.equal((await api('POST', '/purchases/1/payments', { amount: 1 }, other)).status, 404);
});

// ---- returns ----
const mk = async () => {
  const item = (await api('POST', '/items', { name: 'RetItem', rate: 500, gstPct: 12, stock: 100 })).body;
  const cust = (await api('POST', '/parties', { type: 'customer', name: 'RC', stateCode: '29' })).body;
  const vend = (await api('POST', '/parties', { type: 'vendor', name: 'RV', stateCode: '29' })).body;
  const inv = (await api('POST', '/invoices', { partyId: cust.id, date: '2026-10-06', lines: [{ itemId: item.id, qty: 10 }] })).body;
  const bill = (await api('POST', '/purchases', { partyId: vend.id, supplierBillNo: 'R-' + Math.random(), date: '2026-10-06',
    lines: [{ itemId: item.id, qty: 10, rate: 500 }] })).body;
  const stock = async () => Number((await api('GET', '/items')).body.find((i) => i.id === item.id).stock);
  return { item, inv, bill, stock };
};

test('sales return: partial credit note (4 of 10 -> 2,240), stock back, outstanding reduced, CN numbering', async () => {
  const { inv, stock } = await mk();
  const before = await stock(); // 100 - 10 + 10 = 100
  const { lines } = (await api('GET', `/invoices/${inv.id}/returnable`)).body;
  assert.equal(lines[0].remainingQty, 10);

  const n = await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', reason: 'Damaged', lines: [{ lineId: lines[0].id, qty: 4 }] });
  assert.equal(n.status, 201);
  assert.match(n.body.number, /^CN-\d{4}$/);
  assert.deepEqual([n.body.taxable, n.body.cgst, n.body.sgst, n.body.total].map(Number), [2000, 120, 120, 2240]);
  assert.equal(await stock(), before + 4);

  const after = (await api('GET', `/invoices/${inv.id}`)).body;
  assert.equal(Number(after.returned), 2240);
  assert.equal(after.status, 'unpaid');

  // over-return and date guards
  assert.equal((await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', lines: [{ lineId: lines[0].id, qty: 7 }] })).status, 400);
  assert.equal((await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-01', lines: [{ lineId: lines[0].id, qty: 1 }] })).status, 400);

  // payment now capped at 5,600 - 2,240 = 3,360
  assert.equal((await api('POST', `/invoices/${inv.id}/payments`, { amount: 3361 })).status, 400);
  assert.equal((await api('POST', `/invoices/${inv.id}/payments`, { amount: 3360 })).body.status, 'paid');

  // full return of the rest -> exactly the remaining 3,360, document fully returned
  const full = await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', full: true });
  assert.equal(Number(full.body.total), 3360);
  assert.equal((await api('GET', `/invoices/${inv.id}`)).body.status, 'returned');
  assert.equal((await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', full: true })).status, 400);
});

test('purchase return: debit note reduces stock + payable; blocked when stock is insufficient', async () => {
  const { bill, inv, item, stock } = await mk();
  const before = await stock();
  const { lines } = (await api('GET', `/purchases/${bill.id}/returnable`)).body;
  const n = await api('POST', `/purchases/${bill.id}/returns`, { date: '2026-10-07', lines: [{ lineId: lines[0].id, qty: 4 }] });
  assert.equal(n.status, 201);
  assert.match(n.body.number, /^DN-\d{4}$/);
  assert.equal(Number(n.body.total), 2240);
  assert.equal(await stock(), before - 4);
  assert.equal(Number((await api('GET', `/purchases/${bill.id}`)).body.returned), 2240);

  // sell nearly everything, then returning goods we no longer hold must fail
  const cust = (await api('GET', '/parties?type=customer')).body[0];
  await api('POST', '/invoices', { partyId: cust.id, date: '2026-10-07', lines: [{ itemId: item.id, qty: await stock() }] });
  const blocked = await api('POST', `/purchases/${bill.id}/returns`, { date: '2026-10-08', lines: [{ lineId: lines[0].id, qty: 1 }] });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /stock/i);
  void inv;
});

test('value-only note: no stock movement, capped at line value, GST proportional', async () => {
  const { inv, stock } = await mk();
  const before = await stock();
  const { lines } = (await api('GET', `/invoices/${inv.id}/returnable`)).body;
  const n = await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', type: 'value', reason: 'Discount', lines: [{ lineId: lines[0].id, amount: 1000 }] });
  assert.equal(n.status, 201);
  assert.equal(Number(n.body.total), 1120);
  assert.equal(await stock(), before);
  assert.equal((await api('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-07', type: 'value', lines: [{ lineId: lines[0].id, amount: 4001 }] })).status, 400);
  const detail = (await api('GET', `/returns/${n.body.id}`)).body;
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].qty, null);
});

test('returns: register, dashboard nets GST, isolation', async () => {
  const credits = (await api('GET', '/returns?kind=credit')).body;
  const debits = (await api('GET', '/returns?kind=debit')).body;
  assert.ok(credits.length >= 3 && debits.length >= 1);
  assert.ok(credits.every((c) => c.kind === 'credit' && c.docNumber.startsWith('INV-')));
  const d = (await api('GET', '/dashboard')).body;
  assert.ok(d.salesReturns > 0 && d.purchaseReturns > 0);
  const other = (await api('POST', '/auth/register', {
    name: 'O3', email: 'o3@example.com', password: 'password123', company: 'Other 3', sector: 'retail', stateCode: '29',
  }, null)).body.token;
  assert.equal((await api('GET', '/returns', null, other)).body.length, 0);
  assert.equal((await api('GET', `/returns/${credits[0].id}`, null, other)).status, 404);
  assert.equal((await api('GET', '/invoices/1/returnable', null, other)).status, 404);
  assert.equal((await api('POST', '/invoices/1/returns', { date: '2026-10-07', full: true }, other)).status, 404);
});
// ---- ledger ----
test('ledger: every document posts a balanced journal; balances, statements and trial balance tie out', async () => {
  const t = (await api('POST', '/auth/register', {
    name: 'Ledger', email: 'ledger@example.com', password: 'password123', company: 'Ledger Co', sector: 'trading', stateCode: '29',
  }, null)).body.token;
  const call = (m, p, b) => api(m, p, b, t);

  const accts = (await call('GET', '/accounts')).body;
  assert.equal(accts.length, 30);
  const id = (code) => accts.find((a) => a.code === code).id;
  const bal = async (code) => Number((await call('GET', '/accounts')).body.find((a) => a.code === code).balance);

  // owner's capital: Dr Bank / Cr Capital 1,00,000
  const cap = await call('POST', '/journal', { date: '2026-10-01', narration: 'Capital introduced',
    lines: [{ accountId: id('1010'), debit: 100000 }, { accountId: id('3000'), credit: 100000 }] });
  assert.equal(cap.status, 201);

  const item = (await call('POST', '/items', { name: 'Thing', rate: 800, gstPct: 12, stock: 0 })).body;
  const vend = (await call('POST', '/parties', { type: 'vendor', name: 'V', stateCode: '29' })).body;
  const cust = (await call('POST', '/parties', { type: 'customer', name: 'C', stateCode: '29' })).body;

  // purchase 10 x 500 @12% = 5,600; pay by bank
  const bill = (await call('POST', '/purchases', { partyId: vend.id, supplierBillNo: 'L1', date: '2026-10-02',
    lines: [{ itemId: item.id, qty: 10, rate: 500 }] })).body;
  assert.equal(await bal('5000'), 5000);
  assert.equal(await bal('1200'), 300);
  assert.equal(await bal('1210'), 300);
  assert.equal(await bal('2000'), 5600);
  assert.equal((await call('POST', `/purchases/${bill.id}/payments`, { amount: 5600, mode: 'bank', date: '2026-10-03' })).status, 200);
  assert.equal(await bal('2000'), 0);
  assert.equal(await bal('1010'), 94400);

  // sale 4 x 800 @12% = 3,584; receipt 1,000 cash; credit note for 1 unit = 896
  const inv = (await call('POST', '/invoices', { partyId: cust.id, date: '2026-10-04', lines: [{ itemId: item.id, qty: 4 }] })).body;
  assert.equal(await bal('1100'), 3584);
  assert.equal(await bal('4000'), 3200);
  assert.equal(await bal('2100'), 192);
  assert.equal((await call('POST', `/invoices/${inv.id}/payments`, { amount: 1000, date: '2026-10-05' })).status, 200);
  assert.equal(await bal('1000'), 1000);
  const { lines } = (await call('GET', `/invoices/${inv.id}/returnable`)).body;
  await call('POST', `/invoices/${inv.id}/returns`, { date: '2026-10-06', lines: [{ lineId: lines[0].id, qty: 1 }] });
  assert.equal(await bal('1100'), 1688);
  assert.equal(await bal('4100'), 800);
  assert.equal(await bal('2100'), 144, 'output CGST is net of the credit note');

  // trial balance
  const tb = (await call('GET', '/trial-balance')).body;
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, tb.totalCredit);

  // as-of filter: before the sale there is no Debtors balance
  assert.equal(Number((await call('GET', '/accounts?asOf=2026-10-03')).body.find((a) => a.code === '1100').balance), 0);

  // account statement with opening balance + running balance (Bank, from 3 Oct)
  const st = (await call('GET', `/accounts/${id('1010')}/statement?from=2026-10-03`)).body;
  assert.equal(st.opening, 100000);
  assert.equal(st.lines.length, 1);
  assert.equal(st.closing, 94400);

  // party statement ties to the Debtors account
  const ps = (await call('GET', `/parties/${cust.id}/ledger`)).body;
  assert.equal(ps.closing, 1688);
  assert.equal(ps.label, 'Receivable');
  assert.deepEqual(ps.lines.map((l) => l.sourceType), ['invoice', 'receipt', 'credit_note']);
  assert.equal((await call('GET', `/parties/${vend.id}/ledger`)).body.closing, 0);

  // journal register
  const j = (await call('GET', '/journal')).body;
  assert.equal(j.length, 6); // capital, purchase, payment, invoice, receipt, credit note
  assert.ok(j.every((e) => e.lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0) === 0));

  // validation
  const bad = (lines) => call('POST', '/journal', { date: '2026-10-06', lines });
  assert.equal((await bad([{ accountId: id('1000'), debit: 10 }, { accountId: id('4000'), credit: 9 }])).status, 400);
  assert.equal((await bad([{ accountId: id('1000'), debit: 10, credit: 10 }, { accountId: id('4000'), credit: 0, debit: 0 }])).status, 400);
  assert.equal((await bad([{ accountId: 999999, debit: 10 }, { accountId: id('4000'), credit: 10 }])).status, 400);
  assert.equal((await call('POST', `/invoices/${inv.id}/payments`, { amount: 1, date: '2026-10-01' })).status, 400, 'payment before document date');

  // custom account + duplicate code
  assert.equal((await call('POST', '/accounts', { code: '5200', name: 'Rent', type: 'expense' })).body.normal, 'debit');
  assert.equal((await call('POST', '/accounts', { code: '5200', name: 'Rent 2', type: 'expense' })).status, 409);

  // isolation
  assert.equal((await api('GET', `/accounts/${id('1010')}/statement`)).status, 404);
  assert.equal((await api('GET', `/parties/${cust.id}/ledger`)).status, 404);
  assert.equal((await api('POST', '/journal', { date: '2026-10-06', lines: [{ accountId: id('1000'), debit: 5 }, { accountId: id('4000'), credit: 5 }] })).status, 400);
});
