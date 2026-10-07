import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { gstinCheckChar } from '../src/gstin.js';
import { annualSummary, assessmentYear, build24q, monthsOrPart, quarterMonths, quarterOf, splitCess, statementDue, tdsDueDate, toCsv } from '../src/tds.js';

// ---------- pure ----------
test('quarters, dates and rounding helpers', () => {
  assert.deepEqual(quarterMonths('2025-26', 3), ['2025-10', '2025-11', '2025-12']);
  assert.deepEqual(quarterMonths('2025-26', 4), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(quarterMonths('2026-27', 1), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(['2026-04', '2026-06', '2026-07', '2026-12', '2027-01', '2027-03'].map(quarterOf), [1, 1, 2, 3, 4, 4]);
  assert.equal(assessmentYear('2025-26'), '2026-27');
  assert.deepEqual(['2025-12', '2026-01', '2026-03', '2025-04'].map(tdsDueDate), ['2026-01-07', '2026-02-07', '2026-04-30', '2025-05-07'], 'March TDS is due 30 April');
  assert.deepEqual([1, 2, 3, 4].map((q) => statementDue('2025-26', q)), ['2025-07-31', '2025-10-31', '2026-01-31', '2026-05-31']);
  assert.deepEqual([monthsOrPart('2026-04-30', '2026-06-10'), monthsOrPart('2026-04-30', '2026-04-30'), monthsOrPart('2025-12-31', '2026-02-10'), monthsOrPart('2026-01-31', '2026-02-01'), monthsOrPart('2026-01-10', '2026-02-10')], [2, 0, 2, 1, 1]);
  assert.deepEqual(splitCess(28275), { tax: 27188, cess: 1087 });
  assert.deepEqual(splitCess(12567), { tax: 12084, cess: 483 });
  assert.equal(splitCess(0).tax + splitCess(0).cess, 0);
  assert.equal(toCsv([{ a: 'x,y', b: 'say "hi"', c: null, d: 5 }], [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]), 'A,B,C,D\r\n"x,y","say ""hi""",,5\r\n');
});

const slips = (n, gross, tds, pt = 0, from = '2025-12') => Array.from({ length: n }, (_, i) => {
  const [y, m] = from.split('-').map(Number);
  const mo = ((m - 1 + i) % 12) + 1, yr = y + Math.floor((m - 1 + i) / 12);
  return { month: `${yr}-${String(mo).padStart(2, '0')}`, gross, tds, professional_tax: pt };
});

test('year-end computation (Form 16 Part B): new regime, rebate, marginal relief, old regime, shortfall and excess', () => {
  // 4 months x 4,00,000 = 16,00,000: taxable 15,25,000 = 20,000 + 40,000 + 48,750 = 1,08,750; cess 4,350
  const a = annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(4, 400000, 28275, 200) });
  assert.deepEqual([a.gross_salary, a.standard_deduction, a.tax_on_employment, a.deductions_16, a.income_from_salary, a.chapter_vi_a, a.taxable_income],
    [1600000, 75000, 0, 75000, 1525000, 0, 1525000]);
  assert.deepEqual([a.tax_on_income, a.rebate_87a, a.surcharge, a.cess, a.total_tax, a.net_tax_payable, a.tds_deducted, a.shortfall], [108750, 0, 0, 4350, 113100, 113100, 113100, 0]);
  assert.deepEqual([a.period_from, a.period_to, a.months, a.ay, a.regime], ['2025-12', '2026-03', 4, '2026-27', 'new']);
  assert.deepEqual(a.warnings, []);

  // 12,00,000: taxable 11,25,000, slab tax 52,500 wiped out by the rebate
  const r = annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(12, 100000, 0, 0, '2025-04') });
  assert.deepEqual([r.taxable_income, r.tax_on_income, r.rebate_87a, r.cess, r.total_tax], [1125000, 52500, 52500, 0, 0]);

  // 12,90,000: taxable 12,15,000, slab tax 62,250 limited by marginal relief to 15,000; cess 600
  const m = annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(12, 107500, 1300, 0, '2025-04') });
  assert.deepEqual([m.taxable_income, m.tax_on_income, m.rebate_87a, m.cess, m.total_tax, m.shortfall], [1215000, 62250, 47250, 600, 15600, 0]);

  // Old regime: 70,000 x 12 = 8,40,000; standard 50,000; professional tax 2,400; declared 1,50,000
  const oldSlips = slips(12, 70000, 0, 200, '2025-04');
  oldSlips[0].tds = 40000;                                   // ₹40,000 deducted over the year
  const o = annualSummary({ fy: '2025-26', employee: { tax_regime: 'old', declared_deductions: 150000 }, slips: oldSlips });
  assert.deepEqual([o.standard_deduction, o.tax_on_employment, o.deductions_16, o.income_from_salary, o.chapter_vi_a, o.taxable_income], [50000, 2400, 52400, 787600, 150000, 637600]);
  assert.deepEqual([o.tax_on_income, o.rebate_87a, o.cess, o.total_tax, o.shortfall], [40020, 0, 1601, 41621, 1621]);
  assert.match(o.warnings.join(' '), /HRA and LTA exemptions.*not tracked/);
  assert.match(o.warnings.join(' '), /₹1621 less than the tax/);

  const ex = annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(4, 400000, 30000) });
  assert.equal(ex.shortfall, -(30000 * 4 - 113100));
  assert.match(ex.warnings.join(' '), /more than the tax.*refund/);
  assert.equal(annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(3, 20000, 0) }).total_tax, 0);
});

