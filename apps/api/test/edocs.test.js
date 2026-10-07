import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { SIM_OTP, simulatedGsp } from '../src/gsp.js';
import { gstinCheckChar } from '../src/gstin.js';
import { buildEinvoice, buildEwb, ewbDays } from '../src/einvoice.js';
import { addDays } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
const G = { me: gstin('29ABCDE1234F1Z'), local: gstin('29BBBBB1111B1Z'), far: gstin('27CCCCC2222C1Z'), transporter: gstin('29TTTTT3333T1Z') };

// ---------- pure builders ----------
const company = { gstin: G.me, name: 'Demo Traders', legal_name: 'Demo Traders Pvt Ltd', trade_name: 'Demo Traders', state_code: '29', addr1: '12 MG Road', addr2: null, loc: 'Bengaluru', pin: '560001', phone: '9876543210', email: 'a@demo.in' };
const buyer = (o = {}) => ({ gstin: G.local, name: 'Local Buyer', state_code: '29', addr1: '5 Brigade Road', loc: 'Bengaluru', pin: '560025', phone: null, email: null, ...o });
const units = new Map([[1, 'Nos'], [2, 'Nos'], [3, 'Kgs']]);
const line = (o) => ({ item_id: 1, description: 'A', hsn: '8471', qty: 2, rate: 1000, gst_pct: 18, taxable: 2000, ...o });
const lines = [line({}), line({ item_id: 2, description: 'B', hsn: '6109', qty: 4, rate: 500, gst_pct: 12, taxable: 2000 })];
const inv = (o = {}) => ({ number: 'INV-0001', date: '2026-09-10', total: 4600, place_of_supply: '29', ...o });
const einv = (o = {}) => buildEinvoice({ type: 'INV', company, party: buyer(), doc: inv(), lines, units, ...o });

