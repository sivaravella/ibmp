import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { SIM_OTP, resolveGsp, simulatedGsp } from '../src/gsp.js';
import { gstinCheckChar, gstinValid, panOfGstin, uqcFor } from '../src/gstin.js';
import { decrypt, encrypt } from '../src/secrets.js';
import { today as todayFn } from '../src/util.js';

const gstin = (first14) => first14 + gstinCheckChar(first14);
const GSTIN = { me: gstin('29ABCDE1234F1Z'), r1: gstin('29BBBBB1111B1Z'), r2: gstin('27CCCCC2222C1Z'), vendor: gstin('29AAAAA0000A1Z') };
const P = '2026-09';
let pool, call, seq = 0;

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok, raw = false) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return raw ? r : { status: r.status, body: await r.json() };
  };
});
after(() => { delete process.env.NODE_ENV; });

const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const reg = async (extra = {}) => (await call('POST', '/auth/register', { name: 'F', email: `filing${++seq}@example.com`, password: 'password123', company: `Filing Co ${seq}`, sector: 'trading', ...extra }, null)).body.token;

/** The full September scenario: B2B, B2C large and small, nil-rated, three kinds of credit note, a debit note, an unregistered vendor, and an October invoice. */
async function scenario() {
  const t = await reg({ gstin: GSTIN.me });
  const item = async (name, hsn, rate, gstPct, stock) => ok(call('POST', '/items', { name, hsn, rate, gstPct, stock }, t));
  const A = await item('A', '8471', 1000, 18, 0), B = await item('B', '6109', 500, 12, 0), C = await item('C', '1001', 100, 0, 100);
  const party = (type, name, extra) => ok(call('POST', '/parties', { type, name, ...extra }, t));
  const v1 = await party('vendor', 'Reg Vendor', { gstin: GSTIN.vendor }), v2 = await party('vendor', 'Unreg Vendor', { stateCode: '29' });
  const r1 = await party('customer', 'Reg Local', { gstin: GSTIN.r1 }), r2 = await party('customer', 'Reg Inter', { gstin: GSTIN.r2 });
  const u1 = await party('customer', 'Unreg Local', { stateCode: '29' }), u2 = await party('customer', 'Unreg Inter', { stateCode: '27' });
  const bill1 = await ok(call('POST', '/purchases', { partyId: v1.id, supplierBillNo: 'V1', date: '2026-09-02', lines: [{ itemId: A.id, qty: 20, rate: 600 }, { itemId: B.id, qty: 50, rate: 300 }] }, t));
  await ok(call('POST', '/purchases', { partyId: v2.id, supplierBillNo: 'V2', date: '2026-09-03', lines: [{ itemId: B.id, qty: 10, rate: 300 }] }, t));
  const sale = (partyId, lines, date = '2026-09-10') => ok(call('POST', '/invoices', { partyId, date, lines }, t));
  const s1 = await sale(r1.id, [{ itemId: A.id, qty: 2 }, { itemId: B.id, qty: 4 }]);
  await sale(r2.id, [{ itemId: A.id, qty: 1 }]);
  const s3 = await sale(u1.id, [{ itemId: B.id, qty: 2 }]);
  await sale(u2.id, [{ itemId: B.id, qty: 4 }]);
  const s5 = await sale(u2.id, [{ itemId: A.id, qty: 1, rate: 250000 }]);
  await sale(u1.id, [{ itemId: C.id, qty: 10 }]);
  await sale(u1.id, [{ itemId: B.id, qty: 1 }], '2026-10-02');
  const line = async (kind, id, name) => (await ok(call('GET', `/${kind}/${id}/returnable`, undefined, t))).lines.find((l) => l.description === name).id;
  await ok(call('POST', `/invoices/${s1.id}/returns`, { date: '2026-09-20', lines: [{ lineId: await line('invoices', s1.id, 'A'), qty: 1 }] }, t));
  await ok(call('POST', `/invoices/${s3.id}/returns`, { date: '2026-09-20', lines: [{ lineId: await line('invoices', s3.id, 'B'), qty: 1 }] }, t));
  await ok(call('POST', `/invoices/${s5.id}/returns`, { date: '2026-09-20', type: 'value', lines: [{ lineId: await line('invoices', s5.id, 'A'), amount: 10000 }] }, t));
  await ok(call('POST', `/purchases/${bill1.id}/returns`, { date: '2026-09-21', lines: [{ lineId: await line('purchases', bill1.id, 'B'), qty: 10 }] }, t));
  return { t, A, B, C, r1, r2, u1, u2 };
}

