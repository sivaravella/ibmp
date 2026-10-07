import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { gstinCheckChar } from '../src/gstin.js';
import { CSV_26Q, SECTIONS, build26q, computeDeduction, deducteeType, partyPan, standardRate } from '../src/tdsns.js';

// ---------- pure ----------
const IND = 'ABCPE1234F', CO = 'AAACV1234C';     // 4th letter P = individual, C = company

test('deductee type and PAN come from the party, falling back to the GSTIN', () => {
  assert.deepEqual([deducteeType(CO), deducteeType(IND), deducteeType(null)], ['company', 'non_company', 'non_company']);
  assert.equal(partyPan({ pan: IND, gstin: '29AAACV1234C1ZX' }), IND);
  assert.equal(partyPan({ pan: null, gstin: '29AAACV1234C1ZX' }), 'AAACV1234C');
  assert.equal(partyPan({ pan: 'bad', gstin: null }), null);
});

test('standard rates: 194C by deductee, 20% with no PAN, 194Q has its own higher no-PAN rate', () => {
  assert.deepEqual(standardRate('94C', IND), { rate: 1, reason: 'standard' });
  assert.deepEqual(standardRate('94C', CO), { rate: 2, reason: 'standard' });
  assert.deepEqual(standardRate('94JB', null), { rate: 20, reason: 'no_pan' });
  assert.deepEqual(standardRate('94C', null), { rate: 20, reason: 'no_pan' });
  assert.deepEqual(standardRate('94Q', null), { rate: 5, reason: 'no_pan' });
  assert.throws(() => standardRate('94Z', CO), (e) => e.status === 400);
});

test('yearly limit: nothing below it, then tax on everything paid so far, then on each new payment', () => {
  const a = computeDeduction({ section: '94JB', pan: IND, payment: 30000 });
  assert.deepEqual([a.tds, a.taxed_base, a.threshold_crossed], [0, 0, false]);
  const b = computeDeduction({ section: '94JB', pan: IND, prior: { base: 30000, taxedBase: 0 }, payment: 30000 });
  assert.deepEqual([b.tds, b.taxed_base, b.catch_up, b.rate], [6000, 60000, 30000, 10], '10% of ₹60,000: the first ₹30,000 is caught up');
  const c = computeDeduction({ section: '94JB', pan: IND, prior: { base: 60000, taxedBase: 60000 }, payment: 10000 });
  assert.deepEqual([c.tds, c.taxed_base, c.catch_up], [1000, 10000, 0]);
});

test('194C: a single payment over ₹30,000 is taxed at once; small ones are taxed when the year passes ₹1,00,000', () => {
  assert.equal(computeDeduction({ section: '94C', pan: IND, payment: 40000 }).tds, 400);
  assert.equal(computeDeduction({ section: '94C', pan: CO, payment: 40000 }).tds, 800);
  assert.equal(computeDeduction({ section: '94C', pan: IND, payment: 30000 }).tds, 0, 'exactly the limit is not over it');
  const small = computeDeduction({ section: '94C', pan: IND, prior: { base: 20000, taxedBase: 0 }, payment: 20000 });
  assert.equal(small.tds, 0);
  const crossing = computeDeduction({ section: '94C', pan: IND, prior: { base: 90000, taxedBase: 0 }, payment: 20000 });
  assert.deepEqual([crossing.tds, crossing.taxed_base], [1100, 110000], '1% of ₹1,10,000');
  const big = computeDeduction({ section: '94C', pan: IND, prior: { base: 20000, taxedBase: 0 }, payment: 40000 });
  assert.deepEqual([big.tds, big.taxed_base], [400, 40000], 'a single payment over the limit is taxed on its own; the earlier small ones are not caught up');
});

test('194Q taxes only the part above ₹50 lakh', () => {
  assert.deepEqual([computeDeduction({ section: '94Q', pan: CO, payment: 6000000 }).tds, computeDeduction({ section: '94Q', pan: CO, payment: 4000000 }).tds], [1000, 0]);
  const next = computeDeduction({ section: '94Q', pan: CO, prior: { base: 6000000, taxedBase: 1000000 }, payment: 2000000 });
  assert.deepEqual([next.tds, next.taxed_base, next.catch_up], [2000, 2000000, 0]);
});