test('partial payroll is called out: the months an employee was employed but have no finalized run', () => {
  const emp = (o) => ({ name: 'Esha', tax_regime: 'new', doj: '2025-04-01', exit_date: null, ...o });
  const w = (e, s, asOf = '2026-05-10') => annualSummary({ fy: '2025-26', employee: e, slips: s, asOf }).warnings.join(' | ');
  assert.match(w(emp(), slips(4, 400000, 28275)), /No finalized payroll for 2025-04, 2025-05, 2025-06 and 5 more month\(s\).*incomplete.*do not issue/);
  assert.equal(w(emp({ doj: '2025-12-01' }), slips(4, 400000, 28275)), '', 'employed for exactly the recorded months');
  assert.match(w(emp({ doj: '2025-12-15' }), slips(3, 400000, 28275, 0, '2026-01')), /No finalized payroll for 2025-12/, 'joined mid December: December is expected');
  assert.equal(w(emp({ doj: '2025-04-01', exit_date: '2025-06-20' }), slips(3, 50000, 0, 0, '2025-04')), '', 'a leaver is only expected up to the exit month');
  assert.match(w(emp({ doj: '2025-04-01', exit_date: '2025-06-20' }), slips(2, 50000, 0, 0, '2025-04')), /No finalized payroll for 2025-06/);
  assert.equal(w(emp({ doj: '2025-12-01' }), slips(2, 400000, 0, 0, '2025-12'), '2026-02-15'), '', 'months not yet over are not expected: as of mid-February only December and January are due');
  assert.match(w(emp({ doj: '2025-12-01' }), slips(1, 400000, 0, 0, '2025-12'), '2026-02-15'), /No finalized payroll for 2026-01/);
  assert.equal(annualSummary({ fy: '2025-26', employee: { tax_regime: 'new' }, slips: slips(1, 1000, 0) }).warnings.length, 0, 'no joining date, no check');
});