/** A small company with one September invoice to a customer, for the workflow and error-path tests. */
async function mini({ customerGstin = GSTIN.r1, invoice = true } = {}) {
  const t = await reg({ gstin: gstin(`29ZYXWV${String(1000 + seq).padStart(4, '0')}Q1Z`) });
  if (invoice) {
    const it = await ok(call('POST', '/items', { name: 'Widget', hsn: '8471', rate: 1000, gstPct: 18, stock: 50 }, t));
    const c = await ok(call('POST', '/parties', { type: 'customer', name: 'Customer', gstin: customerGstin }, t));
    await ok(call('POST', '/invoices', { partyId: c.id, date: '2026-09-10', lines: [{ itemId: it.id, qty: 2 }] }, t));
  }
  return { t, it: invoice };
}
const connect = async (t) => { await ok(call('POST', '/filing/gsp/otp', { username: 'gst.user' }, t)); await ok(call('POST', '/filing/gsp/session', { otp: SIM_OTP }, t)); };
const prepare = (t, type, period = P) => call('POST', '/filing/returns', { type, period }, t);
const act = (t, id, what, body = {}) => call('POST', `/filing/returns/${id}/${what}`, body, t);

test('GSTIN check character: standard vectors, wrong characters, unit codes', () => {
  assert.equal(gstinValid('27AAPFU0939F1ZV'), true);
  assert.equal(gstinValid('29AAGCB7383J1Z4'), true);
  assert.equal(gstinValid('27AAPFU0939F1ZX'), false, 'wrong check character');
  assert.equal(gstinValid('29ABCDE1234F1Z5'), false, 'well-formed but not a real check character');
  assert.equal(gstinValid(GSTIN.me), true, 'one computed by gstinCheckChar');
  assert.equal(gstinValid('not a gstin'), false);
  assert.equal(panOfGstin('27AAPFU0939F1ZV'), 'AAPFU0939F');
  assert.deepEqual([uqcFor('Nos').code, uqcFor('kg').code, uqcFor('Litres').code, uqcFor('PCS').code, uqcFor('Sq. ft').code], ['NOS', 'KGS', 'LTR', 'PCS', 'SQF']);
  assert.deepEqual(uqcFor('widgets'), { code: 'OTH', exact: false });
});

test('encryption at rest: round trip, random IV, tampering is detected', () => {
  const a = encrypt('sim_token_123'), b = encrypt('sim_token_123');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'sim_token_123');
  const [iv, tag, body] = a.split('.');
  const flipped = Buffer.from(body, 'base64'); flipped[0] ^= 1;
  assert.throws(() => decrypt([iv, tag, flipped.toString('base64')].join('.')));
});

