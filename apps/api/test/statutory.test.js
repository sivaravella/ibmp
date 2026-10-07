import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { buildEcr, buildEsi, ecrCsv, ecrName, esiCsv, periodLabel } from '../src/statutory.js';

// ---------- pure ----------
const run = (o = {}) => ({ id: 1, month: '2026-04', pf_admin: 500, pf_employee: 3240, pf_employer: 3240, edli: 135, esi_employee: 143, esi_employer: 618, ...o });
const slipC = (o = {}) => ({ employee_id: 1, emp_code: 'EMP-001', emp_name: 'Chitra', uan: null, gross: 150000, pf_wages: 15000, pf_employee: 1800, pf_eps: 1250, pf_epf: 550, edli: 75, days_in_month: 30, paid_days: 30, esi_covered: false, esi_employee: 0, esi_employer: 0, ...o });
const slipD = (o = {}) => ({ employee_id: 2, emp_code: 'EMP-002', emp_name: 'Dev', uan: null, gross: 19000, pf_wages: 12000, pf_employee: 1440, pf_eps: 1000, pf_epf: 440, edli: 60, days_in_month: 30, paid_days: 30, esi_covered: true, esi_employee: 143, esi_employer: 618, ...o });
const emps = (o1 = {}, o2 = {}) => [{ id: 1, uan: '100200300400', esi_no: null, exit_date: null, ...o1 }, { id: 2, uan: '100200300401', esi_no: '1234567890', exit_date: null, ...o2 }];
const ecr = (o = {}) => buildEcr({ month: '2026-04', run: run(), slips: [slipC(), slipD()], employees: emps(), ...o });
const esi = (o = {}) => buildEsi({ month: '2026-04', run: run(), slips: [slipC(), slipD()], employees: emps(), ...o });

test('ECR: the 11-field "#~#" line, exact figures, and the challan by EPFO account', () => {
  const e = ecr();
  assert.deepEqual(e.errors, []);
  assert.equal(e.text,
    '100200300400#~#CHITRA#~#150000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0\r\n' +
    '100200300401#~#DEV#~#19000#~#12000#~#12000#~#12000#~#1440#~#1000#~#440#~#0#~#0\r\n');
  assert.equal(e.text.split('\r\n')[0].split('#~#').length, 11);
  // A/c 01 = members' 12% (1,800 + 1,440) + employers' EPF share (550 + 440); A/c 10 = EPS; A/c 02 admin; A/c 21 EDLI (75 + 60)
  assert.deepEqual(e.challan, { ac01_employee: 3240, ac01_employer: 990, ac10_eps: 2250, ac02_admin: 500, ac21_edli: 135, ac22_edli_admin: 0, total: 7115 });
  assert.deepEqual(e.totals, { members: 2, gross: 169000, epf_wages: 27000, eps_wages: 27000, ncp_days: 0 });
  assert.equal(periodLabel('2026-09'), '092026');
  assert.match(ecrCsv(e.rows), /^UAN,Member name,Gross wages,EPF wages,EPS wages,EDLI wages,EPF contribution \(member\),EPS contribution,EPF-EPS difference \(employer\),NCP days,Refund of advances\r\n100200300400,CHITRA,150000,/);
});

