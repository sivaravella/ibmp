import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { setOff } from '../src/gstreports.js';

let base, token;
const api = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  token = (await api('POST', '/auth/register', {
    name: 'G', email: 'g@example.com', password: 'password123', company: 'GST Co', sector: 'trading', gstin: '29ABCDE1234F1Z5',
  }, null)).body.token;

  // Items: A (18%), B (12%), C (nil-rated)
  const A = await ok(api('POST', '/items', { name: 'A', hsn: '8471', rate: 1000, gstPct: 18, stock: 0 }));
  const B = await ok(api('POST', '/items', { name: 'B', hsn: '6109', rate: 500, gstPct: 12, stock: 0 }));
  const C = await ok(api('POST', '/items', { name: 'C', hsn: '1001', rate: 100, gstPct: 0, stock: 100 }));
  const v1 = await ok(api('POST', '/parties', { type: 'vendor', name: 'Reg Vendor', gstin: '29AAAAA0000A1Z5' }));
  const v2 = await ok(api('POST', '/parties', { type: 'vendor', name: 'Unreg Vendor', stateCode: '29' }));
  const r1 = await ok(api('POST', '/parties', { type: 'customer', name: 'Reg Local', gstin: '29BBBBB1111B1Z6' }));
  const r2 = await ok(api('POST', '/parties', { type: 'customer', name: 'Reg Inter', gstin: '27CCCCC2222C1Z7' }));
  const u1 = await ok(api('POST', '/parties', { type: 'customer', name: 'Unreg Local', stateCode: '29' }));
  const u2 = await ok(api('POST', '/parties', { type: 'customer', name: 'Unreg Inter', stateCode: '27' }));

  // Purchases (Oct): registered vendor A 20x600 + B 50x300; unregistered vendor B 10x300 (GST charged, not claimable)
  const bill1 = await ok(api('POST', '/purchases', { partyId: v1.id, supplierBillNo: 'V1', date: '2026-10-02',
    lines: [{ itemId: A.id, qty: 20, rate: 600 }, { itemId: B.id, qty: 50, rate: 300 }] }));
  await ok(api('POST', '/purchases', { partyId: v2.id, supplierBillNo: 'V2', date: '2026-10-03', lines: [{ itemId: B.id, qty: 10, rate: 300 }] }));

  const sale = (partyId, lines, date = '2026-10-10') => ok(api('POST', '/invoices', { partyId, date, lines }));
  const s1 = await sale(r1.id, [{ itemId: A.id, qty: 2 }, { itemId: B.id, qty: 4 }]);
  await sale(r2.id, [{ itemId: A.id, qty: 1 }]);
  const s3 = await sale(u1.id, [{ itemId: B.id, qty: 2 }]);
  await sale(u2.id, [{ itemId: B.id, qty: 4 }]);
  const s5 = await sale(u2.id, [{ itemId: A.id, qty: 1, rate: 250000 }]);      // B2C large: 2,95,000
  await sale(u1.id, [{ itemId: C.id, qty: 10 }]);                              // nil-rated
  await sale(u1.id, [{ itemId: B.id, qty: 1 }], '2026-11-02');                 // next month: must be excluded

  const lineOf = async (kind, docId, itemName) =>
    (await ok(api('GET', `/${kind}/${docId}/returnable`))).lines.find((l) => l.description === itemName).id;
  await ok(api('POST', `/invoices/${s1.id}/returns`, { date: '2026-10-20', lines: [{ lineId: await lineOf('invoices', s1.id, 'A'), qty: 1 }] }));   // CN -> CDNR
  await ok(api('POST', `/invoices/${s3.id}/returns`, { date: '2026-10-20', lines: [{ lineId: await lineOf('invoices', s3.id, 'B'), qty: 1 }] }));   // CN -> nets B2CS
  await ok(api('POST', `/invoices/${s5.id}/returns`, { date: '2026-10-20', type: 'value', lines: [{ lineId: await lineOf('invoices', s5.id, 'A'), amount: 10000 }] })); // CN -> CDNUR
  await ok(api('POST', `/purchases/${bill1.id}/returns`, { date: '2026-10-21', lines: [{ lineId: await lineOf('purchases', bill1.id, 'B'), qty: 10 }] })); // DN -> ITC reversal
});

