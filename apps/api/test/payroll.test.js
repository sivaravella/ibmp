import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';

let base, token, pool;
const api = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (email, extra = {}) => (await api('POST', '/auth/register', {
  name: 'P', email, password: 'password123', company: `Co ${email}`, sector: 'trading', stateCode: '29', ...extra,
}, null)).body.token;

before(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  token = await register('payroll@example.com');
});

const bal = async (code, tok = token) => Number((await api('GET', '/accounts', null, tok)).body.find((a) => a.code === code).balance);
let C, D, run;

test('employee master: validation, auto codes, updates, isolation', async () => {
  C = await ok(api('POST', '/payroll/employees', { name: 'Chitra', doj: '2024-01-01', basic: 75000, hra: 30000, special: 45000, ptMonthly: 200, pan: 'ABCDE1234F', ifsc: 'HDFC0001234', bankAccount: '123456789012' }));
  D = await ok(api('POST', '/payroll/employees', { name: 'Dev', doj: '2020-01-01', basic: 12000, hra: 4000, special: 3000 }));
  assert.deepEqual([C.code, D.code], ['EMP-001', 'EMP-002']);
  assert.deepEqual([C.pfApplicable, C.taxRegime, C.doj], [true, 'new', '2024-01-01']);

  const bad = (b) => api('POST', '/payroll/employees', { name: 'X', doj: '2024-01-01', basic: 1000, ...b });
  assert.equal((await bad({ pan: 'bad' })).status, 400);
  assert.equal((await bad({ ifsc: 'HDFC1234' })).status, 400);
  assert.equal((await bad({ basic: 0 })).status, 400);
  assert.equal((await bad({ code: 'EMP-001' })).status, 409);
  assert.equal((await bad({ exitDate: '2023-01-01' })).status, 400);
  assert.equal((await api('POST', '/payroll/employees', { name: 'No salary', doj: '2024-01-01' })).status, 400);

  const up = await ok(api('PUT', `/payroll/employees/${D.id}`, { designation: 'Clerk', ptMonthly: 0 }));
  assert.deepEqual([up.designation, up.name], ['Clerk', 'Dev'], 'partial update keeps other fields');
  assert.equal((await api('PUT', `/payroll/employees/${D.id}`, { exitDate: '2019-01-01' })).status, 400);
  assert.equal((await api('PUT', `/payroll/employees/${D.id}`, {})).status, 400);

  const other = await register('other-payroll@example.com');
  assert.equal((await api('GET', `/payroll/employees/${C.id}`, null, other)).status, 404);
  assert.equal((await api('PUT', `/payroll/employees/${C.id}`, { name: 'Hacked' }, other)).status, 404);
  assert.equal((await api('GET', '/payroll/employees', null, other)).body.length, 0);
});

test('run creation: guards, slips and totals', async () => {
  assert.equal((await api('POST', '/payroll/runs', { month: '2999-01' })).status, 400, 'future month');
  assert.equal((await api('POST', '/payroll/runs', { month: '2026-4' })).status, 400, 'bad format');
  const empty = await register('empty-payroll@example.com');
  assert.equal((await api('POST', '/payroll/runs', { month: '2026-04' }, empty)).status, 400, 'no employees');

  run = await ok(api('POST', '/payroll/runs', { month: '2026-04' }));
  assert.equal(run.status, 'draft');
  assert.equal((await api('POST', '/payroll/runs', { month: '2026-04' })).status, 409, 'one run per month');

  const d = (await api('GET', `/payroll/runs/${run.id}`)).body;
  assert.equal(d.slips.length, 2);
  const c = d.slips.find((s) => s.empCode === 'EMP-001'), dv = d.slips.find((s) => s.empCode === 'EMP-002');
  assert.deepEqual([c.gross, c.pfEmployee, c.pfEps, c.pfEpf, c.edli, c.professionalTax, c.tds, c.net].map(Number),
    [150000, 1800, 1250, 550, 75, 200, 12567, 135433]);
  assert.deepEqual([dv.gross, dv.pfEmployee, dv.esiEmployee, dv.esiEmployer, dv.tds, dv.net].map(Number), [19000, 1440, 143, 618, 0, 17417]);
  assert.deepEqual([c.empName, c.pan, c.bankAccount], ['Chitra', 'ABCDE1234F', '123456789012']);
  assert.deepEqual(d.dueDates, { pf: '2026-05-15', esi: '2026-05-15', tds: '2026-05-07' });
  assert.deepEqual([d.taxTable.fy, d.taxTable.verified], ['2026-27', false]);
  assert.equal(d.company.name.startsWith('Co payroll'), true);
});