test('ECR: loss of pay becomes non-contributory days; higher wages cap EPS and EDLI; names are cleaned', () => {
  // 3 days of loss of pay: wages 17,100, PF on 10,800
  const lop = ecr({ slips: [slipD({ gross: 17100, pf_wages: 10800, pf_employee: 1296, pf_eps: 900, pf_epf: 396, paid_days: 27, edli: 54 })], run: run({ pf_admin: 500, pf_employee: 1296, pf_employer: 1296, edli: 54 }) });
  assert.deepEqual(lop.errors, []);
  assert.equal(lop.text, '100200300401#~#DEV#~#17100#~#10800#~#10800#~#10800#~#1296#~#900#~#396#~#3#~#0\r\n');

  // contributing on actual wages of 40,000: EPF on all of it, but EPS and EDLI wages stop at 15,000
  const high = ecr({ slips: [slipC({ gross: 50000, pf_wages: 40000, pf_employee: 4800, pf_eps: 1250, pf_epf: 3550, edli: 75 })], run: run({ pf_employee: 4800, pf_employer: 4800, edli: 75 }) });
  const r = high.rows[0];
  assert.deepEqual([r.epf_wages, r.eps_wages, r.edli_wages, r.epf_ee, r.eps, r.epf_er_diff], [40000, 15000, 15000, 4800, 1250, 3550]);
  assert.match(high.warnings.join(), /above ₹15,000/);

  const half = ecr({ slips: [slipD({ paid_days: 27.5 })] });
  assert.equal(half.rows[0].ncp_days, 3, '2.5 days rounds to 3');
  assert.match(half.warnings.join(), /part-day loss of pay/);

  assert.equal(ecrName("Chitra K. D'Souza-Rao 2"), 'CHITRA K. DSOUZARAO');
  assert.equal(ecrName('  anil   kumar '), 'ANIL KUMAR');
  const renamed = ecr({ slips: [slipC({ emp_name: "Chitra D'Souza" })] });
  assert.equal(renamed.rows[0].name, 'CHITRA DSOUZA');
  assert.match(renamed.warnings.join(), /1 name\(s\) were changed/);
  assert.equal(ecr({ slips: [slipC({ emp_name: '12345' })] }).errors.some((x) => /no usable letters/.test(x)), true);
});

