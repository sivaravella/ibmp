import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
let call, seq = 0;
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

async function world() {
  const t = (await call('POST', '/auth/register', { name: 'T', email: `rcm${++seq}@example.com`, password: 'password123', company: `Rcm Co ${seq}`, sector: 'trading', gstin: gstin('29RCMCO5555Q1Z') })).body.token;
  const vendor = await ok(call('POST', '/parties', { type: 'vendor', name: 'Local Transporter', stateCode: '29' }, t));
  const buyer = await ok(call('POST', '/parties', { type: 'customer', name: 'Local Buyer', gstin: gstin('29BBBBB1111B1Z') }, t));
  const item = await ok(call('POST', '/items', { name: 'Freight service', hsn: '9965', rate: 1000, gstPct: 18, stock: 0, unit: 'Nos' }, t));
  const exempt = await ok(call('POST', '/items', { name: 'Grain', hsn: '1001', rate: 100, gstPct: 0, stock: 0, unit: 'KGS' }, t));
  return { t, vendor, buyer, item, exempt };
}
const bill = (t, vendor, item, extra = {}) => call('POST', '/purchases', { partyId: vendor.id, supplierBillNo: `V-${++seq}`, date: '2026-10-07', lines: [{ itemId: item.id, qty: 1, rate: 1000, gstPct: 18 }], ...extra }, t);

test('a reverse-charge bill owes the vendor only the taxable value and books the tax as liability and credit', async () => {
  const { t, vendor, item } = await world();
  const b = await ok(bill(t, vendor, item, { reverseCharge: true }));
  assert.deepEqual([Number(b.total), Number(b.taxable), Number(b.cgst), Number(b.sgst), b.reverseCharge], [1000, 1000, 90, 90, true]);
  const g = await ok(call('GET', '/gst/gstr3b?period=2026-10', undefined, t));
  assert.deepEqual([g.outward.inwardReverseCharge.taxable, g.outward.inwardReverseCharge.cgst, g.outward.inwardReverseCharge.sgst], [1000, 90, 90]);   // 3.1(d)
  assert.deepEqual([g.itc.reverseCharge.cgst, g.itc.net.cgst], [90, 90]);                                              // 4A(3)
  assert.deepEqual([g.liability.cashPayable.cgst, g.liability.cashPayable.sgst, g.liability.cashTotal], [90, 90, 180]);  // paid in cash
  assert.equal(g.reconciliation.ok, true, JSON.stringify(g.reconciliation));
  assert.equal(g.warnings.filter((w) => /ITC not claimed/.test(w)).length, 0);
  // and the file for the portal: 3.1(d), the 4A(3) credit (ISRC) and the net credit
  const exp = await ok(call('GET', '/filing/export/GSTR3B?period=2026-10', undefined, t));
  const p = exp.payload;
  assert.deepEqual([p.sup_details.isup_rev.txval, p.sup_details.isup_rev.camt, p.sup_details.isup_rev.samt], [1000, 90, 90]);
  assert.deepEqual(p.itc_elg.itc_avl.filter((x) => x.camt).map((x) => [x.ty, x.camt, x.samt]), [['ISRC', 90, 90]]);
  assert.deepEqual([p.itc_elg.itc_net.camt, p.itc_elg.itc_net.samt], [90, 90]);
  assert.equal(exp.summary.cashPayable, 180);
});

test('a normal bill is unchanged; reverse-charge credit can be set against ordinary output, but the tax itself is paid in cash', async () => {
  const { t, vendor, buyer, item } = await world();
  await ok(call('POST', '/items', { name: 'Widget', hsn: '8471', rate: 1000, gstPct: 18, stock: 100, unit: 'Nos' }, t));
  const widget = (await ok(call('GET', '/items', undefined, t))).find((i) => i.name === 'Widget');
  await ok(call('POST', '/invoices', { partyId: buyer.id, date: '2026-10-07', lines: [{ itemId: widget.id, qty: 1 }] }, t));     // output 90 + 90
  await ok(bill(t, vendor, item, { reverseCharge: true }));                                                               // rcm 90 + 90, credit 90 + 90
  const g = await ok(call('GET', '/gst/gstr3b?period=2026-10', undefined, t));
  assert.deepEqual([g.liability.output.cgst, g.liability.reverseCharge.cgst], [180, 90]);           // 90 ordinary + 90 reverse charge
  assert.deepEqual([g.liability.cashPayable.cgst, g.liability.cashPayable.sgst], [90, 90]);           // the credit cleared the ordinary 90; the reverse-charge 90 is cash
  assert.equal(g.liability.itcCarryForward.cgst, 0);
  assert.equal(g.reconciliation.ok, true, JSON.stringify(g.reconciliation));
  const normal = await ok(bill(t, vendor, item));
  assert.equal(normal.reverseCharge, false);
  assert.equal(Number(normal.total), 1180);
});

test('reverse charge needs tax to assess, and such a bill cannot be returned like an ordinary one', async () => {
  const { t, vendor, item, exempt } = await world();
  const r = await call('POST', '/purchases', { partyId: vendor.id, supplierBillNo: 'Z-1', date: '2026-10-07', reverseCharge: true, lines: [{ itemId: exempt.id, qty: 1, rate: 100, gstPct: 0 }] }, t);
  assert.equal(r.status, 400);
  const b = await ok(bill(t, vendor, item, { reverseCharge: true }));
  const ret = await call('POST', `/purchases/${b.id}/returns`, { date: '2026-10-08', full: true }, t);
  assert.equal(ret.status, 400);
  assert.match(ret.body.error, /reverse charge/i);
});