test('draft edits: loss of pay, one-off adjustments, recalculation after a master change', async () => {
  const slips = (await api('GET', `/payroll/runs/${run.id}`)).body.slips;
  const dv = slips.find((s) => s.empCode === 'EMP-002');

  const lop = await ok(api('PUT', `/payroll/runs/${run.id}/payslips/${dv.id}`, { lopDays: 3 }));
  // 27 of 30 days: 10,800 + 3,600 + 2,700 = 17,100; PF on 10,800; ESI 0.75% / 3.25% of 17,100 rounded up
  assert.deepEqual([lop.paidDays, lop.gross, lop.pfWages, lop.pfEmployee, lop.pfEps, lop.pfEpf, lop.edli, lop.esiEmployee, lop.esiEmployer].map(Number),
    [27, 17100, 10800, 1296, 900, 396, 54, 129, 556]);
  assert.equal((await api('PUT', `/payroll/runs/${run.id}/payslips/${dv.id}`, { lopDays: 30 })).status, 200, 'a full month of LOP is allowed');
  assert.equal((await api('PUT', `/payroll/runs/${run.id}/payslips/${dv.id}`, { lopDays: 31 })).status, 400, 'more than the days in the month');

  // restore full attendance and record a ₹1,000 advance recovery
  const back = await ok(api('PUT', `/payroll/runs/${run.id}/payslips/${dv.id}`, { lopDays: 0, otherDeductions: 1000 }));
  assert.deepEqual([back.gross, back.otherDeductions, back.net].map(Number), [19000, 1000, 16417]);

  // changing the master does not touch the draft until recalculated
  await ok(api('PUT', `/payroll/employees/${dv.employeeId}`, { ptMonthly: 100 }));
  assert.equal(Number((await api('GET', `/payroll/runs/${run.id}`)).body.slips.find((s) => s.id === dv.id).professionalTax), 0);
  await ok(api('POST', `/payroll/runs/${run.id}/recalculate`, {}));
  const re = (await api('GET', `/payroll/runs/${run.id}`)).body;
  const dv2 = re.slips.find((s) => s.id === dv.id);
  assert.deepEqual([Number(dv2.professionalTax), Number(dv2.otherDeductions), Number(dv2.net)], [100, 1000, 16317], 'adjustments survive a recalculation');
  await ok(api('PUT', `/payroll/employees/${dv.employeeId}`, { ptMonthly: 0 }));
  await ok(api('POST', `/payroll/runs/${run.id}/recalculate`, {}));

  const t = (await api('GET', `/payroll/runs/${run.id}`)).body;
  assert.deepEqual([t.gross, t.net, t.pfEmployee, t.pfEmployer, t.edli, t.pfAdmin, t.esiEmployee, t.esiEmployer, t.tds, t.professionalTax, t.otherDeductions].map(Number),
    [169000, 151850, 3240, 3240, 135, 500, 143, 618, 12567, 200, 1000]);
  assert.equal((await api('GET', `/payroll/runs/${run.id}`, null, await register('x1@example.com'))).status, 404);
});

test('finalize posts a balanced journal; the run is then locked', async () => {
  const f = await ok(api('POST', `/payroll/runs/${run.id}/finalize`, {}));
  assert.equal(f.status, 'finalized');
  assert.ok(f.journalEntryId);

  // Dr Salaries 1,69,000 + Employer contributions 4,493 = Cr Salary payable 1,51,850 + PF 7,115 + ESI 761 + TDS 12,567 + PT 200 + advances 1,000
  assert.equal(await bal('5300'), 169000);
  assert.equal(await bal('5310'), 4493);
  assert.equal(await bal('2200'), 151850);
  assert.equal(await bal('2210'), 7115);
  assert.equal(await bal('2220'), 761);
  assert.equal(await bal('2230'), 12567);
  assert.equal(await bal('2240'), 200);
  assert.equal(await bal('1300'), -1000, 'advance recovery credits the advances account');
  const tb = (await api('GET', '/trial-balance')).body;
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, 173493);

  const slip = (await api('GET', `/payroll/runs/${run.id}`)).body.slips[0];
  assert.equal((await api('PUT', `/payroll/runs/${run.id}/payslips/${slip.id}`, { lopDays: 1 })).status, 409);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/finalize`, {})).status, 409);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/recalculate`, {})).status, 409);
  assert.equal((await api('DELETE', `/payroll/runs/${run.id}`)).status, 409);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/pay`, { mode: 'bank', date: '2026-03-01' })).status, 400, 'before the payroll month');
});

test('reopen reverses the journal; finalize again; then pay and remit', async () => {
  const re = await ok(api('POST', `/payroll/runs/${run.id}/reopen`, {}));
  assert.deepEqual([re.status, re.journalEntryId], ['draft', null]);
  for (const code of ['5300', '5310', '2200', '2210', '2220', '2230', '2240', '1300']) assert.equal(await bal(code), 0, `${code} reversed`);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/reopen`, {})).status, 409, 'only a finalized run can be reopened');

  await ok(api('POST', `/payroll/runs/${run.id}/finalize`, {}));
  assert.equal((await api('POST', `/payroll/runs/${run.id}/remit`, { head: 'pf' })).status, 200);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/reopen`, {})).status, 409, 'PF already remitted');

  assert.equal((await api('POST', `/payroll/runs/${run.id}/remit`, { head: 'pf' })).status, 409, 'cannot remit twice');
  assert.equal(await bal('2210'), 0);
  for (const head of ['esi', 'tds', 'pt']) assert.equal((await api('POST', `/payroll/runs/${run.id}/remit`, { head, mode: 'cash' })).status, 200);
  assert.deepEqual([await bal('2220'), await bal('2230'), await bal('2240')], [0, 0, 0]);
  assert.equal(await bal('1000'), -(761 + 12567 + 200), 'ESI, TDS and PT paid in cash');
  assert.equal(await bal('1010'), -7115, 'PF paid from the bank');

  const paid = await ok(api('POST', `/payroll/runs/${run.id}/pay`, { mode: 'bank' }));
  assert.deepEqual([paid.status, paid.payMode], ['paid', 'bank']);
  assert.equal(await bal('2200'), 0);
  assert.equal(await bal('1010'), -(7115 + 151850));
  assert.equal((await api('POST', `/payroll/runs/${run.id}/pay`, { mode: 'bank' })).status, 409);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/reopen`, {})).status, 409);
  assert.equal((await api('GET', '/trial-balance')).body.balanced, true);
});