test('no PAN means 20%; an override (lower-deduction certificate) replaces the rate; rounding is to the rupee', () => {
  const n = computeDeduction({ section: '94JB', pan: null, payment: 100000 });
  assert.deepEqual([n.rate, n.rate_reason, n.tds], [20, 'no_pan', 20000]);
  const o = computeDeduction({ section: '94JB', pan: CO, payment: 100000, rateOverride: 1 });
  assert.deepEqual([o.rate, o.rate_reason, o.tds], [1, 'override', 1000]);
  assert.equal(computeDeduction({ section: '94H', pan: CO, payment: 33333 }).tds, 667, '2% of 33,333 = 666.66');
  assert.equal(computeDeduction({ section: '94A', pan: CO, payment: 10000 }).tds, 0, '₹10,000 is not over the limit');
  assert.equal(computeDeduction({ section: '94IB', pan: CO, payment: 700000 }).tds, 70000);
});

const company = { name: 'X Pvt Ltd', legal_name: 'X Pvt Ltd', gstin: '29ZYXWV5555Q1Z5', tan: 'HYDR12345A', pan: null, addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001', tds_person_name: 'A. Rao', tds_person_designation: 'Director', deductor_type: 'Company' };
const ded = (o) => ({ id: 1, party_name: 'Vendor', pan: CO, section: '94JB', date: '2026-08-20', base: 200000, taxed_base: 200000, rate: 10, rate_reason: 'standard', tds: 20000, cert_ref: null, ...o });
const chal = (o) => ({ month: '2026-08', deductee_type: 'company', bsr: '0510308', serial: '00123', deposited_on: '2026-09-05', tax: 20000, interest: 0, fee: 0, ...o });

test('26Q: a challan per month and type of deductee, rows tie to challans, totals', () => {
  const { statement: s, errors } = build26q({ company, fy: '2026-27', quarter: 2, deductions: [ded({}), ded({ id: 2, party_name: 'Ind', pan: IND, tds: 6000, date: '2026-08-10' })], challans: [chal({}), chal({ deductee_type: 'non_company', serial: '00124', tax: 6000 })], asOf: '2026-10-20' });
  assert.deepEqual(errors, []);
  assert.deepEqual(s.challans.map((c) => [c.month, c.challan_type, c.tds_income_tax, c.total_deposited]), [['2026-08', '0020', 20000, 20000], ['2026-08', '0021', 6000, 6000]]);
  assert.deepEqual(s.deductees.map((d) => [d.sr, d.deductee_code, d.pan, d.tds_total, d.date_of_deposit, d.challan_serial]), [[1, '02', IND, 6000, '2026-09-05', '00124'], [2, '01', CO, 20000, '2026-09-05', '00123']]);
  assert.deepEqual([s.totals.deducted, s.totals.deposited, s.ay, s.due_date], [26000, 26000, '2027-28', '2026-10-31']);
});

test('26Q checks: missing challan, challan amount mismatch, missing TAN/person/address, quarter not ended', () => {
  const none = build26q({ company, fy: '2026-27', quarter: 2, deductions: [ded({})], challans: [], asOf: '2026-10-20' });
  assert.match(none.errors.join('|'), /has not been deposited/);
  const off = build26q({ company, fy: '2026-27', quarter: 2, deductions: [ded({})], challans: [chal({ tax: 19000 })], asOf: '2026-10-20' });
  assert.match(off.errors.join('|'), /challan is for ₹19000 but the deductions add up to ₹20000/);
  const bare = build26q({ company: { ...company, tan: null, tds_person_name: null, addr1: null }, fy: '2026-27', quarter: 2, deductions: [], challans: [], asOf: '2026-10-20' });
  assert.equal(bare.errors.length, 3);
  assert.match(build26q({ company, fy: '2026-27', quarter: 2, deductions: [], challans: [], asOf: '2026-09-20' }).errors.join('|'), /has not ended yet/);
});

test('26Q warnings: no PAN, certificate rate, late deposit, late filing fee, already filed', () => {
  const w = build26q({
    company, fy: '2026-27', quarter: 2, asOf: '2026-11-10',
    deductions: [ded({ id: 1, pan: null, party_name: 'NoPan', rate: 20, rate_reason: 'no_pan', tds: 40000 }), ded({ id: 2, party_name: 'Cert', rate_reason: 'override', rate: 1, tds: 2000, cert_ref: 'LDC/1' })],
    challans: [chal({ deductee_type: 'non_company', tax: 40000, deposited_on: '2026-09-20' }), chal({ tax: 2000 })], statements: [{ fy: '2026-27', quarter: 2, token_no: '123456789012345' }],
  });
  const text = w.warnings.join('|');
  assert.match(text, /NoPan has no PAN.*PANNOTAVBL/);
  assert.match(text, /Cert \(194J\(b\)\): a rate of 1% was used under certificate LDC\/1/);
  assert.match(text, /deposited on 2026-09-20, after the due date 2026-09-07/);
  assert.match(text, /section 234E.*₹2000/, '10 days late at ₹200 a day');
  assert.match(text, /already recorded as filed \(token 123456789012345\)/);
  assert.equal(w.statement.deductees.find((d) => d.name === 'NoPan').pan, 'PANNOTAVBL');
});

test('26Q CSV columns cover what the statement rows carry', () => {
  const { statement: s } = build26q({ company, fy: '2026-27', quarter: 2, deductions: [ded({})], challans: [chal({})], asOf: '2026-10-20' });
  for (const [k] of CSV_26Q.deductees) assert.ok(k in s.deductees[0], k);
  for (const [k] of CSV_26Q.challans) assert.ok(k in s.challans[0], k);
  assert.ok(Object.keys(SECTIONS).length >= 8);
});

// ---------- API ----------
let pool, call, seq = 0;
const gstin = (p) => p + gstinCheckChar(p);

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
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (extra = {}) => (await call('POST', '/auth/register', { name: 'T', email: `ns${++seq}@example.com`, password: 'password123', company: `NS Co ${seq}`, sector: 'trading', ...extra }, null)).body.token;
const balance = async (t, code) => Number((await call('GET', '/accounts', undefined, t)).body.find((a) => a.code === code)?.balance ?? 0);

/** A deductor with a company vendor (V1), an individual vendor with a PAN (V2), a vendor with no PAN (V3) and one item. */
async function world() {
  const t = await register({ gstin: gstin('29ZYXWV5555Q1Z') });
  await ok(call('PUT', '/company/profile', { legalName: 'NS Co Pvt Ltd', addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001' }, t));
  await ok(call('PUT', '/tds/settings', { tan: 'HYDR12345A', responsibleName: 'A. Rao', responsibleDesignation: 'Director', deductorType: 'Company' }, t));
  const v1 = await ok(call('POST', '/parties', { type: 'vendor', name: 'Company Vendor', gstin: gstin('29AAACV1234C1Z') }, t));
  const v2 = await ok(call('POST', '/parties', { type: 'vendor', name: 'Individual Vendor', stateCode: '29', pan: 'abcpe1234f' }, t));
  const v3 = await ok(call('POST', '/parties', { type: 'vendor', name: 'No PAN Vendor', stateCode: '29' }, t));
  const item = await ok(call('POST', '/items', { name: 'Service work', hsn: '9987', rate: 5000, gstPct: 18, stock: 0 }, t));
  return { t, v1, v2, v3, item };
}
const expense = (t, partyId, section, date, amount, extra = {}) => call('POST', '/tds/ns/expenses', { partyId, section, date, amount, mode: 'bank', ...extra }, t);

test('API: PAN on a party is validated and normalised; the section list says the rates are unverified', async () => {
  const { t, v2, v3 } = await world();
  assert.equal(v2.pan, 'ABCPE1234F');
  assert.equal((await call('POST', '/parties', { type: 'vendor', name: 'Bad', stateCode: '29', pan: 'nope' }, t)).status, 400);
  assert.equal((await call('PUT', `/parties/${v3.id}/pan`, { pan: 'bad' }, t)).status, 400);
  assert.equal((await ok(call('PUT', `/parties/${v3.id}/pan`, { pan: 'abcpe9999z' }, t))).pan, 'ABCPE9999Z');
  assert.equal((await call('PUT', '/parties/999999/pan', { pan: null }, t)).status, 404);
  const s = await ok(call('GET', '/tds/ns/sections', undefined, t));
  assert.equal(s.ratesVerified, false);
  assert.deepEqual(s.sections.find((x) => x.code === '94C').rate, { individual: 1, other: 2 });
});

test('API: the quote shows the deduction before it is made, and a yearly limit builds up across payments', async () => {
  const { t, v2 } = await world();
  const q1 = await ok(call('POST', '/tds/ns/quote', { partyId: v2.id, section: '94JB', amount: 30000, date: '2026-07-10' }, t));
  assert.deepEqual([q1.tds, q1.rate, q1.pan], [0, 10, 'ABCPE1234F']);
  await ok(expense(t, v2.id, '94JB', '2026-07-10', 30000));
  const q2 = await ok(call('POST', '/tds/ns/quote', { partyId: v2.id, section: '94JB', amount: 30000, date: '2026-08-10' }, t));
  assert.deepEqual([q2.tds, q2.taxedBase, q2.catchUp, q2.prior.base], [6000, 60000, 30000, 30000]);
  assert.equal((await call('POST', '/tds/ns/quote', { partyId: v2.id, section: '94Z', amount: 1, date: '2026-08-10' }, t)).status, 400);
  assert.equal((await call('POST', '/tds/ns/quote', { partyId: 999999, section: '94JB', amount: 1, date: '2026-08-10' }, t)).status, 400);
  // a different financial year starts again from nothing
  assert.equal((await ok(call('POST', '/tds/ns/quote', { partyId: v2.id, section: '94JB', amount: 30000, date: '2027-04-10' }, t))).prior.base, 0);
});

test('API: expense payment posts the expense, the payment and the TDS in one balanced entry', async () => {
  const { t, v2 } = await world();
  const a = await ok(expense(t, v2.id, '94JB', '2026-07-10', 30000));
  assert.deepEqual([a.tds, a.paidToVendor, a.thresholdCrossed], [0, 30000, false]);
  const b = await ok(expense(t, v2.id, '94JB', '2026-08-10', 30000, { certRef: undefined }));
  assert.deepEqual([b.tds, b.paidToVendor, b.taxedBase, b.catchUp, b.rate, b.rateReason], [6000, 24000, 60000, 30000, 10, 'standard']);
  assert.equal(await balance(t, '2250'), 6000, 'TDS owed to the government');
  assert.equal(await balance(t, '5420'), 60000, 'professional fees expense');
  assert.equal(await balance(t, '1010'), -54000, 'bank: 30,000 + 24,000 paid');
  assert.equal((await call('GET', '/trial-balance', undefined, t)).body.balanced, true);
  // 194Q is for goods bought on a bill
  assert.equal((await expense(t, v2.id, '94Q', '2026-08-11', 1000)).status, 400);
  assert.equal((await expense(t, v2.id, '94JB', '2026-08-11', -5)).status, 400);
  assert.equal((await expense(t, 999999, '94JB', '2026-08-11', 5)).status, 400);
});

test('API: deducting from a bill reduces what the vendor is owed; payment is capped at the net; no PAN means 20%', async () => {
  const { t, v3, item } = await world();
  const bill = await ok(call('POST', '/purchases', { partyId: v3.id, supplierBillNo: 'S-1', date: '2026-09-02', lines: [{ itemId: item.id, qty: 10, rate: 5000 }] }, t));
  assert.equal(Number(bill.total), 59000, '50,000 + 18% GST');
  const d = await ok(call('POST', '/tds/ns/bills', { purchaseId: bill.id, section: '94C' }, t));
  assert.deepEqual([d.base, d.rate, d.rateReason, d.tds, d.kind], [50000, 20, 'no_pan', 10000, 'bill']);
  const after = (await call('GET', `/purchases/${bill.id}`, undefined, t)).body;
  assert.equal(Number(after.tds), 10000);
  assert.equal(await balance(t, '2000'), 49000, 'creditors: 59,000 less the 10,000 deducted');
  assert.equal(await balance(t, '2250'), 10000);
  assert.equal((await call('POST', `/purchases/${bill.id}/payments`, { amount: 49001, mode: 'bank' }, t)).status, 400);
  const paid = await ok(call('POST', `/purchases/${bill.id}/payments`, { amount: 49000, mode: 'bank' }, t));
  assert.equal(paid.status, 'paid');
  assert.equal(await balance(t, '2000'), 0);
  const dash = (await call('GET', '/dashboard', undefined, t)).body;
  assert.equal(Number(dash.payable), 0, 'the dashboard no longer counts the TDS as owed to the vendor');
  // once only; and not after the bill is paid in full (the tax has to come out of the payment)
  assert.equal((await call('POST', '/tds/ns/bills', { purchaseId: bill.id, section: '94C' }, t)).status, 409);
  const bill2 = await ok(call('POST', '/purchases', { partyId: v3.id, supplierBillNo: 'S-2', date: '2026-09-03', lines: [{ itemId: item.id, qty: 10, rate: 5000 }] }, t));
  await ok(call('POST', `/purchases/${bill2.id}/payments`, { amount: 59000, mode: 'bank' }, t));
  assert.equal((await call('POST', '/tds/ns/bills', { purchaseId: bill2.id, section: '94C' }, t)).status, 409);
  assert.equal((await call('POST', '/tds/ns/bills', { purchaseId: 999999, section: '94C' }, t)).status, 404);
});

test('API: reversing a deduction restores the bill, and cannot break a later deduction, a challan or a filed quarter', async () => {
  const { t, v2, v3, item } = await world();
  const bill = await ok(call('POST', '/purchases', { partyId: v3.id, supplierBillNo: 'R-1', date: '2026-09-02', lines: [{ itemId: item.id, qty: 10, rate: 5000 }] }, t));
  const d = await ok(call('POST', '/tds/ns/bills', { purchaseId: bill.id, section: '94C', rateOverride: 2, certRef: 'LDC/2026/1' }, t));
  assert.deepEqual([d.tds, d.rateReason], [1000, 'override']);
  await ok(call('DELETE', `/tds/ns/deductions/${d.id}`, undefined, t));
  assert.equal(Number((await call('GET', `/purchases/${bill.id}`, undefined, t)).body.tds), 0);
  assert.equal(await balance(t, '2250'), 0);
  assert.equal(await balance(t, '2000'), 59000);
  assert.equal((await call('DELETE', `/tds/ns/deductions/${d.id}`, undefined, t)).status, 404, 'already reversed');
  assert.equal((await call('GET', '/trial-balance', undefined, t)).body.balanced, true);

  // earlier deductions underpin later ones
  const first = await ok(expense(t, v2.id, '94JB', '2026-07-10', 60000));
  const second = await ok(expense(t, v2.id, '94JB', '2026-08-10', 10000));
  assert.equal((await call('DELETE', `/tds/ns/deductions/${first.id}`, undefined, t)).status, 409);
  await ok(call('DELETE', `/tds/ns/deductions/${second.id}`, undefined, t));

  // a recorded challan holds the deduction
  const ch = await ok(call('POST', '/tds/ns/challans', { month: '2026-07', deducteeType: 'non_company', bsr: '0510308', serial: '00123', depositedOn: '2026-08-05' }, t));
  assert.equal((await call('DELETE', `/tds/ns/deductions/${first.id}`, undefined, t)).body.code, 'CHALLAN_EXISTS');
  await ok(call('DELETE', `/tds/ns/challans/${ch.id}`, undefined, t));
  await ok(call('DELETE', `/tds/ns/deductions/${first.id}`, undefined, t));
});

test('API: challans: one per month and type of deductee, the tax is the sum of the deductions, and it posts to the ledger', async () => {
  const { t, v1, v2 } = await world();
  await ok(expense(t, v2.id, '94JB', '2026-08-10', 100000));            // individual: 10,000
  await ok(expense(t, v1.id, '94JB', '2026-08-20', 200000));            // company: 20,000
  const list = (await call('GET', '/tds/ns/challans?fy=2026-27', undefined, t)).body.challans;
  assert.deepEqual(list.map((c) => [c.month, c.deducteeType, c.challanType, c.tds, c.quarter, c.dueDate, c.challan]), [['2026-08', 'company', '0020', 20000, 2, '2026-09-07', null], ['2026-08', 'non_company', '0021', 10000, 2, '2026-09-07', null]]);

  const bad = { month: '2026-08', deducteeType: 'company', bsr: '0510308', serial: '00123', depositedOn: '2026-09-05' };
  assert.equal((await call('POST', '/tds/ns/challans', { ...bad, bsr: '12' }, t)).status, 400);
  assert.equal((await call('POST', '/tds/ns/challans', { ...bad, serial: '1' }, t)).status, 400);
  assert.equal((await call('POST', '/tds/ns/challans', { ...bad, depositedOn: '2026-07-30' }, t)).status, 400, 'before the month');
  assert.equal((await call('POST', '/tds/ns/challans', { ...bad, month: '2026-09' }, t)).status, 400, 'nothing deducted in September');
  const c = await ok(call('POST', '/tds/ns/challans', { ...bad, interest: 150, fee: 0 }, t));
  assert.deepEqual([c.tax, c.interest], [20000, 150]);
  assert.equal((await call('POST', '/tds/ns/challans', bad, t)).status, 409);
  assert.equal(await balance(t, '2250'), 10000, 'the company-deductee TDS has been paid off');
  assert.equal(await balance(t, '5400'), 150, 'interest and fee are an expense');
  const mine = (await call('GET', '/tds/ns/challans?fy=2026-27', undefined, t)).body.challans.find((x) => x.deducteeType === 'company');
  assert.deepEqual([mine.challan.bsr, mine.challan.serial, mine.challan.depositedOn, mine.late], ['0510308', '00123', '2026-09-05', false]);
  await ok(call('DELETE', `/tds/ns/challans/${c.id}`, undefined, t));
  assert.equal(await balance(t, '2250'), 30000);
  assert.equal(await balance(t, '5400'), 0);
  assert.equal((await call('DELETE', `/tds/ns/challans/${c.id}`, undefined, t)).status, 404);
  assert.equal((await call('GET', '/trial-balance', undefined, t)).body.balanced, true);
});

test('API: Form 26Q end to end: errors until the challans are in, then the statement, exports, filing, and the lock', async () => {
  const { t, v1, v2, v3, item } = await world();
  await ok(expense(t, v2.id, '94JB', '2026-07-10', 30000));
  await ok(expense(t, v2.id, '94JB', '2026-08-10', 30000));             // 6,000 on 60,000 (catch-up)
  await ok(expense(t, v1.id, '94JB', '2026-08-20', 200000));            // 20,000 (company)
  const bill = await ok(call('POST', '/purchases', { partyId: v3.id, supplierBillNo: 'Q-1', date: '2026-09-02', lines: [{ itemId: item.id, qty: 10, rate: 5000 }] }, t));
  await ok(call('POST', '/tds/ns/bills', { purchaseId: bill.id, section: '94C' }, t));   // 10,000 at 20%, no PAN

  const url = (extra = '') => `/tds/26q?fy=2026-27&quarter=2&asOf=2026-10-20${extra}`;
  const before = (await call('GET', url(), undefined, t)).body;
  assert.equal(before.errors.filter((e) => /has not been deposited/.test(e)).length, 3);

  const dep = (month, deducteeType, serial, depositedOn) => ok(call('POST', '/tds/ns/challans', { month, deducteeType, bsr: '0510308', serial, depositedOn }, t));
  await dep('2026-08', 'non_company', '00123', '2026-09-05');
  await dep('2026-08', 'company', '00124', '2026-09-06');
  await dep('2026-09', 'non_company', '00125', '2026-10-07');

  const r = (await call('GET', url(), undefined, t)).body;
  assert.deepEqual(r.errors, []);
  const s = r.statement;
  assert.deepEqual(s.challans.map((c) => [c.month, c.challanType, c.tdsIncomeTax, c.bsr, c.challanSerial]), [['2026-08', '0020', 20000, '0510308', '00124'], ['2026-08', '0021', 6000, '0510308', '00123'], ['2026-09', '0021', 10000, '0510308', '00125']]);
  assert.deepEqual(s.deductees.map((d) => [d.name, d.sectionName, d.pan, d.deducteeCode, d.amountPaid, d.rate, d.tdsTotal]),
    [['Individual Vendor', '194J(b)', 'ABCPE1234F', '02', 30000, 10, 6000], ['Company Vendor', '194J(b)', 'AAACV1234C', '01', 200000, 10, 20000], ['No PAN Vendor', '194C', 'PANNOTAVBL', '02', 50000, 20, 10000]]);
  assert.deepEqual([s.totals.deducted, s.totals.deposited, s.deductor.tan, s.fy, s.ay, s.dueDate], [36000, 36000, 'HYDR12345A', '2026-27', '2027-28', '2026-10-31']);
  assert.ok(r.warnings.some((w) => /No PAN Vendor has no PAN/.test(w)));
  assert.ok(r.warnings.some((w) => /catch-up/.test(w)), 'catch-up on the earlier ₹30,000 is flagged');
  // the first payment (no tax) is not on the statement
  assert.equal(s.deductees.some((d) => d.amountPaid === 30000 && d.tdsTotal === 0), false);

  const deds = (await call('GET', '/tds/ns/deductions?fy=2026-27&quarter=2', undefined, t)).body.deductions;
  assert.equal(deds.length, 4);
  const sum = (await call('GET', '/tds/ns/deductees?fy=2026-27', undefined, t)).body.deductees;
  assert.deepEqual(sum.map((x) => [x.name, x.sectionName, x.paid, x.taxedBase, x.tds, x.payments]), [['Company Vendor', '194J(b)', 200000, 200000, 20000, 1], ['Individual Vendor', '194J(b)', 60000, 60000, 6000, 2], ['No PAN Vendor', '194C', 50000, 50000, 10000, 1]]);

  // exports
  const csv = await (await call('GET', url('&section=deductees').replace('/tds/26q', '/tds/26q/export'), undefined, t, true)).text();
  assert.equal(csv.split('\r\n')[0], CSV_26Q.deductees.map(([, h]) => h).join(','));
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(csv, /No PAN Vendor,/);
  const json = await (await call('GET', url().replace('/tds/26q', '/tds/26q/export'), undefined, t, true)).json();
  assert.equal(json.form, '26Q');
  assert.equal((await call('GET', '/tds/26q/export?fy=2026-27&quarter=2&section=nope', undefined, t)).status, 400);
  assert.equal((await call('GET', '/tds/26q?fy=2026-27&quarter=9', undefined, t)).status, 400);
  assert.equal((await call('GET', '/tds/26q?fy=bad&quarter=2', undefined, t)).status, 400);

  // compliance calendar: the payment items are done, the return is open until filed
  await ok(call('PUT', '/compliance/settings', { tdsNonsalary: true, trackFrom: '2026-04-01' }, t));
  const cal = async () => (await call('GET', '/compliance?fy=2026-27&asOf=2026-10-20', undefined, t)).body.items;
  let it = await cal();
  assert.equal(it.find((i) => i.ruleCode === 'TDS_PAY_NS' && i.periodKey === '2026-09').status, 'completed');
  assert.equal(it.find((i) => i.ruleCode === 'TDS_PAY_NS' && i.periodKey === '2026-08').status, 'completed', 'both types of deductee deposited');
  assert.equal(it.find((i) => i.ruleCode === 'TDS_RET_26Q' && i.periodKey === '2026-Q2').due, '2026-10-31');
  assert.notEqual(it.find((i) => i.ruleCode === 'TDS_RET_26Q' && i.periodKey === '2026-Q2').status, 'completed');

  // recording the filing
  assert.equal((await call('POST', '/tds/26q/filed', { fy: '2026-27', quarter: 2, tokenNo: '123', filedOn: '2026-10-25' }, t)).status, 400);
  await ok(call('POST', '/tds/26q/filed', { fy: '2026-27', quarter: 2, tokenNo: '123456789012345', filedOn: '2026-10-25' }, t));
  assert.equal((await call('POST', '/tds/26q/filed', { fy: '2026-27', quarter: 2, tokenNo: '123456789012345', filedOn: '2026-10-25' }, t)).status, 409);
  it = await cal();
  assert.deepEqual([it.find((i) => i.ruleCode === 'TDS_RET_26Q' && i.periodKey === '2026-Q2').status, it.find((i) => i.ruleCode === 'TDS_RET_26Q' && i.periodKey === '2026-Q2').reference], ['completed', '123456789012345']);

  // the filed quarter is closed
  const locked = await expense(t, v2.id, '94JB', '2026-09-15', 1000);
  assert.deepEqual([locked.status, locked.body.code], [409, 'PERIOD_LOCKED']);
  assert.equal((await call('DELETE', `/tds/ns/deductions/${deds[1].id}`, undefined, t)).status, 409);
  const chs = (await call('GET', '/tds/ns/challans?fy=2026-27', undefined, t)).body.challans;
  assert.equal((await call('DELETE', `/tds/ns/challans/${chs[0].challan.id}`, undefined, t)).status, 409);
  // other quarters are untouched
  await ok(expense(t, v2.id, '94JB', '2026-10-15', 1000));

  const stmts = (await call('GET', '/tds/26q/statements', undefined, t)).body;
  assert.deepEqual([stmts.length, stmts[0].tokenNo, stmts[0].filedOn], [1, '123456789012345', '2026-10-25']);
  await ok(call('DELETE', `/tds/26q/statements/${stmts[0].id}`, undefined, t));
  assert.notEqual((await cal()).find((i) => i.ruleCode === 'TDS_RET_26Q' && i.periodKey === '2026-Q2').status, 'completed');
  assert.equal((await call('DELETE', `/tds/26q/statements/${stmts[0].id}`, undefined, t)).status, 404);
  await ok(expense(t, v2.id, '94JB', '2026-09-15', 1000));
  assert.equal((await call('GET', '/trial-balance', undefined, t)).body.balanced, true);
});

test('API: another company sees none of it, and only the owner can change it', async () => {
  const { t, v2 } = await world();
  const d = await ok(expense(t, v2.id, '94JB', '2026-08-10', 100000));
  const other = await register({ gstin: gstin('27ABCDE1234F1Z') });
  assert.deepEqual((await call('GET', '/tds/ns/deductions?fy=2026-27', undefined, other)).body.deductions, []);
  assert.equal((await call('DELETE', `/tds/ns/deductions/${d.id}`, undefined, other)).status, 404);
  assert.equal((await call('POST', '/tds/ns/quote', { partyId: v2.id, section: '94JB', amount: 100, date: '2026-08-10' }, other)).status, 400);
  assert.equal((await expense(other, v2.id, '94JB', '2026-08-10', 100)).status, 400);
  assert.equal((await call('GET', '/tds/26q?fy=2026-27&quarter=2&asOf=2026-10-20', undefined, other)).body.statement.totals.deducted, 0);
  assert.equal((await call('GET', '/tds/ns/sections')).status, 401);
});