test('GSTR-1 JSON: every table in the GSTN structure with the right figures', async () => {
  const { t } = await scenario();
  const e = await ok(call('GET', `/filing/export/GSTR1?period=${P}`, undefined, t));
  assert.deepEqual(e.errors, []);
  const g = e.payload;
  assert.deepEqual([g.gstin, g.fp, g.gt, g.cur_gt], [GSTIN.me, '092026', 0, 247500], 'turnover is Sept invoices less credit notes; October is excluded');

  const inv1 = g.b2b.find((x) => x.ctin === GSTIN.r1).inv[0];
  assert.deepEqual([inv1.inum, inv1.idt, inv1.val, inv1.pos, inv1.rchrg, inv1.inv_typ], ['INV-0001', '10-09-2026', 4600, '29', 'N', 'R']);
  assert.deepEqual(inv1.itms, [
    { num: 1, itm_det: { rt: 18, txval: 2000, iamt: 0, camt: 180, samt: 180, csamt: 0 } },
    { num: 2, itm_det: { rt: 12, txval: 2000, iamt: 0, camt: 120, samt: 120, csamt: 0 } },
  ]);
  const inv2 = g.b2b.find((x) => x.ctin === GSTIN.r2).inv[0];
  assert.deepEqual([inv2.val, inv2.pos, inv2.itms[0].itm_det.iamt, inv2.itms[0].itm_det.camt], [1180, '27', 180, 0]);

  assert.deepEqual(g.b2cl, [{ pos: '27', inv: [{ inum: 'INV-0005', idt: '10-09-2026', val: 295000, itms: [{ num: 1, itm_det: { rt: 18, txval: 250000, iamt: 45000, csamt: 0 } }] }] }]);

  assert.equal(g.b2cs.length, 2, 'the nil-rated row is not a taxable supply');
  assert.deepEqual(g.b2cs.find((x) => x.sply_ty === 'INTRA'), { sply_ty: 'INTRA', pos: '29', typ: 'OE', rt: 12, txval: 500, camt: 30, samt: 30, csamt: 0 });
  assert.deepEqual(g.b2cs.find((x) => x.sply_ty === 'INTER'), { sply_ty: 'INTER', pos: '27', typ: 'OE', rt: 12, txval: 2000, iamt: 240, csamt: 0 });

  assert.deepEqual(g.nil, { inv: [{ sply_ty: 'INTRAB2C', expt_amt: 0, nil_amt: 1000, ngsup_amt: 0 }] });

  assert.deepEqual(g.cdnr, [{ ctin: GSTIN.r1, nt: [{ ntty: 'C', nt_num: 'CN-0001', nt_dt: '20-09-2026', val: 1180, pos: '29', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 18, txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 } }] }] }]);
  assert.deepEqual(g.cdnur, [{ typ: 'B2CL', ntty: 'C', nt_num: 'CN-0003', nt_dt: '20-09-2026', val: 11800, pos: '27', itms: [{ num: 1, itm_det: { rt: 18, txval: 10000, iamt: 1800, csamt: 0 } }] }]);

  const h = Object.fromEntries(g.hsn.data.map((x) => [x.hsn_sc, x]));
  assert.deepEqual(Object.keys(h), ['1001', '6109', '8471']);
  assert.deepEqual([h['8471'].uqc, h['8471'].qty, h['8471'].txval, h['8471'].iamt, h['8471'].camt, h['8471'].val], ['NOS', 3, 242000, 43380, 90, 285560]);
  assert.deepEqual([h['6109'].qty, h['6109'].txval, h['6109'].val], [9, 4500, 5040]);
  assert.deepEqual(g.hsn.data.map((x) => x.num), [1, 2, 3]);

  assert.deepEqual(g.doc_issue.doc_det, [
    { doc_num: 1, docs: [{ num: 1, from: 'INV-0001', to: 'INV-0006', totnum: 6, cancel: 0, net_issue: 6 }] },
    { doc_num: 5, docs: [{ num: 1, from: 'CN-0001', to: 'CN-0003', totnum: 3, cancel: 0, net_issue: 3 }] },
  ]);
  assert.match(e.warnings.join(' '), /nil-rated/);
  assert.match(e.warnings.join(' '), /Aggregate turnover/);
  assert.deepEqual([e.summary.taxable, e.summary.igst], [247500, 43620]);

  // downloadable file
  const f = await call('GET', `/filing/export/GSTR1?period=${P}&file=1`, undefined, t, true);
  assert.match(f.headers.get('content-disposition'), /attachment; filename="GSTR1_202609\.json"/);
  assert.deepEqual(await f.json(), g);
});

test('GSTR-3B JSON: outward supplies, inter-state to unregistered, ITC with reversal and ineligible credit', async () => {
  const { t } = await scenario();
  const e = await ok(call('GET', `/filing/export/GSTR3B?period=${P}`, undefined, t));
  const g = e.payload;
  assert.deepEqual([g.gstin, g.ret_period], [GSTIN.me, '092026']);
  assert.deepEqual(g.sup_details.osup_det, { txval: 246500, iamt: 43620, camt: 240, samt: 240, csamt: 0 });
  assert.deepEqual(g.sup_details.osup_nil_exmp, { txval: 1000 });
  assert.deepEqual(g.inter_sup.unreg_details, [{ pos: '27', txval: 242000, iamt: 43440 }]);
  const oth = (arr) => arr.find((x) => x.ty === 'OTH');
  assert.deepEqual(oth(g.itc_elg.itc_avl), { ty: 'OTH', iamt: 0, camt: 1980, samt: 1980, csamt: 0 });
  assert.equal(g.itc_elg.itc_avl.length, 5, 'all five ITC types are listed');
  assert.deepEqual([oth(g.itc_elg.itc_rev).camt, g.itc_elg.itc_net.camt, oth(g.itc_elg.itc_inelg).camt], [180, 1800, 180]);
  assert.equal(e.summary.cashPayable, 40500);
  assert.match(e.warnings.join(' '), /BILL-0002/);
  assert.match(e.warnings.join(' '), /Table 5/);
  assert.match(e.warnings.join(' '), /GSTR-1 for this month has not been filed/);
});