test('second month: TDS uses year-to-date, part-month joiner is prorated, draft can be deleted', async () => {
  const E = await ok(api('POST', '/payroll/employees', { name: 'Esha', doj: '2026-05-16', basic: 30000, hra: 12000, special: 8000 }));
  const may = await ok(api('POST', '/payroll/runs', { month: '2026-05' }));
  const d = (await api('GET', `/payroll/runs/${may.id}`)).body;
  assert.equal(d.slips.length, 3);
  const c = d.slips.find((s) => s.empCode === 'EMP-001');
  assert.equal(Number(c.tds), 12567, '(1,50,800 - 12,567) / 11 months');
  const e = d.slips.find((s) => s.employeeId === E.id);
  // joined 16 May: 16 of 31 days
  assert.deepEqual([e.employedDays, e.paidDays, e.earnedBasic, e.earnedHra, e.earnedSpecial, e.gross].map(Number), [16, 16, 15484, 6194, 4129, 25807]);
  assert.equal(d.slips.length, 3);

  // April did not include Esha
  assert.equal((await api('GET', `/payroll/runs/${run.id}`)).body.slips.length, 2);

  assert.equal((await api('DELETE', `/payroll/runs/${may.id}`)).status, 200);
  assert.equal((await api('GET', `/payroll/runs/${may.id}`)).status, 404);
  assert.equal((await api('GET', '/payroll/runs')).body.length, 1);
});

test('companies created before payroll get the payroll accounts on first posting', async () => {
  const t = await register('legacy@example.com');
  const cid = (await api('GET', '/auth/me', null, t)).body.companyId;
  await pool.query("DELETE FROM accounts WHERE company_id=$1 AND code >= '1300' AND code IN ('1300','2200','2210','2220','2230','2240','5300','5310')", [cid]);
  assert.equal((await api('GET', '/accounts', null, t)).body.length, 22, '30 accounts less the 8 payroll ones');

  await ok(api('POST', '/payroll/employees', { name: 'Legacy', doj: '2020-01-01', basic: 30000, hra: 12000, special: 8000 }, t));
  const r = await ok(api('POST', '/payroll/runs', { month: '2026-04' }, t));
  assert.equal((await api('POST', `/payroll/runs/${r.id}/finalize`, {}, t)).status, 200);
  assert.equal((await api('GET', '/accounts', null, t)).body.length, 30);
  assert.equal((await api('GET', '/trial-balance', null, t)).body.balanced, true);
});

test('a leaver is paid only up to the exit date and projected tax stops at the exit month', async () => {
  const t = await register('leaver@example.com');
  await ok(api('POST', '/payroll/employees', { name: 'Leaver', doj: '2020-01-01', exitDate: '2026-06-10', basic: 75000, hra: 30000, special: 45000 }, t));
  const apr = await ok(api('POST', '/payroll/runs', { month: '2026-04' }, t));
  const jun = await ok(api('POST', '/payroll/runs', { month: '2026-06' }, t));
  const j = (await api('GET', `/payroll/runs/${jun.id}`, null, t)).body.slips[0];
  assert.deepEqual([Number(j.employedDays), Number(j.paidDays), Number(j.gross)], [10, 10, 50000], '10 of 30 days');
  // April's projection covers Apr..Jun only (3 months), well within the rebate: no TDS
  assert.equal(Number((await api('GET', `/payroll/runs/${apr.id}`, null, t)).body.slips[0].tds), 0);
  const jul = await api('POST', '/payroll/runs', { month: '2026-07' }, t);
  assert.equal(jul.status, 400, 'nobody on payroll after the exit month');
});