test('ECR checks: UAN missing, malformed or duplicated; the master UAN wins; non-members left out; totals must tie', () => {
  const errs = (o) => ecr(o).errors.join(' | ');
  assert.match(errs({ employees: emps({ uan: null }) }), /Chitra \(EMP-001\) has no UAN/);
  assert.match(errs({ employees: emps({ uan: '12345' }) }), /"12345" is not a 12-digit number/);
  assert.match(errs({ employees: emps({}, { uan: '100200300400' }) }), /same UAN 100200300400/);
  assert.equal(ecr({ slips: [slipC({ uan: '999888777666' })], employees: [{ id: 1, uan: '111222333444' }] }).rows[0].uan, '111222333444', 'a corrected UAN is used');
  assert.equal(ecr({ slips: [slipC({ uan: '999888777666' })], employees: [] }).rows[0].uan, '999888777666', 'the payslip is the fallback');

  const nonMember = ecr({ slips: [slipC(), slipD({ pf_wages: 0, pf_employee: 0, pf_eps: 0, pf_epf: 0, edli: 0 })], run: run({ pf_employee: 1800, pf_employer: 1800, edli: 75 }) });
  assert.equal(nonMember.rows.length, 1);
  assert.match(errs({ run: run({ pf_employee: 3000 }) }), /do not add up to the payroll run's PF totals/);
  assert.match(errs({ run: run({ pf_employer: 3000 }) }), /do not add up to the payroll run's PF totals/);
  assert.match(errs({ run: run({ edli: 100 }) }), /do not add up to the payroll run's PF totals/);
  assert.deepEqual(ecr({ run: run({ pf_admin: 600 }) }).errors, [], 'the admin charge is the run\'s own figure');
  assert.equal(ecr({ run: run({ pf_admin: 600 }) }).challan.total, 7215);
  assert.deepEqual(buildEcr({ month: '2026-04', run: null, slips: [], employees: [] }).errors, ['There is no finalized payroll for 2026-04.']);
  assert.match(ecr({ slips: [], run: run({ pf_employee: 0, pf_employer: 0, edli: 0, pf_admin: 0 }) }).warnings.join(), /nothing to upload/);
});

test('ESI: covered employees only, in the template\'s columns; reason codes for zero days; leavers', () => {
  const e = esi();
  assert.deepEqual(e.errors, []);
  assert.deepEqual(e.rows, [{ ip_number: '1234567890', name: 'Dev', days: 30, wages: 19000, reason_code: 0, last_working_day: '', employee_code: 'EMP-002', ee: 143, er: 618 }]);
  assert.deepEqual(e.summary, { members: 1, wages: 19000, employee_contribution: 143, employer_contribution: 618, total: 761 });
  assert.equal(esiCsv(e.rows),
    'IP Number,IP Name,No of Days for which wages paid/payable during the month,Total Monthly Wages,Reason Code for Zero workings days(numeric only; provide 0 for all other reasons),Last Working Day (Format DD/MM/YYYY or DD-MM-YYYY)\r\n' +
    '1234567890,Dev,30,19000,0,\r\n');

  // 3 days of loss of pay: days 27, wages 17,100, contribution 129 + 556
  const lop = esi({ slips: [slipD({ gross: 17100, paid_days: 27, esi_employee: 129, esi_employer: 556 })], run: run({ esi_employee: 129, esi_employer: 556 }) });
  assert.deepEqual([lop.rows[0].days, lop.rows[0].wages, lop.rows[0].reason_code], [27, 17100, 0]);

  const none = (o) => esi({ slips: [slipD({ gross: 0, paid_days: 0, esi_employee: 0, esi_employer: 0 })], employees: emps({}, o), run: run({ esi_employee: 0, esi_employer: 0 }) }).rows[0];
  assert.deepEqual([none({}).days, none({}).reason_code], [0, 1], 'no wages and still employed: on leave');
  const left = none({ exit_date: '2026-04-05' });
  assert.deepEqual([left.reason_code, left.last_working_day], [2, '05/04/2026'], 'no wages and left: left service');
  const leaver = esi({ slips: [slipD({ paid_days: 10, gross: 6333, esi_employee: 48, esi_employer: 206 })], employees: emps({}, { exit_date: '2026-04-10' }), run: run({ esi_employee: 48, esi_employer: 206 }) }).rows[0];
  assert.deepEqual([leaver.days, leaver.reason_code, leaver.last_working_day], [10, 0, '10/04/2026'], 'paid part of the month: last working day, no reason');
  assert.equal(esi({ slips: [slipD({ paid_days: 27.5 })] }).rows[0].days, 28);
  assert.match(esi({ slips: [slipD({ paid_days: 27.5 })] }).warnings.join(), /rounded up to 28/);
});

test('ESI checks: insurance number format, duplicates and totals', () => {
  const errs = (o) => esi(o).errors.join(' | ');
  assert.match(errs({ employees: emps({}, { esi_no: null }) }), /has no ESI insurance number/);
  assert.match(errs({ employees: emps({}, { esi_no: '12345' }) }), /must be 10 or 17 digits/);
  assert.deepEqual(esi({ employees: emps({}, { esi_no: '12345678901234567' }) }).errors, [], 'a 17-digit number is fine');
  assert.match(errs({ slips: [slipD(), slipD({ employee_id: 3, emp_code: 'EMP-003', emp_name: 'Twin' })], employees: [...emps(), { id: 3, esi_no: '1234567890', exit_date: null }], run: run({ esi_employee: 286, esi_employer: 1236 }) }), /same ESI number/);
  assert.match(errs({ run: run({ esi_employer: 700 }) }), /do not add up to the payroll run's ESI total/);
  assert.match(esi({ slips: [slipC()], run: run({ esi_employee: 0, esi_employer: 0 }) }).warnings.join(), /nothing to upload/);
});

// ---------- API ----------
let call, seq = 0;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
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
const register = async () => (await call('POST', '/auth/register', { name: 'S', email: `stat${++seq}@example.com`, password: 'password123', company: `Stat Co ${seq}`, sector: 'trading', stateCode: '29' }, null)).body.token;

async function month({ uanC = '100200300400', month: m = '2026-04' } = {}) {
  const t = await register();
  const C = await ok(call('POST', '/payroll/employees', { name: 'Chitra', doj: '2024-01-01', basic: 75000, hra: 30000, special: 45000, ...(uanC ? { uan: uanC } : {}) }, t));
  const D = await ok(call('POST', '/payroll/employees', { name: 'Dev', doj: '2020-01-01', basic: 12000, hra: 4000, special: 3000, uan: '100200300401', esiNo: '1234567890' }, t));
  const r = await ok(call('POST', '/payroll/runs', { month: m }, t));
  return { t, C, D, run: r };
}
const finalize = (t, r) => ok(call('POST', `/payroll/runs/${r.id}/finalize`, {}, t));
const remit = (t, r, head, date) => ok(call('POST', `/payroll/runs/${r.id}/remit`, { head, mode: 'bank', date }, t));

test('employee identifiers are validated when entered', async () => {
  const t = await register();
  const base = { name: 'X', doj: '2024-01-01', basic: 20000 };
  assert.equal((await call('POST', '/payroll/employees', { ...base, uan: '12345' }, t)).status, 400);
  assert.equal((await call('POST', '/payroll/employees', { ...base, uan: '12345678901a' }, t)).status, 400);
  assert.equal((await call('POST', '/payroll/employees', { ...base, esiNo: '123' }, t)).status, 400);
  const good = await call('POST', '/payroll/employees', { ...base, uan: '100200300400', esiNo: '12345678901234567' }, t);
  assert.equal(good.status, 201);
  assert.equal((await call('PUT', `/payroll/employees/${good.body.id}`, { uan: 'abc' }, t)).status, 400);
  assert.equal((await call('PUT', `/payroll/employees/${good.body.id}`, { uan: null }, t)).status, 200, 'a UAN can be cleared');
});

test('ECR and ESI files from a finalized month: exact content, downloads, and a draft is refused', async () => {
  const { t, run: r } = await month();
  const draft = (await call('GET', '/statutory/pf?month=2026-04', undefined, t)).body;
  assert.match(draft.errors[0], /still a draft: finalize it first/);
  assert.equal((await call('GET', '/statutory/pf/export?month=2026-04', undefined, t)).status, 409);
  assert.match((await call('GET', '/statutory/pf?month=2026-09', undefined, t)).body.errors[0], /no finalized payroll for 2026-09/);
  assert.equal((await call('GET', '/statutory/pf?month=2026-13', undefined, t)).status, 400);

  await finalize(t, r);
  const pf = (await call('GET', '/statutory/pf?month=2026-04', undefined, t)).body;
  assert.deepEqual(pf.errors, []);
  assert.equal(pf.fileName, 'ECR_042026.txt');
  assert.deepEqual(pf.challan, { ac01Employee: 3240, ac01Employer: 990, ac10Eps: 2250, ac02Admin: 500, ac21Edli: 135, ac22EdliAdmin: 0, total: 7115 });
  assert.deepEqual([pf.totals.members, pf.totals.gross, pf.run.dueDate, pf.run.status], [2, 169000, '2026-05-15', 'finalized']);

  const file = await call('GET', '/statutory/pf/export?month=2026-04', undefined, t, true);
  assert.match(file.headers.get('content-type'), /text\/plain/);
  assert.match(file.headers.get('content-disposition'), /ECR_042026\.txt/);
  assert.equal(await file.text(),
    '100200300400#~#CHITRA#~#150000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0\r\n100200300401#~#DEV#~#19000#~#12000#~#12000#~#12000#~#1440#~#1000#~#440#~#0#~#0\r\n');
  const csv = await (await call('GET', '/statutory/pf/export?month=2026-04&format=csv', undefined, t, true)).text();
  assert.match(csv.split('\r\n')[1], /^100200300400,CHITRA,150000,15000,15000,15000,1800,1250,550,0,0$/);
  assert.equal((await call('GET', '/statutory/pf/export?month=2026-04&format=xml', undefined, t)).status, 400);

  const e = (await call('GET', '/statutory/esi?month=2026-04', undefined, t)).body;
  assert.deepEqual([e.fileName, e.rows.length, e.summary.total, e.errors], ['ESI_042026.csv', 1, 761, []]);
  const ecsv = await call('GET', '/statutory/esi/export?month=2026-04', undefined, t, true);
  assert.match(ecsv.headers.get('content-disposition'), /ESI_042026\.csv/);
  assert.equal((await ecsv.text()).split('\r\n')[1], '1234567890,Dev,30,19000,0,');
});

test('a missing UAN blocks the ECR; a UAN fixed after payroll is the one exported', async () => {
  const { t, C, run: r } = await month({ uanC: null });
  await finalize(t, r);
  const pf = (await call('GET', '/statutory/pf?month=2026-04', undefined, t)).body;
  assert.match(pf.errors.join(), /Chitra \(EMP-001\) has no UAN/);
  const blocked = await call('GET', '/statutory/pf/export?month=2026-04', undefined, t);
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'VALIDATION']);

  await ok(call('PUT', `/payroll/employees/${C.id}`, { uan: '100200300499' }, t));
  const fixed = await call('GET', '/statutory/pf/export?month=2026-04', undefined, t, true);
  assert.equal(fixed.status, 200);
  assert.match((await fixed.text()).split('\r\n')[0], /^100200300499#~#CHITRA#~#/);

  // ESI: the insurance number is also taken from the employee record
  const { t: t2, run: r2 } = await month();
  await finalize(t2, r2);
  const emps = (await call('GET', '/payroll/employees', undefined, t2)).body;
  await ok(call('PUT', `/payroll/employees/${emps.find((x) => x.name === 'Dev').id}`, { esiNo: null }, t2));
  assert.match((await call('GET', '/statutory/esi?month=2026-04', undefined, t2)).body.errors.join(), /Dev \(EMP-002\) has no ESI insurance number/);
  assert.equal((await call('GET', '/statutory/esi/export?month=2026-04', undefined, t2)).status, 409);
});

test('portal references: stored, and completing the calendar item only once the payment is recorded', async () => {
  const { t, run: r } = await month();
  await ok(call('PUT', '/compliance/settings', { pf: true, esi: true, trackFrom: '2026-04-01' }, t));
  await finalize(t, r);
  const item = async (rule) => (await call('GET', '/compliance?fy=2026-27', undefined, t)).body.items.find((i) => i.ruleCode === rule && i.periodKey === '2026-04');

  assert.equal((await call('PUT', `/statutory/runs/${r.id}/refs`, { pfTrrn: '123' }, t)).status, 400);
  assert.equal((await call('PUT', `/statutory/runs/${r.id}/refs`, {}, t)).status, 400);
  assert.equal((await call('PUT', '/statutory/runs/999999/refs', { pfTrrn: '1234567890123' }, t)).status, 404);

  await ok(call('PUT', `/statutory/runs/${r.id}/refs`, { pfTrrn: '1234567890123', esiChallan: 'ESI-2026-0042' }, t));
  assert.notEqual((await item('PF')).status, 'completed', 'a reference alone does not mean the money was paid');

  await remit(t, r, 'pf', '2026-05-20');                      // five days after the 15th
  await remit(t, r, 'esi', '2026-05-12');
  await ok(call('PUT', `/statutory/runs/${r.id}/refs`, { pfTrrn: '1234567890123', esiChallan: 'ESI-2026-0042' }, t));
  const pf = await item('PF'), esiItem = await item('ESI');
  assert.deepEqual([pf.status, pf.reference, pf.completedOn, pf.filedLate], ['completed', '1234567890123', '2026-05-20', true]);
  assert.deepEqual([esiItem.status, esiItem.reference, esiItem.completedOn, esiItem.filedLate], ['completed', 'ESI-2026-0042', '2026-05-12', false]);

  const ov = (await call('GET', '/statutory/overview?fy=2026-27', undefined, t)).body.months;
  assert.deepEqual(ov.map((m) => [m.month, m.pf.amount, m.pf.remittedOn, m.pf.trrn, m.pf.late, m.esi.amount, m.esi.challan, m.esi.late, m.dueDate]), [['2026-04', 7115, '2026-05-20', '1234567890123', true, 761, 'ESI-2026-0042', false, '2026-05-15']]);
  assert.equal((await call('GET', '/statutory/overview?fy=2026-28', undefined, t)).status, 400);

  const pfView = (await call('GET', '/statutory/pf?month=2026-04', undefined, t)).body.run;
  assert.deepEqual([pfView.remittedOn, pfView.reference, pfView.late], ['2026-05-20', '1234567890123', true]);
});

test('another company sees nothing of this one', async () => {
  const { t, run: r } = await month();
  await finalize(t, r);
  const other = await register();
  assert.match((await call('GET', '/statutory/pf?month=2026-04', undefined, other)).body.errors[0], /no finalized payroll/);
  assert.equal((await call('GET', '/statutory/esi/export?month=2026-04', undefined, other)).status, 409);
  assert.deepEqual((await call('GET', '/statutory/overview?fy=2026-27', undefined, other)).body.months, []);
  assert.equal((await call('PUT', `/statutory/runs/${r.id}/refs`, { pfTrrn: '1234567890123' }, other)).status, 404);
});

test('PF and ESI files are part of the HR plan: a Starter subscription is refused', async () => {
  const t = await register();
  // Move this company to Starter: HR features are not included
  const c = await ok(call('POST', '/billing/checkout', { plan: 'starter', months: 1 }, t));
  await ok(call('POST', '/billing/dev/simulate', { orderId: c.order.orderId, outcome: 'success' }, t));
  const r = await call('GET', '/statutory/pf?month=2026-04', undefined, t);
  assert.deepEqual([r.status, r.body.code, r.body.requiredPlan], [402, 'PLAN_REQUIRED', 'professional']);
  assert.equal((await call('GET', '/statutory/esi/export?month=2026-04', undefined, t)).status, 402);
});