const n = (x) => Number(x);

test('GSTR-1: table classification, rate-wise netting, HSN summary, doc ranges', async () => {
  const g = (await api('GET', '/gst/gstr1?period=2026-10')).body;
  assert.deepEqual(g.warnings, []);

  assert.equal(g.b2b.length, 2);
  const [s1, s2] = g.b2b;
  assert.deepEqual([s1.ctin, s1.taxable, s1.cgst, s1.sgst, s1.igst, s1.value], ['29BBBBB1111B1Z6', 4000, 300, 300, 0, 4600]);
  assert.deepEqual([s2.ctin, s2.taxable, s2.igst, s2.pos], ['27CCCCC2222C1Z7', 1000, 180, '27']);
  assert.deepEqual(s1.rates.map((r) => [r.rate, r.taxable]), [[18, 2000], [12, 2000]]);

  assert.equal(g.b2cl.length, 1);
  assert.deepEqual([g.b2cl[0].taxable, g.b2cl[0].igst, g.b2cl[0].value], [250000, 45000, 295000]);

  const row = (type, pos, rate) => g.b2cs.find((r) => r.type === type && r.pos === pos && r.rate === rate);
  assert.deepEqual([row('INTRA', '29', 12).taxable, row('INTRA', '29', 12).cgst], [500, 30], 'CN2 nets the local 12% row');
  assert.deepEqual([row('INTRA', '29', 0).taxable, row('INTRA', '29', 0).cgst], [1000, 0]);
  assert.deepEqual([row('INTER', '27', 12).taxable, row('INTER', '27', 12).igst], [2000, 240]);
  assert.equal(g.b2cs.length, 3);

  assert.deepEqual([g.cdnr.length, g.cdnr[0].against, g.cdnr[0].taxable, g.cdnr[0].cgst, g.cdnr[0].value], [1, 'INV-0001', 1000, 90, 1180]);
  assert.deepEqual([g.cdnur.length, g.cdnur[0].taxable, g.cdnur[0].igst], [1, 10000, 1800]);

  const hsn = (c) => g.hsn.find((x) => x.hsn === c);
  assert.deepEqual([hsn('8471').qty, hsn('8471').taxable, hsn('8471').igst, hsn('8471').cgst, hsn('8471').sgst], [3, 242000, 43380, 90, 90]);
  assert.deepEqual([hsn('6109').qty, hsn('6109').taxable, hsn('6109').igst, hsn('6109').cgst], [9, 4500, 240, 150]);
  assert.deepEqual([hsn('1001').qty, hsn('1001').taxable], [10, 1000]);

  assert.deepEqual(g.docs.invoices, { count: 6, from: 'INV-0001', to: 'INV-0006' });
  assert.deepEqual(g.docs.creditNotes, { count: 3, from: 'CN-0001', to: 'CN-0003' });
  assert.deepEqual([g.totals.taxable, g.totals.igst, g.totals.cgst, g.totals.sgst], [247500, 43620, 240, 240]);
});

test('GSTR-1: period boundaries and validation', async () => {
  const nov = (await api('GET', '/gst/gstr1?period=2026-11')).body;
  assert.equal(nov.docs.invoices.count, 1);
  assert.equal(nov.b2cs.length, 1);
  const empty = (await api('GET', '/gst/gstr1?period=2026-09')).body;
  assert.match(empty.warnings.join(' '), /No invoices/);
  assert.equal((await api('GET', '/gst/gstr1?period=2026-13')).status, 400);
  assert.equal((await api('GET', '/gst/gstr1')).status, 400);
});