test('e-invoice payload: intra-state invoice in the INV-01 structure with exact figures', () => {
  const { payload: p, errors } = einv();
  assert.deepEqual(errors, []);
  assert.equal(p.Version, '1.1');
  assert.deepEqual(p.TranDtls, { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' });
  assert.deepEqual(p.DocDtls, { Typ: 'INV', No: 'INV-0001', Dt: '10/09/2026' });
  assert.deepEqual(p.SellerDtls, { Gstin: G.me, LglNm: 'Demo Traders Pvt Ltd', TrdNm: 'Demo Traders', Addr1: '12 MG Road', Loc: 'Bengaluru', Pin: 560001, Stcd: '29', Ph: '9876543210', Em: 'a@demo.in' });
  assert.deepEqual(p.BuyerDtls, { Gstin: G.local, LglNm: 'Local Buyer', TrdNm: 'Local Buyer', Pos: '29', Addr1: '5 Brigade Road', Loc: 'Bengaluru', Pin: 560025, Stcd: '29' });
  assert.deepEqual(p.ItemList[0], { SlNo: '1', PrdDesc: 'A', IsServc: 'N', HsnCd: '8471', Qty: 2, Unit: 'NOS', UnitPrice: 1000, TotAmt: 2000, Discount: 0, PreTaxVal: 2000, AssAmt: 2000, GstRt: 18,
    IgstAmt: 0, CgstAmt: 180, SgstAmt: 180, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: 2360 });
  assert.deepEqual([p.ItemList[1].SlNo, p.ItemList[1].CgstAmt, p.ItemList[1].TotItemVal], ['2', 120, 2240]);
  assert.deepEqual(p.ValDtls, { AssVal: 4000, CgstVal: 300, SgstVal: 300, IgstVal: 0, CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: 4600 });
  assert.equal(p.RefDtls, undefined);
});

test('e-invoice payload: inter-state uses IGST; services are flagged; units map to GST codes', () => {
  const far = buyer({ gstin: G.far, state_code: '27', pin: '400001', loc: 'Mumbai' });
  const l = [line({}), line({ item_id: 3, description: 'Consulting', hsn: '998313', qty: 1, rate: 500, gst_pct: 18, taxable: 500 })];
  const { payload: p, errors } = buildEinvoice({ type: 'INV', company, party: far, doc: inv({ place_of_supply: '27', total: 2950 }), lines: l, units });
  assert.deepEqual(errors, []);
  assert.deepEqual([p.BuyerDtls.Pos, p.BuyerDtls.Stcd, p.ItemList[0].IgstAmt, p.ItemList[0].CgstAmt], ['27', '27', 360, 0]);
  assert.deepEqual([p.ItemList[1].IsServc, p.ItemList[1].Unit, p.ItemList[1].IgstAmt], ['Y', 'KGS', 90]);
  assert.deepEqual([p.ValDtls.AssVal, p.ValDtls.IgstVal, p.ValDtls.TotInvVal], [2500, 450, 2950]);
});

test('e-invoice checks: what the IRP would refuse is an error; what it might refuse is a warning', () => {
  const msg = (o) => einv(o).errors.join(' | ');
  assert.match(msg({ party: buyer({ gstin: null }) }), /Only B2B/);
  assert.match(msg({ party: buyer({ addr1: null, loc: null, pin: null }) }), /The buyer: address line 1.*town.*PIN code/);
  assert.match(msg({ party: buyer({ pin: '12345' }) }), /PIN code "12345" is not a valid 6-digit PIN/);
  assert.match(msg({ company: { ...company, addr1: '', pin: null } }), /Your business: address line 1.*Add it under Business details/);
  assert.match(msg({ lines: [line({ hsn: null })] }), /HSN\/SAC code is missing/);
  assert.match(msg({ lines: [line({ gst_pct: 13 })] }), /13% is not a GST rate/);
  assert.match(msg({ doc: inv({ number: 'INV/2026-27/000000001' }) }), /not acceptable to the IRP/);
  assert.match(msg({ lines: [] }), /no lines/);
  assert.match(msg({ doc: inv({ total: 4602 }) }), /differs from its lines by more than ₹1/);
  assert.deepEqual(einv({ doc: inv({ total: 4600.5 }) }).payload.ValDtls.RndOffAmt, 0.5, 'a rounding difference under ₹1 is carried as RndOffAmt');

  const w = (o) => einv(o).warnings.join(' | ');
  assert.match(w({ party: buyer({ gstin: G.local.slice(0, 14) + (G.local[14] === 'A' ? 'B' : 'A') }) }), /fails the check-digit test/);
  assert.match(w({}), /12% and 28% slabs were retired/, 'the 12% line on a September 2026 invoice');
  assert.doesNotMatch(w({ doc: inv({ date: '2025-06-10' }) }), /retired/);
  assert.match(w({ today: '2026-11-15' }), /more than 30 days old/);
  assert.doesNotMatch(w({ today: '2026-09-20' }), /30 days/);
  assert.match(w({ units: new Map([[1, 'Widgets'], [2, 'Nos']]) }), /Unit "Widgets".*OTH/);
});

test('credit note: refers to the invoice; value-only adjustments are sent with quantity 1', () => {
  const note = { number: 'CN-0001', date: '2026-09-20', total: 1180, doc_pos: '29' };
  const nl = [{ item_id: 1, description: 'A', hsn: '8471', qty: 1, rate: 1000, gst_pct: 18, taxable: 1000 }];
  const ok = buildEinvoice({ type: 'CRN', company, party: buyer(), doc: note, lines: nl, against: { number: 'INV-0001', date: '2026-09-10' }, units });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.payload.DocDtls, { Typ: 'CRN', No: 'CN-0001', Dt: '20/09/2026' });
  assert.deepEqual(ok.payload.RefDtls, { PrecDocDtls: [{ InvNo: 'INV-0001', InvDt: '10/09/2026' }] });
  assert.deepEqual([ok.payload.ValDtls.CgstVal, ok.payload.ValDtls.TotInvVal], [90, 1180]);

  assert.match(buildEinvoice({ type: 'CRN', company, party: buyer(), doc: note, lines: nl, units }).errors.join(), /must refer to the invoice/);
  const v = buildEinvoice({ type: 'CRN', company, party: buyer(), doc: { ...note, total: 11800 }, lines: [{ ...nl[0], qty: null, taxable: 10000 }], against: { number: 'INV-0001', date: '2026-09-10' }, units });
  assert.deepEqual([v.payload.ItemList[0].Qty, v.payload.ItemList[0].UnitPrice, v.payload.ItemList[0].AssAmt], [1, 10000, 10000]);
  assert.match(v.warnings.join(), /value-only adjustment/);
});

test('e-way bill: validity rules, payload and the checks the portal applies', () => {
  assert.deepEqual([0, 1, 200, 201, 400, 450, 4000].map((k) => ewbDays(k)), [1, 1, 1, 2, 2, 3, 20]);
  assert.deepEqual([ewbDays(20, true), ewbDays(21, true), ewbDays(25, true)], [1, 2, 2]);

  const far = buyer({ gstin: G.far, state_code: '27', pin: '400001', loc: 'Mumbai' });
  const farInv = inv({ place_of_supply: '27', total: 295000, taxable: 250000 });
  const farLines = [line({ qty: 1, rate: 250000, taxable: 250000 })];
  const t = { mode: 1, distance: 980, vehicleNo: 'KA01AB1234', vehicleType: 'R' };
  const ok = buildEwb({ company, party: far, invoice: farInv, lines: farLines, units, transport: t });
  assert.deepEqual(ok.errors, []);
  const p = ok.payload;
  assert.deepEqual([p.supplyType, p.subSupplyType, p.docType, p.docNo, p.docDate, p.transactionType], ['O', 1, 'INV', 'INV-0001', '10/09/2026', 1]);
  assert.deepEqual([p.fromGstin, p.fromPincode, p.fromStateCode, p.toGstin, p.toPincode, p.toStateCode], [G.me, 560001, 29, G.far, 400001, 27]);
  assert.deepEqual([p.totalValue, p.igstValue, p.cgstValue, p.totInvValue, p.transMode, p.transDistance, p.vehicleNo, p.vehicleType], [250000, 45000, 0, 295000, 1, 980, 'KA01AB1234', 'R']);
  assert.deepEqual(p.itemList[0], { productName: 'A', productDesc: 'A', hsnCode: 8471, quantity: 1, qtyUnit: 'NOS', taxableAmount: 250000, sgstRate: 0, cgstRate: 0, igstRate: 18, cessRate: 0 });

  const intra = buildEwb({ company, party: buyer(), invoice: inv({ total: 60000 }), lines: [line({ qty: 30, taxable: 50847.46, gst_pct: 18 })], units, transport: t }).payload.itemList[0];
  assert.deepEqual([intra.cgstRate, intra.sgstRate, intra.igstRate], [9, 9, 0]);

  const errs = (tr, extra = {}) => buildEwb({ company, party: far, invoice: farInv, lines: farLines, units, transport: tr, ...extra }).errors.join(' | ');
  assert.match(errs({ distance: 10 }), /mode of transport/);
  assert.match(errs({ mode: 1, distance: 5000, vehicleNo: 'KA01AB1234' }), /between 0 and 4000/);
  assert.match(errs({ mode: 1, distance: 10, vehicleNo: 'BAD' }), /not in the usual format/);
  assert.match(errs({ mode: 1, distance: 10 }), /vehicle number, or a transporter ID/);
  assert.match(errs({ mode: 3, distance: 10 }), /transport document number and date/);
  assert.match(errs({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234' }, { party: far }), /^$/);
  assert.match(errs({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234' }, { party: buyer({ pin: null }) }), /The buyer: PIN code/);
  assert.match(errs({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234' }, { lines: [line({ hsn: '998313' })] }), /E-way bills are for goods/);

  const warns = (tr, extra = {}) => buildEwb({ company, party: far, invoice: farInv, lines: farLines, units, transport: tr, ...extra }).warnings.join(' | ');
  assert.match(warns({ mode: 1, distance: 10, transporterId: G.transporter }), /transporter must add it \(Part B\)/);
  assert.match(warns({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234' }, { invoice: inv({ total: 30000, place_of_supply: '27' }) }), /not mandatory/);
  assert.match(warns({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234', transporterId: G.transporter.slice(0, 14) + 'Q' }), /transporter ID.*check-digit/);
  assert.match(warns({ mode: 1, distance: 10, vehicleNo: 'KA01AB1234' }, { lines: [line({ qty: 1, taxable: 250000 }), line({ hsn: '998313', description: 'Install', taxable: 100 })] }), /Service lines.*left out/);
});

// ---------- API ----------
let pool, sim, call, seq = 0;
const today = todayFn();

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  sim = simulatedGsp();
  const server = createApp(pool, { gateway: mockProvider(), gsp: sim }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});

const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };

/** A GST-registered company with a full profile, items, a local B2B buyer, a far B2B buyer and a B2C buyer. */
async function world({ profile = true } = {}) {
  const n = ++seq;
  const me = gstin(`29ZYXWV${String(1000 + n).padStart(4, '0')}Q1Z`);
  const t = (await call('POST', '/auth/register', { name: 'E', email: `edoc${n}@example.com`, password: 'password123', company: `E-doc Co ${n}`, sector: 'trading', gstin: me }, null)).body.token;
  if (profile) await ok(call('PUT', '/company/profile', { legalName: `E-doc Co ${n} Pvt Ltd`, addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001', phone: '9876543210', email: 'a@demo.in' }, t));
  const it = await ok(call('POST', '/items', { name: 'Laptop', hsn: '8471', rate: 60000, gstPct: 18, stock: 100 }, t));
  const party = (name, extra) => ok(call('POST', '/parties', { type: 'customer', name, ...extra }, t));
  const local = await party('Local Buyer', { gstin: G.local });
  const far = await party('Far Buyer', { gstin: G.far });
  const b2c = await party('Walk-in', { stateCode: '29' });
  for (const [p, a] of [[local, { addr1: '5 Brigade Road', loc: 'Bengaluru', pin: '560025' }], [far, { addr1: '1 Marine Drive', loc: 'Mumbai', pin: '400001' }]]) await ok(call('PUT', `/parties/${p.id}`, a, t));
  const sale = (partyId, qty = 1, date = '2026-09-10') => ok(call('POST', '/invoices', { partyId, date, lines: [{ itemId: it.id, qty }] }, t));
  return { t, me, it, local, far, b2c, sale };
}
const connect = async (t) => { await ok(call('POST', '/filing/gsp/otp', { username: 'u1' }, t)); await ok(call('POST', '/filing/gsp/session', { otp: SIM_OTP }, t)); };
const prepInv = (t, docId, type = 'INV') => call('POST', '/einvoice/prepare', { type, docId }, t);
const gen = (t, id) => call('POST', `/einvoice/${id}/generate`, {}, t);
const road = { mode: 1, distance: 450, vehicleNo: 'KA01AB1234' };

test('business profile and party details: validation, ownership, isolation', async () => {
  const w = await world({ profile: false });
  assert.equal((await call('PUT', '/company/profile', { pin: '12345' }, w.t)).status, 400);
  assert.equal((await call('PUT', '/company/profile', { phone: 'abc' }, w.t)).status, 400);
  assert.equal((await call('PUT', '/company/profile', {}, w.t)).status, 400);
  const p = await ok(call('PUT', '/company/profile', { legalName: 'Acme Pvt Ltd', addr1: '1 Street', loc: 'Mysuru', pin: '570001', addr2: '' }, w.t));
  assert.deepEqual([p.legalName, p.pin, p.addr2], ['Acme Pvt Ltd', '570001', null], 'a blank field clears it');
  assert.equal((await call('GET', '/company/profile', undefined, w.t)).body.loc, 'Mysuru');

  assert.equal((await call('PUT', `/parties/${w.local.id}`, { pin: 'abc' }, w.t)).status, 400);
  const kept = await ok(call('PUT', `/parties/${w.local.id}`, { phone: '9000000001' }, w.t));
  assert.deepEqual([kept.gstin, kept.addr1, kept.phone], [G.local, '5 Brigade Road', '9000000001'], 'other fields survive; the GSTIN is not editable here');
  const other = (await world()).t;
  assert.equal((await call('PUT', `/parties/${w.local.id}`, { addr1: 'Hacked' }, other)).status, 404);
  assert.equal((await call('PUT', '/company/profile', { addr1: 'x'.repeat(101) }, w.t)).status, 400);
});

test('settings: e-invoicing needs a start date; the list says which documents need an IRN', async () => {
  const w = await world();
  const s0 = (await call('GET', '/einvoice/settings', undefined, w.t)).body;
  assert.deepEqual([s0.enabled, s0.applicableFrom, s0.ewbThreshold, s0.suggested], [false, null, 50000, false]);
  assert.equal((await call('PUT', '/einvoice/settings', { enabled: true }, w.t)).status, 400);
  await ok(call('PUT', '/einvoice/settings', { enabled: true, applicableFrom: '2026-09-01', ewbThreshold: 100000 }, w.t));

  const a = await w.sale(w.local.id), b = await w.sale(w.b2c.id), old = await w.sale(w.far.id, 1, '2026-08-20');
  const list = (await call('GET', '/einvoice/documents?days=400', undefined, w.t)).body;
  assert.equal(list.enabled, true);
  const by = (id) => list.documents.find((d) => d.docType === 'INV' && d.docId === id);
  assert.deepEqual([by(a.id).required, by(a.id).b2b, by(a.id).einvoice], [true, true, null]);
  assert.deepEqual([by(b.id).required, by(b.id).b2b], [false, false], 'B2C is not e-invoiced');
  assert.equal(by(old.id).required, false, 'dated before the start date');
  assert.equal(by(a.id).ewbSuggested, false, '₹70,800 is below the ₹1 lakh limit set here');
  assert.equal((await call('GET', '/einvoice/settings', undefined, w.t)).body.ewbThreshold, 100000);
});

test('IRN: prepare, fix the data, connect, generate; duplicates and non-B2B are refused', async () => {
  const w = await world();
  const bare = (await call('POST', '/parties', { type: 'customer', name: 'No address', gstin: gstin('27DDDDD4444D1Z') }, w.t)).body;
  const i1 = await w.sale(bare.id);
  const prep = await prepInv(w.t, i1.id);
  assert.equal(prep.status, 201);
  assert.match(prep.body.validation.errors.join(' '), /The buyer: address line 1/);
  const early = await gen(w.t, prep.body.id);
  assert.deepEqual([early.status, early.body.code], [409, 'VALIDATION']);

  await ok(call('PUT', `/parties/${bare.id}`, { addr1: '9 Park Street', loc: 'Mumbai', pin: '400002' }, w.t));
  const noSession = await gen(w.t, prep.body.id);
  assert.deepEqual([noSession.status, noSession.body.code], [409, 'NO_SESSION'], 'the data is fixed (it is rebuilt at generate time) but there is no portal session');

  await connect(w.t);
  const g = await ok(gen(w.t, prep.body.id));
  assert.equal(g.status, 'generated');
  assert.match(g.irn, /^[0-9a-f]{64}$/);
  assert.match(g.ackNo, /^\d{15}$/);
  assert.equal(g.simulated, true);
  assert.match(g.signedQr, /^SIMULATED\./);
  const detail = (await call('GET', `/einvoice/${g.id}`, undefined, w.t)).body;
  assert.deepEqual([detail.payload.DocDtls.No, detail.payload.BuyerDtls.Pin, detail.gsp.mode], [i1.number, 400002, 'simulated']);
  assert.deepEqual(detail.events.map((e) => e.action), ['prepared', 'generated']);

  assert.equal((await gen(w.t, g.id)).status, 409, 'already generated');
  assert.equal((await prepInv(w.t, i1.id)).status, 409);
  const b2c = await prepInv(w.t, (await w.sale(w.b2c.id)).id);
  assert.match(b2c.body.validation.errors.join(' '), /Only B2B/);
  assert.equal((await gen(w.t, b2c.body.id)).status, 409);
  assert.equal((await prepInv(w.t, 999999)).status, 404);

  const docs = (await call('GET', '/einvoice/documents', undefined, w.t)).body.documents;
  assert.equal(docs.find((d) => d.docId === i1.id && d.docType === 'INV').einvoice.status, 'generated');
});

test('the IRP rejects what the data cannot fix: a GSTIN with a bad check character', async () => {
  const w = await world();
  const badGstin = G.far.slice(0, 14) + (G.far[14] === 'A' ? 'B' : 'A');
  const bad = (await call('POST', '/parties', { type: 'customer', name: 'Typo Buyer', gstin: badGstin }, w.t)).body;
  await ok(call('PUT', `/parties/${bad.id}`, { addr1: '1 Road', loc: 'Mumbai', pin: '400001' }, w.t));
  await connect(w.t);
  const p = await ok(prepInv(w.t, (await w.sale(bad.id)).id));
  assert.match(p.validation.warnings.join(' '), /fails the check-digit test/);
  const r = await gen(w.t, p.id);
  assert.equal(r.status, 400);
  const d = (await call('GET', `/einvoice/${p.id}`, undefined, w.t)).body;
  assert.deepEqual([d.status, d.gspErrors[0].code], ['failed', '3028']);
  assert.match(d.gspErrors[0].message, /Invalid buyer GSTIN/);
  assert.ok(d.events.some((e) => e.action === 'rejected'));
  assert.equal((await prepInv(w.t, d.docId)).status, 200, 'a failed document can be prepared again');
});

test('cancelling an IRN: within 24 hours only, once, and the document number cannot be reused', async () => {
  const w = await world();
  await connect(w.t);
  const a = await ok(prepInv(w.t, (await w.sale(w.local.id)).id));
  const g = await ok(gen(w.t, a.id));
  assert.equal((await call('POST', `/einvoice/${g.id}/cancel`, { reason: 7 }, w.t)).status, 400);
  const c = await ok(call('POST', `/einvoice/${g.id}/cancel`, { reason: 2, remarks: 'Wrong buyer' }, w.t));
  assert.deepEqual([c.status, c.cancelReason], ['cancelled', 'Data entry mistake: Wrong buyer']);
  assert.equal((await call('POST', `/einvoice/${g.id}/cancel`, { reason: 2 }, w.t)).status, 409);
  const again = await prepInv(w.t, g.docId);
  assert.deepEqual([again.status, again.body.code], [409, 'IRN_CANCELLED']);

  const b = await ok(prepInv(w.t, (await w.sale(w.local.id)).id));
  const g2 = await ok(gen(w.t, b.id));
  sim._backdate('irn', g2.irn, 25);
  const late = await call('POST', `/einvoice/${g2.id}/cancel`, { reason: 1 }, w.t);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /within 24 hours/);
  assert.equal((await call('GET', `/einvoice/${g2.id}`, undefined, w.t)).body.status, 'generated', 'a refused cancellation changes nothing');
});

test('credit note e-invoice: refers to the original invoice; a B2C note is not e-invoiced', async () => {
  const w = await world();
  await connect(w.t);
  const inv1 = await w.sale(w.local.id, 3);
  const lineId = (await ok(call('GET', `/invoices/${inv1.id}/returnable`, undefined, w.t))).lines[0].id;
  const note = await ok(call('POST', `/invoices/${inv1.id}/returns`, { date: '2026-09-20', lines: [{ lineId, qty: 1 }] }, w.t));
  const p = await ok(prepInv(w.t, note.id, 'CRN'));
  assert.deepEqual(p.validation.errors, []);
  const g = await ok(gen(w.t, p.id));
  const d = (await call('GET', `/einvoice/${g.id}`, undefined, w.t)).body;
  assert.deepEqual([d.payload.DocDtls.Typ, d.payload.DocDtls.Dt, d.payload.RefDtls.PrecDocDtls[0].InvNo, d.payload.ValDtls.TotInvVal], ['CRN', '20/09/2026', inv1.number, 70800]);

  const c = await w.sale(w.b2c.id, 2);
  const lid = (await ok(call('GET', `/invoices/${c.id}/returnable`, undefined, w.t))).lines[0].id;
  const cn = await ok(call('POST', `/invoices/${c.id}/returns`, { date: '2026-09-21', lines: [{ lineId: lid, qty: 1 }] }, w.t));
  assert.match((await prepInv(w.t, cn.id, 'CRN')).body.validation.errors.join(), /Only B2B/);
  assert.equal((await prepInv(w.t, 999999, 'CRN')).status, 404);
  const docs = (await call('GET', '/einvoice/documents', undefined, w.t)).body.documents;
  assert.ok(docs.some((x) => x.docType === 'CRN' && x.number === note.number && x.against === inv1.number));
});

test('e-way bill: prepare, generate, validity, vehicle update, cancel and a fresh one', async () => {
  const w = await world();
  const i = await w.sale(w.far.id, 5);                       // ₹3,54,000
  const noVeh = await call('POST', '/ewb/prepare', { invoiceId: i.id, transport: { mode: 1, distance: 450 } }, w.t);
  assert.equal(noVeh.status, 201);
  assert.match(noVeh.body.validation.errors.join(), /vehicle number, or a transporter ID/);
  assert.equal((await call('POST', `/ewb/${noVeh.body.id}/generate`, {}, w.t)).body.code, 'VALIDATION');

  const docs = (await call('GET', '/einvoice/documents', undefined, w.t)).body.documents;
  assert.equal(docs.find((d) => d.docId === i.id && d.docType === 'INV').ewbSuggested, false, 'a draft already exists');

  await connect(w.t);
  const p = await ok(call('POST', '/ewb/prepare', { invoiceId: i.id, transport: road }, w.t));
  assert.equal(p.id, noVeh.body.id, 'the draft is updated, not duplicated');
  assert.deepEqual(p.validation.errors, []);
  const g = await ok(call('POST', `/ewb/${p.id}/generate`, {}, w.t));
  assert.equal(g.status, 'generated');
  assert.match(g.ewbNo, /^\d{12}$/);
  // 450 km = 3 days; valid to the end of the third day after generation
  assert.equal(g.validUpto.slice(0, 10), addDays(new Date(g.ewbDate).toISOString().slice(0, 10), 3));
  assert.match(g.validUpto, /T23:59:00/);

  assert.equal((await call('POST', '/ewb/prepare', { invoiceId: i.id, transport: road }, w.t)).status, 409, 'one live e-way bill per invoice');
  assert.equal((await call('POST', `/ewb/${g.id}/generate`, {}, w.t)).status, 409);

  assert.equal((await call('POST', `/ewb/${g.id}/vehicle`, { vehicleNo: 'BAD' }, w.t)).status, 400);
  const v = await ok(call('POST', `/ewb/${g.id}/vehicle`, { vehicleNo: 'ka01cd5678', reason: 1 }, w.t));
  assert.equal(v.vehicleNo, 'KA01CD5678');
  assert.equal((await call('GET', `/ewb/${g.id}`, undefined, w.t)).body.payload.vehicleNo, 'KA01CD5678');

  const c = await ok(call('POST', `/ewb/${g.id}/cancel`, { reason: 3 }, w.t));
  assert.deepEqual([c.status, c.cancelReason], ['cancelled', 'Data entry mistake']);
  assert.equal((await call('POST', `/ewb/${g.id}/cancel`, { reason: 3 }, w.t)).status, 409);
  assert.equal((await call('POST', `/ewb/${g.id}/vehicle`, { vehicleNo: 'KA01CD5678' }, w.t)).status, 409);

  const again = await ok(call('POST', '/ewb/prepare', { invoiceId: i.id, transport: road }, w.t));
  assert.notEqual(again.id, g.id, 'a new e-way bill after cancelling');
  const g2 = await ok(call('POST', `/ewb/${again.id}/generate`, {}, w.t));
  assert.notEqual(g2.ewbNo, g.ewbNo);
  assert.deepEqual((await call('GET', '/ewb', undefined, w.t)).body.map((x) => [x.status, x.invoiceNumber]), [['generated', i.number], ['cancelled', i.number]]);
});

test('e-way bill: transporter-only Part B, over-dimensional cargo, cancel window, goods only', async () => {
  const w = await world();
  await connect(w.t);
  const a = await w.sale(w.far.id), b = await w.sale(w.local.id), c = await w.sale(w.far.id, 2);

  const t1 = await ok(call('POST', '/ewb/prepare', { invoiceId: a.id, transport: { mode: 1, distance: 100, transporterId: G.transporter, transporterName: 'Fast Cargo' } }, w.t));
  assert.match(t1.validation.warnings.join(), /Part B/);
  const g1 = await ok(call('POST', `/ewb/${t1.id}/generate`, {}, w.t));
  assert.equal(g1.vehicleNo, null);
  assert.equal((await ok(call('POST', `/ewb/${g1.id}/vehicle`, { vehicleNo: 'TS09EZ0001' }, w.t))).vehicleNo, 'TS09EZ0001', 'the vehicle is added later');

  // 25 km of over-dimensional cargo: one day per 20 km -> 2 days
  const o = await ok(call('POST', '/ewb/prepare', { invoiceId: b.id, transport: { mode: 1, distance: 25, vehicleNo: 'KA01AB1234', vehicleType: 'O' } }, w.t));
  const go = await ok(call('POST', `/ewb/${o.id}/generate`, {}, w.t));
  assert.equal(go.validUpto.slice(0, 10), addDays(new Date(go.ewbDate).toISOString().slice(0, 10), 2));

  // the 24-hour window for cancellation
  const p = await ok(call('POST', '/ewb/prepare', { invoiceId: c.id, transport: road }, w.t));
  const gc = await ok(call('POST', `/ewb/${p.id}/generate`, {}, w.t));
  sim._backdate('ewb', gc.ewbNo, 25);
  const late = await call('POST', `/ewb/${gc.id}/cancel`, { reason: 1 }, w.t);
  assert.deepEqual([late.status, /within 24 hours/.test(late.body.error)], [409, true]);
  assert.equal((await call('GET', `/ewb/${gc.id}`, undefined, w.t)).body.status, 'generated');

  // invoices of services only
  const svc = await ok(call('POST', '/items', { name: 'Consulting', hsn: '998313', rate: 100000, gstPct: 18, stock: 10 }, w.t));
  const si = await ok(call('POST', '/invoices', { partyId: w.far.id, date: '2026-09-10', lines: [{ itemId: svc.id, qty: 1 }] }, w.t));
  assert.match((await call('POST', '/ewb/prepare', { invoiceId: si.id, transport: road }, w.t)).body.validation.errors.join(), /E-way bills are for goods/);
});

test('without a GSP, a session, or ownership; isolation; the 40% slab; GSTR-1 warns about IRP invoices', async () => {
  const w = await world();
  const i = await w.sale(w.local.id);
  const p = await ok(prepInv(w.t, i.id));
  assert.equal((await gen(w.t, p.id)).body.code, 'NO_SESSION');
  assert.equal((await call('POST', '/ewb/prepare', { invoiceId: i.id, transport: road }, w.t)).status, 201);

  const other = (await world()).t;
  assert.equal((await call('GET', `/einvoice/${p.id}`, undefined, other)).status, 404);
  assert.equal((await gen(other, p.id)).status, 404);
  assert.equal((await call('POST', '/ewb/prepare', { invoiceId: i.id, transport: road }, other)).status, 404);
  assert.equal((await call('GET', '/ewb', undefined, other)).body.length, 0);

  assert.equal((await call('POST', '/items', { name: 'Luxury', hsn: '8703', rate: 1000, gstPct: 40, stock: 1 }, w.t)).status, 201, 'the 40% slab is accepted');

  await connect(w.t);
  await ok(gen(w.t, p.id));
  const e = (await call('GET', '/filing/export/GSTR1?period=2026-09', undefined, w.t)).body;
  assert.match(e.warnings.join(' '), /1 invoice\(s\) were reported to the IRP/);

  const { Pool } = newDb().adapters.createPg();
  const p2 = new Pool();
  await migrate(p2);
  const server = createApp(p2, { gateway: null, gsp: null }).listen(0);
  server.unref();
  const c2 = async (m, path, b, tok) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const tok = (await c2('POST', '/auth/register', { name: 'N', email: 'nogsp-e@example.com', password: 'password123', company: 'No GSP', sector: 'retail', gstin: G.me }, null)).body.token;
  assert.equal((await c2('GET', '/einvoice/documents', undefined, tok)).status, 200, 'listing needs no GSP');
  const it = (await c2('POST', '/items', { name: 'X', hsn: '8471', rate: 100, gstPct: 18, stock: 5 }, tok)).body;
  const cu = (await c2('POST', '/parties', { type: 'customer', name: 'C', gstin: G.local }, tok)).body;
  const iv = (await c2('POST', '/invoices', { partyId: cu.id, date: '2026-09-10', lines: [{ itemId: it.id, qty: 1 }] }, tok)).body;
  await c2('PUT', '/company/profile', { addr1: '1 Road', loc: 'Bengaluru', pin: '560001' }, tok);
  await c2('PUT', `/parties/${cu.id}`, { addr1: '2 Road', loc: 'Bengaluru', pin: '560002' }, tok);
  const prep = await c2('POST', '/einvoice/prepare', { type: 'INV', docId: iv.id }, tok);
  assert.equal(prep.status, 201);
  assert.equal((await c2('POST', `/einvoice/${prep.body.id}/generate`, {}, tok)).body.code, 'NO_GSP');
});