test('readiness checks block what the portal would refuse', async () => {
  const noGstin = await reg({ stateCode: '29' });
  let v = (await prepare(noGstin, 'GSTR1')).body.validation;
  assert.match(v.errors.join(' '), /no GSTIN/);
  assert.equal((await call('POST', '/filing/gsp/otp', { username: 'x1' }, noGstin)).status, 400);

  const { t } = await mini();
  const cur = new Date().toISOString().slice(0, 7);
  v = (await prepare(t, 'GSTR1', cur)).body.validation;
  assert.match(v.errors.join(' '), /has not ended yet/);
  const filing = (await prepare(t, 'GSTR1', cur)).body;
  assert.equal((await act(t, filing.id, 'save')).status, 409);
  assert.equal((await act(t, filing.id, 'save')).body.code, 'VALIDATION');

  await ok(call('PUT', '/compliance/settings', { gstFrequency: 'quarterly' }, t));
  assert.match((await prepare(t, 'GSTR3B')).body.validation.errors.join(' '), /Quarterly \(QRMP\)/);
  assert.equal((await call('GET', '/filing/export/GSTR1?period=2026-13', undefined, t)).status, 400);
  assert.equal((await call('POST', '/filing/returns', { type: 'GSTR2', period: P }, t)).status, 400);
});

test('GSTR-1 end to end: connect, save, submit, file; the books lock and the compliance item completes', async () => {
  const { t, it } = await mini();
  assert.ok(it);
  const f = (await prepare(t, 'GSTR1')).body;
  assert.deepEqual([f.status, f.validation.errors, f.label], ['draft', [], 'GSTR-1']);
  assert.equal(f.summary.invoices, 1);
  assert.match(f.payloadHash, /^[0-9a-f]{64}$/);

  // nothing can be sent until connected
  const early = await act(t, f.id, 'save');
  assert.deepEqual([early.status, early.body.code], [409, 'NO_SESSION']);

  assert.equal((await call('POST', '/filing/gsp/session', { otp: SIM_OTP }, t)).status, 409, 'an OTP must be requested first');
  const sent = await ok(call('POST', '/filing/gsp/otp', { username: 'gst.user' }, t));
  assert.match(sent.hint, /SIMULATED/);
  assert.equal((await call('POST', '/filing/gsp/session', { otp: '000000' }, t)).status, 400);
  const sess = await ok(call('POST', '/filing/gsp/session', { otp: SIM_OTP }, t));
  assert.deepEqual([sess.connected, sess.username, 'token' in sess], [true, 'gst.user', false], 'the token never leaves the server');
  const st = await ok(call('GET', `/filing/status?period=${P}`, undefined, t));
  assert.deepEqual([st.gsp.mode, st.session.connected, st.filings.GSTR1.status, st.filings.GSTR3B], ['simulated', true, 'draft', null]);
  const row = (await pool.query('SELECT token_enc FROM gsp_sessions WHERE company_id=(SELECT company_id FROM users WHERE email=$1)', [`filing${seq}@example.com`])).rows[0];
  assert.ok(row.token_enc && !row.token_enc.includes('sim_'), 'stored encrypted');
  assert.match(decrypt(row.token_enc), /^sim_/);

  const saved = await ok(act(t, f.id, 'save'));
  assert.deepEqual([saved.status, saved.gspErrors], ['saved', []]);
  assert.match(saved.gspReference, /^SIMREF/);
  assert.equal((await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true })).status, 409, 'cannot file before submitting');

  // submitted: the month is locked
  assert.equal((await act(t, f.id, 'submit')).body.status, 'submitted');
  const lock = await call('POST', '/invoices', { partyId: (await call('GET', '/parties?type=customer', undefined, t)).body[0].id, date: '2026-09-15', lines: [{ itemId: (await call('GET', '/items', undefined, t)).body[0].id, qty: 1 }] }, t);
  assert.deepEqual([lock.status, lock.body.code], [409, 'PERIOD_FILED']);
  assert.match(lock.body.error, /GSTR-1 for 2026-09 is already submitted/);
  assert.equal((await act(t, f.id, 'save')).status, 409, 'a submitted return cannot be re-saved');
  assert.equal((await prepare(t, 'GSTR1')).status, 409, 'or re-prepared');

  // filing is guarded: confirmation, the exact reviewed return, and a valid OTP
  assert.equal((await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: false })).status, 400);
  assert.equal((await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash })).status, 400);
  const wrongHash = await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: 'f'.repeat(64), confirm: true });
  assert.deepEqual([wrongHash.status, wrongHash.body.code], [409, 'HASH_MISMATCH']);
  const badOtp = await act(t, f.id, 'file', { otp: '111111', payloadHash: f.payloadHash, confirm: true });
  assert.equal(badOtp.status, 400);
  const afterBad = (await call('GET', `/filing/returns/${f.id}`, undefined, t)).body;
  assert.deepEqual([afterBad.status, afterBad.arn, afterBad.gspErrors[0].message], ['submitted', null, 'The EVC OTP is incorrect or has expired.']);

  const filed = await ok(act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true }));
  assert.equal(filed.status, 'filed');
  assert.match(filed.arn, /^SIM29/);
  assert.match(filed.filedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true })).status, 409, 'cannot file twice');

  // the compliance calendar learns about it
  const cal = (await call('GET', '/compliance?fy=2026-27', undefined, t)).body.items.find((i) => i.ruleCode === 'GSTR1_M' && i.periodKey === P);
  assert.deepEqual([cal.status, cal.reference], ['completed', filed.arn]);

  // the audit trail
  const d = (await call('GET', `/filing/returns/${f.id}`, undefined, t)).body;
  assert.deepEqual(d.events.map((e) => e.action), ['prepared', 'saved', 'submitted', 'file_failed', 'filed']);
  assert.equal(d.stale, false);
  assert.equal(d.payload.fp, '092026');
  const file = await call('GET', `/filing/returns/${f.id}/json`, undefined, t, true);
  assert.match(file.headers.get('content-disposition'), /GSTR1_202609/);

  // another month is unaffected
  const next = await ok(call('POST', '/invoices', { partyId: (await call('GET', '/parties?type=customer', undefined, t)).body[0].id, date: '2026-10-01', lines: [{ itemId: (await call('GET', '/items', undefined, t)).body[0].id, qty: 1 }] }, t));
  assert.equal(next.number, 'INV-0002');
});