test('GSTR-3B: outward supplies, ITC (reversal + ineligible), set-off, ledger reconciliation', async () => {
  const g = (await api('GET', '/gst/gstr3b?period=2026-10')).body;
  const o = g.outward;
  assert.deepEqual([o.taxable.taxable, o.taxable.igst, o.taxable.cgst, o.taxable.sgst], [246500, 43620, 240, 240]);
  assert.equal(o.nilRated.taxable, 1000);
  assert.deepEqual(o.unregisteredInterstate, [{ pos: '27', taxable: 242000, igst: 43440 }]);

  assert.deepEqual(g.itc.available, { igst: 0, cgst: 1980, sgst: 1980 });
  assert.deepEqual(g.itc.reversed, { igst: 0, cgst: 180, sgst: 180 });
  assert.deepEqual(g.itc.ineligible, { igst: 0, cgst: 180, sgst: 180 });
  assert.deepEqual(g.itc.net, { igst: 0, cgst: 1800, sgst: 1800 });
  assert.match(g.warnings.join(' '), /BILL-0002/);

  // Output IGST 43,620 / CGST 240 / SGST 240. CGST credit 1,800 clears CGST 240, then 1,560 off IGST; same for SGST.
  const l = g.liability;
  assert.deepEqual(l.itcUsed.cgst, { igst: 1560, cgst: 240, sgst: 0 });
  assert.deepEqual(l.itcUsed.sgst, { igst: 1560, cgst: 0, sgst: 240 });
  assert.deepEqual(l.cashPayable, { igst: 40500, cgst: 0, sgst: 0 });
  assert.equal(l.cashTotal, 40500);
  assert.deepEqual(l.itcCarryForward, { igst: 0, cgst: 0, sgst: 0 });

  assert.equal(g.reconciliation.ok, true, JSON.stringify(g.reconciliation));
});

test('GSTR-3B: a stray manual journal on a GST account breaks reconciliation and is flagged', async () => {
  const accts = (await api('GET', '/accounts')).body;
  const id = (c) => accts.find((a) => a.code === c).id;
  await ok(api('POST', '/journal', { date: '2026-10-25', narration: 'Oops',
    lines: [{ accountId: id('1000'), debit: 50 }, { accountId: id('2100'), credit: 50 }] }));
  const g = (await api('GET', '/gst/gstr3b?period=2026-10')).body;
  assert.equal(g.reconciliation.ok, false);
  assert.equal(g.reconciliation.output.diff.cgst, 50);
  assert.match(g.warnings.join(' '), /ledger/i);
});

test('set-off follows section 49 ordering', () => {
  // IGST credit is used before CGST/SGST credits; CGST credit cannot pay SGST.
  const r = setOff({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 40, sgst: 10 });
  assert.deepEqual(r.used.igst, { igst: 100, cgst: 20, sgst: 0 });
  assert.deepEqual(r.used.cgst, { igst: 0, cgst: 30 });
  assert.deepEqual(r.used.sgst, { igst: 0, sgst: 10 });
  assert.deepEqual(r.cash, { igst: 0, cgst: 0, sgst: 40 });
  assert.deepEqual(r.carry_forward, { igst: 0, cgst: 10, sgst: 0 });
});

test('company without GSTIN is warned; reports are tenant-scoped', async () => {
  const t = (await api('POST', '/auth/register', {
    name: 'N', email: 'n@example.com', password: 'password123', company: 'No Gstin', sector: 'retail', stateCode: '29',
  }, null)).body.token;
  const g = (await api('GET', '/gst/gstr1?period=2026-10', null, t)).body;
  assert.match(g.warnings.join(' '), /no GSTIN/);
  assert.equal(g.b2b.length + g.hsn.length, 0);
  assert.equal((await api('GET', '/gst/gstr3b?period=2026-10', null, t)).body.outward.taxable.taxable, 0);
});