const company = { name: 'Demo', legal_name: 'Demo Pvt Ltd', gstin: '29ABCDE1234F1ZW', tan: 'HYDR12345A', pan: null, tds_person_name: 'A. Rao', tds_person_designation: 'Director', deductor_type: 'Company', addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001', email: 'a@b.in' };
const run = (o = {}) => ({ id: 1, month: '2025-12', paid_on: '2025-12-31', remitted_tds: '2026-01-05', tds_bsr: '0510308', tds_challan_serial: '00123', tds_interest: 0, tds_fee: 0, ...o });
const slip = (o = {}) => ({ run_id: 1, month: '2025-12', employee_id: 7, emp_code: 'EMP-001', emp_name: 'Esha', pan: 'ABCDE1234F', gross: 400000, tds: 28275, professional_tax: 200, ...o });
const q3 = (o = {}) => build24q({ company, fy: '2025-26', quarter: 3, runs: [run()], slips: [slip()], employees: [], statements: [], asOf: '2026-01-20', ...o });

test('24Q quarter: one challan per month with tax, deductee rows split into income tax and cess', () => {
  const { statement: s, errors, warnings } = q3();
  assert.deepEqual(errors, []);
  assert.deepEqual([s.form, s.fy, s.ay, s.quarter, s.due_date, s.period], ['24Q', '2025-26', '2026-27', 3, '2026-01-31', { from: '2025-10-01', to: '2025-12-31' }]);
  assert.deepEqual([s.deductor.tan, s.deductor.pan, s.deductor.name, s.deductor.responsible_person.name], ['HYDR12345A', 'ABCDE1234F', 'Demo Pvt Ltd', 'A. Rao']);
  assert.deepEqual(s.challans, [{ month: '2025-12', bsr: '0510308', challan_serial: '00123', date_deposited: '2026-01-05', tds_income_tax: 27188, surcharge: 0, cess: 1087, interest: 0, fee: 0, total_deposited: 28275, tds_deducted: 28275, due_date: '2026-01-07' }]);
  assert.deepEqual(s.deductees, [{ sr: 1, employee_code: 'EMP-001', pan: 'ABCDE1234F', name: 'Esha', section: '192', month: '2025-12', date_of_payment: '2025-12-31', amount_paid: 400000, date_of_deduction: '2025-12-31',
    date_of_deposit: '2026-01-05', tds_income_tax: 27188, surcharge: 0, cess: 1087, tds_total: 28275, challan_bsr: '0510308', challan_serial: '00123' }]);
  assert.deepEqual(s.totals, { deducted: 28275, deposited: 28275, challans: 1, deductee_rows: 1 });
  assert.equal(s.annexure2, null, 'Annexure II is only for the fourth quarter');
  assert.match(warnings.join(' '), /No finalized payroll for 2025-10, 2025-11/);
  assert.match(warnings.join(' '), /Part A is issued from TRACES/);
  assert.doesNotMatch(warnings.join(' '), /234E/, 'not yet due');
});

test('24Q checks: what blocks a statement and what is only estimated', () => {
  const errs = (o) => q3(o).errors.join(' | ');
  assert.match(errs({ company: { ...company, tan: null } }), /TAN is not set/);
  assert.match(errs({ company: { ...company, tan: 'BAD123' } }), /not in the TAN format/);
  assert.match(errs({ company: { ...company, tds_person_name: null } }), /person responsible/);
  assert.match(errs({ company: { ...company, addr1: null } }), /address is incomplete/);
  assert.match(errs({ company: { ...company, gstin: null, pan: null } }), /PAN is not set/);
  assert.equal(q3({ company: { ...company, pan: 'AAAAA1111A' } }).statement.deductor.pan, 'AAAAA1111A', 'an explicit PAN wins over the GSTIN');
  assert.match(errs({ runs: [run({ remitted_tds: null })] }), /TDS for 2025-12 \(₹28275\) has not been recorded as deposited/);
  assert.match(errs({ runs: [run({ tds_bsr: null })] }), /Challan details .* missing for the 2025-12/);
  assert.match(errs({ slips: [slip({ pan: null })] }), /Esha \(EMP-001\) has no PAN/);
  assert.match(errs({ asOf: '2025-12-15' }), /has not ended yet/);

  const late = q3({ runs: [run({ remitted_tds: '2026-02-10' })] }).warnings.join(' | ');
  assert.match(late, /deposited on 2026-02-10, after the due date 2026-01-07.*about ₹848/, '2 months at 1.5% of 28,275');
  assert.doesNotMatch(q3({ runs: [run({ remitted_tds: '2026-02-10', tds_interest: 900 })] }).warnings.join(), /about ₹848/, 'interest already paid on the challan');
  assert.match(q3({ asOf: '2026-10-06' }).warnings.join(), /234E.* about ₹28275/, '248 days at ₹200 is capped at the tax deducted');
  assert.match(q3({ asOf: '2026-02-05' }).warnings.join(), /234E.* about ₹1000/, '5 days late');
  assert.match(q3({ statements: [{ fy: '2025-26', quarter: 3, token_no: '123456789012345' }] }).warnings.join(), /already recorded as filed \(token 123456789012345\)/);
  assert.match(q3({ slips: [], runs: [] }).warnings.join(), /No tax was deducted/);
  // an employee with no tax deducted is not a deductee row
  assert.equal(q3({ slips: [slip(), slip({ employee_id: 8, emp_code: 'EMP-002', emp_name: 'Nil', tds: 0 })] }).statement.deductees.length, 1);
});

test('24Q Annexure II: every employee\'s year, on the fourth quarter only', () => {
  const four = ['2025-12', '2026-01', '2026-02', '2026-03'];
  const runs = four.map((month, i) => run({ id: i + 1, month, paid_on: `${month}-28`, remitted_tds: i === 3 ? '2026-04-25' : `${four[i + 1]}-05` }));
  const sl = four.map((month, i) => slip({ run_id: i + 1, month }));
  const nil = four.map((month, i) => slip({ run_id: i + 1, month, employee_id: 8, emp_code: 'EMP-002', emp_name: 'Nil Tax', pan: 'ZZZZZ9999Z', gross: 20000, tds: 0 }));
  const { statement: s, errors } = build24q({ company, fy: '2025-26', quarter: 4, runs, slips: [...sl, ...nil], employees: [{ id: 7, code: 'EMP-001', name: 'Esha', tax_regime: 'new' }, { id: 8, code: 'EMP-002', name: 'Nil Tax', tax_regime: 'new' }], asOf: '2026-05-10' });
  assert.deepEqual(errors, []);
  assert.deepEqual(s.challans.map((c) => [c.month, c.tds_deducted]), [['2026-01', 28275], ['2026-02', 28275], ['2026-03', 28275]]);
  assert.equal(s.deductees.length, 3, 'Dec is in the third quarter');
  assert.equal(s.totals.deducted, 84825);
  const [e, n] = s.annexure2;
  assert.deepEqual([e.employee_code, e.gross_salary, e.taxable_income, e.net_tax_payable, e.tds_deducted, e.shortfall], ['EMP-001', 1600000, 1525000, 113100, 113100, 0]);
  assert.deepEqual([n.employee_code, n.gross_salary, n.net_tax_payable, n.tds_deducted], ['EMP-002', 80000, 0, 0]);
  assert.equal(s.annexure2.length, 2);
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
const register = async (extra = {}) => (await call('POST', '/auth/register', { name: 'T', email: `tds${++seq}@example.com`, password: 'password123', company: `TDS Co ${seq}`, sector: 'trading', ...extra }, null)).body.token;

const lastOf = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const DEPOSITS = { '2025-12': '2026-01-05', '2026-01': '2026-02-05', '2026-02': '2026-03-12', '2026-03': '2026-04-25' };   // February is deposited late

/** FY 2025-26: Esha joins 1 Dec 2025 on ₹4,00,000 a month; four payroll months, each paid and its TDS deposited. */
async function year({ pan = 'ABCDE1234F', doj = '2025-12-01' } = {}) {
  const t = await register({ gstin: gstin('29ZYXWV5555Q1Z') });
  await ok(call('PUT', '/company/profile', { legalName: 'TDS Co Pvt Ltd', addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001' }, t));
  const e = await ok(call('POST', '/payroll/employees', { name: 'Esha', doj, basic: 200000, hra: 100000, special: 100000, ptMonthly: 200, ...(pan ? { pan } : {}) }, t));
  const runs = {};
  for (const month of Object.keys(DEPOSITS)) {
    const r = await ok(call('POST', '/payroll/runs', { month }, t));
    await ok(call('POST', `/payroll/runs/${r.id}/finalize`, {}, t));
    await ok(call('POST', `/payroll/runs/${r.id}/pay`, { mode: 'bank', date: lastOf(month) }, t));
    await ok(call('POST', `/payroll/runs/${r.id}/remit`, { head: 'tds', mode: 'bank', date: DEPOSITS[month] }, t));
    runs[month] = r;
  }
  return { t, e, runs };
}
const setup = (t) => call('PUT', '/tds/settings', { tan: 'hydr12345a', responsibleName: 'A. Rao', responsibleDesignation: 'Director', deductorType: 'Company' }, t);
const challan = (t, run, serial, extra = {}) => call('PUT', `/tds/runs/${run.id}/challan`, { bsr: '0510308', serial, ...extra }, t);
const q = (t, fy, n, extra = '') => call('GET', `/tds/24q?fy=${fy}&quarter=${n}&asOf=2026-01-20${extra}`, undefined, t);

test('setup and challans: validation, and a challan belongs to a recorded deposit', async () => {
  const { t, runs } = await year();
  assert.equal((await call('PUT', '/tds/settings', { tan: 'BAD' }, t)).status, 400);
  assert.equal((await call('PUT', '/tds/settings', { pan: 'abc' }, t)).status, 400);
  assert.equal((await call('PUT', '/tds/settings', { deductorType: 'Pirate' }, t)).status, 400);
  assert.equal((await call('PUT', '/tds/settings', {}, t)).status, 400);
  await ok(setup(t));
  const s = (await call('GET', '/tds/settings', undefined, t)).body;
  assert.deepEqual([s.tan, s.panFromGstin, s.responsibleName, s.deductorType, s.addressOk], ['HYDR12345A', 'ZYXWV5555Q', 'A. Rao', 'Company', true]);

  assert.equal((await challan(t, runs['2025-12'], '12')).status, 400, 'serial must be 5 digits');
  assert.equal((await call('PUT', `/tds/runs/${runs['2025-12'].id}/challan`, { bsr: '12', serial: '00123' }, t)).status, 400);
  assert.equal((await challan(t, runs['2025-12'], '00123', { interest: -5 })).status, 400);
  assert.equal((await challan(t, { id: 999999 }, '00123')).status, 404);

  // a run whose TDS has not been deposited cannot have a challan
  const t2 = await register({ gstin: gstin('29QWERT1234Y1Z') });
  await ok(call('POST', '/payroll/employees', { name: 'Undeposited', doj: '2025-12-01', basic: 200000, hra: 100000, special: 100000 }, t2));
  const open = await ok(call('POST', '/payroll/runs', { month: '2025-12' }, t2));
  await ok(call('POST', `/payroll/runs/${open.id}/finalize`, {}, t2));
  const early = await challan(t2, open, '00124');
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Record the TDS payment on the payroll run first/);

  await ok(challan(t, runs['2025-12'], '00123', { interest: 0, fee: 0 }));
  const list = (await call('GET', '/tds/runs?fy=2025-26', undefined, t)).body.runs;
  assert.deepEqual(list.map((x) => [x.month, x.quarter, x.tds, x.bsr, x.challanSerial, x.late]), [['2025-12', 3, 28275, '0510308', '00123', false], ['2026-01', 4, 28275, null, null, false], ['2026-02', 4, 28275, null, null, true], ['2026-03', 4, 28275, null, null, false]]);
  assert.equal(list[0].dueDate, '2026-01-07');
});

test('Form 24Q for a quarter: blockers first, then the full data with exact figures, CSV and JSON downloads', async () => {
  const { t, runs } = await year();
  const before = (await q(t, '2025-26', 3)).body;
  assert.match(before.errors.join(' | '), /TAN is not set.*person responsible.*Challan details/);

  await ok(setup(t));
  await ok(challan(t, runs['2025-12'], '00123'));
  const s = await ok(q(t, '2025-26', 3));
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.statement.deductor, { tan: 'HYDR12345A', pan: 'ZYXWV5555Q', name: 'TDS Co Pvt Ltd', type: 'Company', address: '12 MG Road, Bengaluru, 560001', email: null, phone: null, responsiblePerson: { name: 'A. Rao', designation: 'Director' } });
  assert.deepEqual(s.statement.challans.map((c) => [c.month, c.bsr, c.challanSerial, c.dateDeposited, c.tdsIncomeTax, c.cess, c.totalDeposited]), [['2025-12', '0510308', '00123', '2026-01-05', 27188, 1087, 28275]]);
  const d = s.statement.deductees[0];
  assert.deepEqual([d.pan, d.name, d.section, d.amountPaid, d.tdsTotal, d.dateOfPayment, d.dateOfDeposit], ['ABCDE1234F', 'Esha', '192', 400000, 28275, '2025-12-31', '2026-01-05']);
  assert.deepEqual(s.statement.totals, { deducted: 28275, deposited: 28275, challans: 1, deducteeRows: 1 });
  assert.equal(s.recorded, null);

  const csv = await call('GET', '/tds/24q/export?fy=2025-26&quarter=3&section=challans&asOf=2026-01-20', undefined, t, true);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /24Q_2025-26_Q3_challans\.csv/);
  assert.equal(await csv.text(), 'Month,BSR code,Challan serial no,Date of deposit,TDS (income tax),Surcharge,Education cess,Interest,Fee,Total deposited\r\n2025-12,0510308,00123,2026-01-05,27188,0,1087,0,0,28275\r\n');
  const ded = await (await call('GET', '/tds/24q/export?fy=2025-26&quarter=3&section=deductees&asOf=2026-01-20', undefined, t, true)).text();
  assert.match(ded.split('\r\n')[1], /^1,.*,ABCDE1234F,Esha,192,2025-12-31,400000,2025-12-31,27188,0,1087,28275,2026-01-05,0510308,00123$/);
  const js = await (await call('GET', '/tds/24q/export?fy=2025-26&quarter=3&section=json&asOf=2026-01-20', undefined, t, true)).json();
  assert.equal(js.totals.deducted, 28275);
  assert.equal((await call('GET', '/tds/24q/export?fy=2025-26&quarter=3&section=annexure2&asOf=2026-01-20', undefined, t)).status, 400, 'Annexure II is Q4 only');
  assert.equal((await call('GET', '/tds/24q/export?fy=2025-26&quarter=3&section=xml', undefined, t)).status, 400);

  assert.equal((await call('GET', '/tds/24q?fy=2025-26&quarter=5', undefined, t)).status, 400);
  assert.equal((await call('GET', '/tds/24q?fy=2025-27&quarter=1', undefined, t)).status, 400);
  assert.equal((await call('GET', '/tds/24q?fy=2025-26&quarter=3&asOf=soon', undefined, t)).status, 400);
});

test('fourth quarter: three challans, Annexure II with the year, a late deposit and the late-filing fee as warnings', async () => {
  const { t, runs } = await year();
  await ok(setup(t));
  await ok(challan(t, runs['2025-12'], '00123'));
  const blocked = (await call('GET', '/tds/24q?fy=2025-26&quarter=4&asOf=2026-05-10', undefined, t)).body;
  assert.match(blocked.errors.join(' | '), /Challan details .* missing for the 2026-01.*2026-02.*2026-03/);
  await ok(challan(t, runs['2026-01'], '00201'));
  await ok(challan(t, runs['2026-02'], '00202', { interest: 424 }));
  await ok(challan(t, runs['2026-03'], '00203'));

  const s = (await call('GET', '/tds/24q?fy=2025-26&quarter=4&asOf=2026-10-06', undefined, t)).body;
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.statement.challans.map((c) => [c.month, c.challanSerial, c.dateDeposited, c.totalDeposited]), [['2026-01', '00201', '2026-02-05', 28275], ['2026-02', '00202', '2026-03-12', 28699], ['2026-03', '00203', '2026-04-25', 28275]]);
  assert.equal(s.statement.totals.deducted, 84825);
  const a = s.statement.annexure2[0];
  assert.deepEqual([a.name, a.pan, a.periodFrom, a.periodTo, a.grossSalary, a.standardDeduction, a.taxableIncome, a.taxOnIncome, a.cess, a.netTaxPayable, a.tdsDeducted, a.shortfall],
    ['Esha', 'ABCDE1234F', '2025-12', '2026-03', 1600000, 75000, 1525000, 108750, 4350, 113100, 113100, 0]);
  const w = s.warnings.join(' | ');
  assert.doesNotMatch(w, /about ₹424/, 'the interest of ₹424 is already on the February challan');
  assert.match(w, /234E.*about ₹25600/, '128 days late');
  const csv = await (await call('GET', '/tds/24q/export?fy=2025-26&quarter=4&section=annexure2&asOf=2026-10-06', undefined, t, true)).text();
  assert.match(csv.split('\r\n')[1], /^EMP-001,ABCDE1234F,Esha,2025-12,2026-03,new,1600000,0,0,75000,0,1525000,0,1525000,108750,0,0,4350,113100,113100,0$/);

  // without the interest on the challan, the late deposit is flagged with an estimate
  await ok(challan(t, runs['2026-02'], '00202', { interest: 0 }));
  assert.match((await call('GET', '/tds/24q?fy=2025-26&quarter=4&asOf=2026-05-10', undefined, t)).body.warnings.join(), /2026-02 was deposited on 2026-03-12.*about ₹424/);
});

test('recording a filed statement: token number, compliance calendar, removal', async () => {
  const { t } = await year();
  await ok(call('PUT', '/compliance/settings', { tdsDeductor: true, trackFrom: '2025-04-01' }, t));
  const bad = (b) => call('POST', '/tds/24q/filed', { fy: '2025-26', quarter: 3, tokenNo: '123456789012345', filedOn: '2026-02-01', ...b }, t);
  assert.equal((await bad({ tokenNo: '12345' })).status, 400);
  assert.equal((await bad({ quarter: 5 })).status, 400);
  assert.equal((await bad({ fy: 'x' })).status, 400);
  assert.equal((await bad({ filedOn: 'yesterday' })).status, 400);
  assert.equal((await bad()).status, 201);
  assert.equal((await bad()).status, 409, 'one statement per quarter');

  const cal = (await call('GET', '/compliance?fy=2025-26', undefined, t)).body.items;
  const item = cal.find((i) => i.ruleCode === 'TDS_RET' && i.periodKey === '2025-Q3');
  assert.deepEqual([item.status, item.reference, item.completedOn], ['completed', '123456789012345', '2026-02-01']);
  assert.equal(cal.find((i) => i.ruleCode === 'FORM16').due, '2026-06-15', 'Form 16 is due on 15 June after the year');

  const list = (await call('GET', '/tds/statements', undefined, t)).body;
  assert.deepEqual([list.length, list[0].tokenNo, list[0].fy, list[0].quarter], [1, '123456789012345', '2025-26', 3]);
  assert.equal((await q(t, '2025-26', 3)).body.recorded.tokenNo, '123456789012345');
  assert.match((await q(t, '2025-26', 3)).body.warnings.join(), /already recorded as filed/);

  await ok(call('DELETE', `/tds/statements/${list[0].id}`, undefined, t));
  const after = (await call('GET', '/compliance?fy=2025-26', undefined, t)).body.items.find((i) => i.ruleCode === 'TDS_RET' && i.periodKey === '2025-Q3');
  assert.notEqual(after.status, 'completed', 'the calendar item is reopened');
  assert.equal((await call('DELETE', `/tds/statements/${list[0].id}`, undefined, t)).status, 404);
});

test('Form 16 Part B for an employee: every line, month-wise tax with its challan, and the Part A summary', async () => {
  const { t, e, runs } = await year();
  await ok(setup(t));
  for (const [m, s] of [['2025-12', '00123'], ['2026-01', '00201'], ['2026-02', '00202'], ['2026-03', '00203']]) await ok(challan(t, runs[m], s));
  await ok(call('POST', '/tds/24q/filed', { fy: '2025-26', quarter: 3, tokenNo: '111111111111111', filedOn: '2026-01-25' }, t));

  const list = (await call('GET', '/tds/form16?fy=2025-26', undefined, t)).body;
  assert.equal(list.ay, '2026-27');
  assert.deepEqual(list.employees.map((x) => [x.code, x.pan, x.regime, x.months, x.grossSalary, x.taxableIncome, x.totalTax, x.tdsDeducted, x.shortfall]), [['EMP-001', 'ABCDE1234F', 'new', 4, 1600000, 1525000, 113100, 113100, 0]]);

  const f = (await call('GET', `/tds/form16/${e.id}?fy=2025-26`, undefined, t)).body;
  assert.deepEqual(f.employee, { id: e.id, code: 'EMP-001', name: 'Esha', pan: 'ABCDE1234F', designation: null });
  assert.deepEqual([f.deductor.name, f.deductor.tan, f.deductor.pan, f.deductor.responsiblePerson, f.ay], ['TDS Co Pvt Ltd', 'HYDR12345A', 'ZYXWV5555Q', 'A. Rao', '2026-27']);
  const b = f.partB;
  assert.deepEqual([b.grossSalary, b.perquisites, b.exemptAllowances, b.standardDeduction, b.taxOnEmployment, b.deductions16, b.incomeFromSalary, b.otherIncome, b.grossTotalIncome, b.chapterViA, b.taxableIncome],
    [1600000, 0, 0, 75000, 0, 75000, 1525000, 0, 1525000, 0, 1525000]);
  assert.deepEqual([b.taxOnIncome, b.rebate87a, b.surcharge, b.cess, b.totalTax, b.relief89, b.netTaxPayable, b.tdsDeducted, b.shortfall], [108750, 0, 0, 4350, 113100, 0, 113100, 113100, 0]);
  assert.deepEqual(f.monthly.map((m) => [m.month, m.gross, m.tds, m.depositedOn, m.bsr, m.challanSerial]), [
    ['2025-12', 400000, 28275, '2026-01-05', '0510308', '00123'], ['2026-01', 400000, 28275, '2026-02-05', '0510308', '00201'],
    ['2026-02', 400000, 28275, '2026-03-12', '0510308', '00202'], ['2026-03', 400000, 28275, '2026-04-25', '0510308', '00203']]);
  assert.deepEqual(f.partASummary.map((x) => [x.quarter, x.tdsDeducted, x.tdsDeposited, x.tokenNo]), [[1, 0, 0, null], [2, 0, 0, null], [3, 28275, 28275, '111111111111111'], [4, 84825, 84825, null]]);
  assert.match(f.warnings.join(), /Part A of Form 16 is issued from TRACES/);

  assert.equal((await call('GET', `/tds/form16/${e.id}?fy=2024-25`, undefined, t)).status, 404, 'no payroll that year');
  assert.equal((await call('GET', '/tds/form16/999999?fy=2025-26', undefined, t)).status, 404);
  assert.equal((await call('GET', `/tds/form16/${e.id}?fy=bad`, undefined, t)).status, 400);
});

test('Form 16 flags an employee whose payroll for the year is incomplete', async () => {
  const { t, e } = await year({ doj: '2025-04-01' });          // employed all year, but IBMP only has December to March
  const list = (await call('GET', '/tds/form16?fy=2025-26&asOf=2026-05-10', undefined, t)).body.employees;
  assert.equal(list[0].incomplete, true);
  const f = (await call('GET', `/tds/form16/${e.id}?fy=2025-26&asOf=2026-05-10`, undefined, t)).body;
  assert.match(f.warnings.join(' | '), /No finalized payroll for 2025-04, 2025-05, 2025-06 and 5 more month/);
  assert.equal(f.partB.months, 4);
  const complete = await year();                                // joined 1 December: nothing is missing
  assert.equal((await call('GET', '/tds/form16?fy=2025-26&asOf=2026-05-10', undefined, complete.t)).body.employees[0].incomplete, false);
});

test('a missing PAN blocks the statement and warns on Form 16; another company sees nothing of this one', async () => {
  const { t, e, runs } = await year({ pan: null });
  await ok(setup(t));
  await ok(challan(t, runs['2025-12'], '00123'));
  const s = (await q(t, '2025-26', 3)).body;
  assert.match(s.errors.join(' | '), /Esha \(EMP-001\) has no PAN/);
  assert.equal(s.statement.deductees[0].pan, null);
  const f = (await call('GET', `/tds/form16/${e.id}?fy=2025-26`, undefined, t)).body;
  assert.match(f.warnings.join(' '), /has no PAN/);
  assert.equal(f.employee.pan, null);

  await ok(call('PUT', `/payroll/employees/${e.id}`, { pan: 'ABCDE1234F' }, t));
  // A PAN added after payroll was finalized is what gets reported: the statement uses the current record.
  const fixed = (await q(t, '2025-26', 3)).body;
  assert.deepEqual(fixed.errors, []);
  assert.equal(fixed.statement.deductees[0].pan, 'ABCDE1234F');
  assert.equal((await call('GET', `/tds/form16/${e.id}?fy=2025-26`, undefined, t)).body.employee.pan, 'ABCDE1234F');

  const other = await register({ gstin: gstin('29LKJHG9999P1Z') });
  assert.deepEqual((await call('GET', '/tds/form16?fy=2025-26', undefined, other)).body.employees, []);
  assert.deepEqual((await call('GET', '/tds/runs?fy=2025-26', undefined, other)).body.runs, []);
  assert.equal((await call('GET', `/tds/form16/${e.id}?fy=2025-26`, undefined, other)).status, 404);
  assert.equal((await q(other, '2025-26', 3)).body.statement.totals.deducted, 0);
  assert.equal((await call('GET', '/tds/statements', undefined, other)).body.length, 0);
  assert.equal((await call('PUT', `/tds/runs/${runs['2025-12'].id}/challan`, { bsr: '0510308', serial: '00123' }, other)).status, 404, 'not their run');
});