test('GSTR-3B: cash liability must be paid before filing; filing locks purchases and notes in that month', async () => {
  const { t, r1 } = await scenario();
  const f1 = (await prepare(t, 'GSTR1')).body;
  await connect(t);
  await ok(act(t, f1.id, 'save')); await ok(act(t, f1.id, 'submit'));
  await ok(act(t, f1.id, 'file', { otp: SIM_OTP, payloadHash: f1.payloadHash, confirm: true }));

  const f = (await prepare(t, 'GSTR3B')).body;
  assert.equal(f.summary.cashPayable, 40500);
  assert.doesNotMatch(f.validation.warnings.join(' '), /GSTR-1 for this month has not been filed/, 'GSTR-1 is filed');
  await ok(act(t, f.id, 'save')); await ok(act(t, f.id, 'submit'));

  const noPay = await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true });
  assert.equal(noPay.status, 409);
  assert.match(noPay.body.error, /must be paid in cash/);
  assert.equal((await call('GET', `/filing/returns/${f.id}`, undefined, t)).body.status, 'submitted', 'a failed filing changes nothing');

  const done = await ok(act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true, paymentRef: 'CPIN2609001' }));
  assert.deepEqual([done.status, done.paymentRef], ['filed', 'CPIN2609001']);
  const cal = (await call('GET', '/compliance?fy=2026-27', undefined, t)).body.items.find((i) => i.ruleCode === 'GSTR3B_M' && i.periodKey === P);
  assert.deepEqual([cal.status, cal.reference], ['completed', done.arn]);

  // with 3B filed, nothing dated September can be added
  const vendor = (await call('GET', '/parties?type=vendor', undefined, t)).body[0];
  const items = (await call('GET', '/items', undefined, t)).body;
  const blocked = [
    await call('POST', '/purchases', { partyId: vendor.id, supplierBillNo: 'LATE', date: '2026-09-28', lines: [{ itemId: items[0].id, qty: 1, rate: 100 }] }, t),
    await call('POST', '/invoices', { partyId: r1.id, date: '2026-09-28', lines: [{ itemId: items[0].id, qty: 1 }] }, t),
  ];
  assert.deepEqual(blocked.map((b) => [b.status, b.body.code]), [[409, 'PERIOD_FILED'], [409, 'PERIOD_FILED']]);
  assert.match(blocked[0].body.error, /GSTR-3B for 2026-09 is already filed/);

  const invs = (await call('GET', '/invoices', undefined, t)).body;
  const sep = invs.find((i) => i.number === 'INV-0002');
  const lineId = (await call('GET', `/invoices/${sep.id}/returnable`, undefined, t)).body.lines[0].id;
  const cn = await call('POST', `/invoices/${sep.id}/returns`, { date: '2026-09-29', lines: [{ lineId, qty: 1 }] }, t);
  assert.deepEqual([cn.status, cn.body.code], [409, 'PERIOD_FILED'], 'a credit note dated in a filed month');
  assert.equal((await call('POST', `/invoices/${sep.id}/returns`, { date: '2026-10-05', lines: [{ lineId, qty: 1 }] }, t)).status, 201, 'but it can be dated next month');
  assert.equal((await call('GET', '/invoices', undefined, t)).status, 200, 'reading is never blocked');
  assert.equal((await call('POST', '/invoices', { partyId: r1.id, date: '2026-10-03', lines: [{ itemId: items[0].id, qty: 1 }] }, t)).status, 201);
});

test('stale returns: changes after preparing must be reviewed again', async () => {
  const { t } = await mini();
  const f = (await prepare(t, 'GSTR1')).body;
  await connect(t);
  assert.equal((await call('GET', `/filing/returns/${f.id}`, undefined, t)).body.stale, false);

  const c = (await call('GET', '/parties?type=customer', undefined, t)).body[0], it = (await call('GET', '/items', undefined, t)).body[0];
  await ok(call('POST', '/invoices', { partyId: c.id, date: '2026-09-18', lines: [{ itemId: it.id, qty: 1 }] }, t));
  const d = (await call('GET', `/filing/returns/${f.id}`, undefined, t)).body;
  assert.equal(d.stale, true);
  const blocked = await act(t, f.id, 'save');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'STALE']);

  const again = (await prepare(t, 'GSTR1')).body;
  assert.equal(again.id, f.id, 'the same filing is refreshed');
  assert.notEqual(again.payloadHash, f.payloadHash);
  assert.equal(again.summary.invoices, 2);
  assert.equal((await act(t, f.id, 'save')).body.status, 'saved');
  // preparing again after saving goes back to draft and clears what the GSP said
  const reset = (await prepare(t, 'GSTR1')).body;
  assert.deepEqual([reset.status, reset.gspReference], ['draft', null]);
});

test('GSP rejection: a recipient GSTIN with a bad check character is warned about, rejected on save, and cannot be submitted', async () => {
  const bad = GSTIN.r1.slice(0, 14) + (GSTIN.r1[14] === 'A' ? 'B' : 'A');
  const { t } = await mini({ customerGstin: bad });
  await connect(t);
  const f = (await prepare(t, 'GSTR1')).body;
  assert.deepEqual(f.validation.errors, [], 'a warning, not a block: the GSP is the final judge');
  assert.match(f.validation.warnings.join(' '), new RegExp(`fail the check-digit test.*${bad}`));

  const saved = await ok(act(t, f.id, 'save'));
  assert.equal(saved.status, 'error');
  assert.match(saved.gspErrors[0].message, new RegExp(`Invalid recipient GSTIN ${bad}`));
  assert.equal((await act(t, f.id, 'submit')).status, 409);
  assert.equal((await act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true })).status, 409);
  assert.equal((await ok(act(t, f.id, 'refresh'))).status, 'error', 'still rejected');
  const d = (await call('GET', `/filing/returns/${f.id}`, undefined, t)).body;
  assert.ok(d.events.some((e) => e.action === 'save_rejected'));
});

test('a month with no activity files as a nil return', async () => {
  const { t } = await mini({ invoice: false });
  const f = (await prepare(t, 'GSTR1')).body;
  assert.match(f.validation.warnings.join(' '), /nil return/);
  const d = (await call('GET', `/filing/returns/${f.id}`, undefined, t)).body;
  assert.deepEqual(Object.keys(d.payload), ['gstin', 'fp', 'gt', 'cur_gt']);
  await connect(t);
  await ok(act(t, f.id, 'save')); await ok(act(t, f.id, 'submit'));
  assert.equal((await ok(act(t, f.id, 'file', { otp: SIM_OTP, payloadHash: f.payloadHash, confirm: true }))).status, 'filed');
});

test('sessions: expire, can be disconnected, and are never shared between companies', async () => {
  const { t } = await mini();
  const other = (await mini()).t;
  await connect(t);
  assert.equal((await call('GET', '/filing/gsp/session', undefined, t)).body.connected, true);
  assert.equal((await call('GET', '/filing/gsp/session', undefined, other)).body.connected, false);

  const f = (await prepare(t, 'GSTR1')).body;
  await pool.query("UPDATE gsp_sessions SET expires_at=$1 WHERE company_id=(SELECT company_id FROM users WHERE email=$2)", [new Date(Date.now() - 1000), `filing${seq - 1}@example.com`]);
  assert.equal((await act(t, f.id, 'save')).body.code, 'NO_SESSION', 'an expired session counts as disconnected');
  await connect(t);
  assert.equal((await call('DELETE', '/filing/gsp/session', undefined, t)).body.connected, false);
  assert.equal((await act(t, f.id, 'save')).status, 409);

  // another company cannot see or act on this filing
  assert.equal((await call('GET', `/filing/returns/${f.id}`, undefined, other)).status, 404);
  assert.equal((await act(other, f.id, 'save')).status, 404);
  assert.equal((await call('GET', `/filing/returns/${f.id}/json`, undefined, other, true)).status, 404);
  assert.equal((await call('GET', `/filing/status?period=${P}`, undefined, other)).body.filings.GSTR1, null);
});

test('GSTIN lookup: validates the check character first; the simulator labels everything it returns', async () => {
  const { t } = await mini();
  await connect(t);
  const g = await ok(call('GET', `/filing/gstin/${GSTIN.r2}`, undefined, t));
  assert.deepEqual([g.gstin, g.stateCode, g.pan, g.status, g.simulated], [GSTIN.r2, '27', 'CCCCC2222C', 'Active', true]);
  assert.match(g.legalName, /^SIMULATED/);
  assert.equal((await ok(call('GET', `/filing/gstin/${GSTIN.r2.toLowerCase()}`, undefined, t))).gstin, GSTIN.r2, 'case-insensitive');
  assert.equal((await ok(call('GET', `/filing/gstin/${gstin('27AAPFU0939F9Z')}`, undefined, t))).status, 'Cancelled');
  assert.equal((await call('GET', '/filing/gstin/NOTAGSTIN', undefined, t)).status, 400);
  const wrong = await call('GET', `/filing/gstin/${GSTIN.r2.slice(0, 14)}${GSTIN.r2[14] === 'A' ? 'B' : 'A'}`, undefined, t);
  assert.deepEqual([wrong.status, /check character/.test(wrong.body.error)], [400, true]);
});

test('without a GSP: exports still work, everything that needs the portal says so; unbuilt GSPs explain what is missing', async () => {
  const { Pool } = newDb().adapters.createPg();
  const p2 = new Pool();
  await migrate(p2);
  const server = createApp(p2, { gateway: null, gsp: null }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const c2 = async (m, p, b, tok) => { const r = await fetch(url + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const tok = (await c2('POST', '/auth/register', { name: 'N', email: 'nogsp@example.com', password: 'password123', company: 'No GSP', sector: 'retail', gstin: GSTIN.me }, null)).body.token;

  assert.equal((await c2('GET', `/filing/export/GSTR1?period=${P}`, undefined, tok)).status, 200, 'the offline JSON needs no GSP');
  const look = await c2('GET', `/filing/gstin/${GSTIN.r1}`, undefined, tok);
  assert.deepEqual([look.status, look.body.code], [503, 'NO_GSP']);
  assert.equal((await c2('POST', '/filing/gsp/otp', { username: 'u1' }, tok)).body.code, 'NO_GSP');
  const st = (await c2('GET', `/filing/status?period=${P}`, undefined, tok)).body;
  assert.equal(st.gsp, null);

  assert.equal(resolveGsp({ NODE_ENV: 'production' }), null, 'never simulated in production');
  assert.equal(resolveGsp({}).mode, 'simulated');
  for (const name of ['masters_india', 'tera']) {
    const g = resolveGsp({ GSP_PROVIDER: name });
    assert.equal(g.mode, 'not_implemented');
    await assert.rejects(g.sendOtp({}), (e) => e.status === 501 && e.message.includes('API documentation'));
  }
});
