import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { accruedFor, attendanceMark, balanceFor, datesBetween, monthCounts, nextYear, roundHalf, yearMonths } from '../src/leave.js';

const CL = { quota: 12, accrual: 'monthly', carry_forward_max: 0 };
const SL = { quota: 6, accrual: 'annual', carry_forward_max: 0 };
const EL = { quota: 15, accrual: 'monthly', carry_forward_max: 30 };
const LWP = { quota: null, accrual: 'monthly', carry_forward_max: 0 };
const emp = (o = {}) => ({ doj: '2020-01-01', exit_date: null, ...o });
const bal = (type, e, year, asOf, taken, adj) => balanceFor({ type, emp: e, year, asOf, taken: new Map(Object.entries(taken ?? {})), adj: new Map(Object.entries(adj ?? {})) });

test('helpers: leave year months, rounding, 15th-of-month rule, day ranges, attendance marks', () => {
  assert.deepEqual([yearMonths('2026-27')[0], yearMonths('2026-27')[11]], ['2026-04', '2027-03']);
  assert.equal(nextYear('2026-27'), '2027-28');
  assert.equal(nextYear('2099-00'), '2100-01');
  assert.deepEqual([roundHalf(8.75), roundHalf(1.25), roundHalf(0.58), roundHalf(4)], [9, 1.5, 0.5, 4]);
  assert.deepEqual(['2026-07-15', '2026-07-16'].map((d) => monthCounts(emp({ doj: d }), '2026-07')), [true, false], 'joined on/before the 15th counts');
  assert.deepEqual(['2026-08-14', '2026-08-15'].map((d) => monthCounts(emp({ exit_date: d }), '2026-08')), [false, true]);
  assert.deepEqual(datesBetween('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual([[true, 1], [true, 0.5], [false, 1], [false, 0.5]].map(([p, f]) => attendanceMark(p, f)), ['L', 'HL', 'A', 'HD']);
});

test('accrual: monthly credits to date, annual credits up front; joiners and leavers are pro-rated', () => {
  // April..October = 7 counted months
  assert.equal(accruedFor(CL, emp(), '2026-27', '2026-10-06'), 7);
  assert.equal(accruedFor(EL, emp(), '2026-27', '2026-10-06'), 9, '15 x 7/12 = 8.75 rounds to 9');
  assert.equal(accruedFor(CL, emp(), '2026-27', '2026-03-31'), 0, 'as of before the year started');
  assert.equal(accruedFor(SL, emp(), '2026-27', '2026-04-01'), 6, 'annual: whole quota on day one');
  assert.equal(accruedFor(CL, emp(), '2026-27', '2027-03-31'), 12);
  assert.equal(accruedFor(LWP, emp(), '2026-27', '2027-03-31'), 0);

  assert.equal(accruedFor(CL, emp({ doj: '2026-07-20' }), '2026-27', '2026-10-06'), 3, 'joined after the 15th: Aug, Sep, Oct');
  assert.equal(accruedFor(CL, emp({ doj: '2026-07-15' }), '2026-27', '2026-10-06'), 4, 'joined on the 15th: July counts');
  assert.equal(accruedFor(SL, emp({ doj: '2026-07-20' }), '2026-27', '2026-10-06'), 4, '6 x 8/12');
  assert.equal(accruedFor(CL, emp({ exit_date: '2026-08-10' }), '2026-27', '2026-12-01'), 4, 'left before 15 Aug: Apr..Jul');
  assert.equal(accruedFor(CL, emp({ exit_date: '2026-08-15' }), '2026-27', '2026-12-01'), 5);
});

test('balance: taken, adjustments, carry-forward cap, lapse and no negative carry', () => {
  const b = bal(CL, emp(), '2026-27', '2026-10-06', { '2026-27': 2 }, { '2026-27': 1 });
  assert.deepEqual([b.carried, b.accrued, b.adjustments, b.taken, b.balance], [0, 7, 1, 2, 6]);

  // CL does not carry: 12 earned, 2 taken in 2025-26 -> nothing carried; April 2026 earns 1
  const lapse = bal(CL, emp({ doj: '2025-04-01' }), '2026-27', '2026-04-20', { '2025-26': 2 });
  assert.deepEqual([lapse.carried, lapse.balance], [0, 1]);

  // EL carries up to 30: 15 (2024-25) -> 15 + 15 = 30 (2025-26) -> capped at 30, so 2026-27 starts with 30, not 45
  const el = bal(EL, emp({ doj: '2024-04-01' }), '2026-27', '2026-04-10');
  assert.deepEqual([el.carried, el.accrued, el.balance], [30, 1.5, 31.5]);
  assert.equal(bal({ ...EL, carry_forward_max: 20 }, emp({ doj: '2024-04-01' }), '2026-27', '2026-04-10').carried, 20, 'excess lapses');
  // 15 earned, 3 taken -> carry 12
  assert.equal(bal(EL, emp({ doj: '2025-04-01' }), '2026-27', '2026-04-20', { '2025-26': 3 }).carried, 12);

  // Overdrawn year (e.g. taken more than accrued via adjustment) never carries a negative
  const neg = bal(EL, emp({ doj: '2025-04-01' }), '2026-27', '2026-04-20', { '2025-26': 20 });
  assert.equal(neg.carried, 0);

  const u = bal(LWP, emp(), '2026-27', '2026-10-06', { '2026-27': 3 });
  assert.deepEqual([u.unlimited, u.balance, u.taken], [true, null, 3]);
  const before = bal(CL, emp({ doj: '2027-01-01' }), '2026-27', '2026-10-06', {}, { '2026-27': 2 });
  assert.equal(before.balance, 2, 'before joining only adjustments count');
});

// ---- API ----
let base, token, E1, E2;
const api = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (email) => (await api('POST', '/auth/register', {
  name: 'L', email, password: 'password123', company: `Co ${email}`, sector: 'trading', stateCode: '29',
}, null)).body.token;
let T = {};                                         // leave types by code
const apply = (employeeId, code, fromDate, toDate, extra = {}) => api('POST', '/leave/applications', { employeeId, leaveTypeId: T[code].id, fromDate, toDate, ...extra });
const decide = (id, what, body = {}) => api('POST', `/leave/applications/${id}/${what}`, body);
const balances = async (asOf, tok = token) => (await api('GET', `/leave/balances?asOf=${asOf}`, null, tok)).body;
const bal1 = async (eid, code, asOf) => (await balances(asOf)).employees.find((e) => e.id === eid).balances[code];
const marks = async (eid, month = '2026-04') => (await api('GET', `/attendance?month=${month}`)).body.employees.find((e) => e.id === eid);

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  token = await register('leave@example.com');
  const pay = { basic: 30000, hra: 12000, special: 8000 };
  E1 = await ok(api('POST', '/payroll/employees', { name: 'Asha', doj: '2020-01-01', ...pay }));
  E2 = await ok(api('POST', '/payroll/employees', { name: 'Binu', doj: '2026-04-16', ...pay }));
  for (const t of (await ok(api('GET', '/leave/types')))) T[t.code] = t;
});

test('leave types: defaults, create, edit, validation, isolation', async () => {
  assert.deepEqual(Object.keys(T), ['CL', 'SL', 'EL', 'LWP']);
  assert.deepEqual([T.CL.paid, T.CL.quota, T.EL.carryForwardMax, T.LWP.paid, T.LWP.quota], [true, 12, 30, false, null]);

  const pl = await ok(api('POST', '/leave/types', { code: 'PL', name: 'Privilege Leave', paid: true, quota: 5, accrual: 'annual', carryForwardMax: 5 }));
  assert.equal(pl.quota, 5);
  assert.equal((await api('POST', '/leave/types', { code: 'PL', name: 'Dup', paid: true, quota: 1 })).status, 409);
  assert.equal((await api('POST', '/leave/types', { code: 'pl2', name: 'Bad code', paid: true })).status, 400);
  assert.equal((await api('POST', '/leave/types', { code: 'XL', name: 'Unpaid with quota', paid: false, quota: 3 })).status, 400);
  assert.equal((await api('POST', '/leave/types', { code: 'HF', name: 'Odd quota', paid: true, quota: 2.3 })).status, 400);

  const up = await ok(api('PUT', `/leave/types/${pl.id}`, { quota: 8, active: false }));
  assert.deepEqual([up.quota, up.active, up.name], [8, false, 'Privilege Leave']);
  assert.equal((await apply(E1.id, 'CL', '2026-04-07', '2026-04-07').then((r) => r.status)), 201);
  await ok(decide((await api('GET', '/leave/applications?status=pending')).body[0].id, 'cancel'));
  assert.equal((await api('POST', '/leave/applications', { employeeId: E1.id, leaveTypeId: pl.id, fromDate: '2026-04-07', toDate: '2026-04-07' })).status, 400, 'inactive type');

  const other = await register('leave-other@example.com');
  assert.equal((await api('GET', '/leave/types', null, other)).body.length, 4, 'each company gets its own defaults');
  assert.equal((await api('PUT', `/leave/types/${pl.id}`, { quota: 1 }, other)).status, 404);
  T.PL = pl;
});

test('adjustments: opening balance, validation', async () => {
  const a = await ok(api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.CL.id, days: 10, date: '2026-04-01', reason: 'Opening balance' }));
  assert.equal(a.days, 10);
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.CL.id, days: 0, reason: 'x' })).status, 400);
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.CL.id, days: 0.3, reason: 'x' })).status, 400);
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.CL.id, days: 1, reason: '' })).status, 400);
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.LWP.id, days: 1, reason: 'x' })).status, 400, 'unlimited type has no balance');
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: E1.id, leaveTypeId: T.CL.id, days: -50, date: '2026-04-01', reason: 'too much' })).status, 400);
  assert.equal((await api('POST', '/leave/adjustments', { employeeId: 999999, leaveTypeId: T.CL.id, days: 1, reason: 'x' })).status, 404);

  // April accrues 1 day (12/12) plus the 10 opening days
  const b = await bal1(E1.id, 'CL', '2026-04-30');
  assert.deepEqual([b.carried, b.accrued, b.adjustments, b.taken, b.balance, b.available], [0, 1, 10, 0, 11, 11]);
  assert.equal((await bal1(E1.id, 'SL', '2026-04-30')).balance, 6, 'annual: full quota');
  const lwp = await bal1(E1.id, 'LWP', '2026-04-30');
  assert.deepEqual([lwp.unlimited, lwp.balance], [true, null]);
  assert.equal((await api('GET', '/leave/adjustments')).body.length, 1);
});

test('applying: working-day counting, validation and overlap', async () => {
  await ok(api('POST', '/attendance/holidays', { date: '2026-04-14', name: 'Ambedkar Jayanti' }));
  await ok(api('POST', '/attendance/autofill', { month: '2026-04', presentByDefault: true }));

  // Fri 3 Apr to Tue 7 Apr: Sunday 5th is a week off, so 4 working days
  const a = await ok(apply(E1.id, 'CL', '2026-04-03', '2026-04-07', { reason: 'Family function' }));
  assert.deepEqual([a.status, a.days], ['pending', 4]);

  assert.equal((await apply(E1.id, 'CL', '2026-04-07', '2026-04-07')).status, 409, 'overlaps a pending application');
  assert.equal((await apply(E1.id, 'CL', '2026-04-05', '2026-04-05')).status, 400, 'a Sunday');
  assert.equal((await apply(E1.id, 'CL', '2026-04-14', '2026-04-14')).status, 400, 'a holiday');
  assert.equal((await apply(E1.id, 'CL', '2026-04-08', '2026-04-07')).status, 400, 'end before start');
  assert.equal((await apply(E1.id, 'CL', '2026-04-08', '2026-04-09', { halfDay: 'first' })).status, 400, 'half day over a range');
  assert.equal((await apply(E1.id, 'CL', '2027-03-30', '2027-04-02')).status, 400, 'spans two leave years');
  assert.equal((await apply(E2.id, 'CL', '2026-04-10', '2026-04-10')).status, 400, 'before joining');
  assert.equal((await apply(999999, 'CL', '2026-04-10', '2026-04-10')).status, 404);
  assert.equal((await apply(E1.id, 'CL', '2026-04-22', '2026-06-05')).status, 400, 'more than the balance');
  const big = await apply(E1.id, 'CL', '2026-04-22', '2026-06-05');
  assert.match(big.body.error, /available/);

  // pending requests count against what can be applied for, but not against approval of earlier ones
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).pending, 4);
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).available, 7);

  // Not approved yet: the register is untouched
  assert.equal((await marks(E1.id)).marks['2026-04-03'], 'P');
});

test('approving writes the register: paid leave L/HL, unpaid A/HD; balances fall; unpaid leave becomes loss of pay', async () => {
  const pend = (await api('GET', '/leave/applications?status=pending')).body;
  const a = pend.find((x) => x.fromDate === '2026-04-03');
  const ap = await ok(decide(a.id, 'approve', { note: 'Enjoy' }));
  assert.deepEqual([ap.status, ap.decisionNote, ap.decidedOn === null], ['approved', 'Enjoy', false]);
  assert.equal((await decide(a.id, 'approve')).status, 409, 'already decided');
  assert.equal((await decide(a.id, 'reject')).status, 409);

  let m = (await marks(E1.id)).marks;
  assert.deepEqual(['2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07'].map((d) => m[d]), ['L', 'L', 'WO', 'L', 'L']);
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).balance, 7);

  // half day (paid), then unpaid leave Thu 9 - Fri 10
  const half = await ok(apply(E1.id, 'CL', '2026-04-08', '2026-04-08', { halfDay: 'second' }));
  assert.equal(half.days, 0.5);
  await ok(decide(half.id, 'approve'));
  const unpaid = await ok(apply(E1.id, 'LWP', '2026-04-09', '2026-04-10'));
  assert.equal(unpaid.days, 2);
  await ok(decide(unpaid.id, 'approve'));

  m = (await marks(E1.id)).marks;
  assert.deepEqual(['2026-04-08', '2026-04-09', '2026-04-10'].map((d) => m[d]), ['HL', 'A', 'A']);
  const s = (await marks(E1.id)).summary;
  assert.deepEqual([s.L, s.HL, s.A, s.lop], [4, 1, 2, 2], 'paid leave costs nothing; two unpaid days are loss of pay');
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).balance, 6.5);
  assert.equal((await bal1(E1.id, 'LWP', '2026-04-30')).taken, 2);

  const sum = (await api('GET', '/leave/summary?asOf=2026-04-06')).body;
  assert.deepEqual(sum.onLeave, [{ name: 'Asha', type: 'CL', halfDay: false }]);
});

test('pending requests reserve balance; rejecting releases it; approval needs real balance', async () => {
  const first = await ok(apply(E1.id, 'CL', '2026-04-20', '2026-04-24'));            // 5 of 6.5
  assert.equal((await apply(E1.id, 'CL', '2026-04-27', '2026-04-28')).status, 400, 'only 1.5 left after the pending 5');
  const rej = await ok(decide(first.id, 'reject', { note: 'Month-end audit' }));
  assert.deepEqual([rej.status, rej.decisionNote], ['rejected', 'Month-end audit']);
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).balance, 6.5, 'a rejection takes nothing');
  await ok(apply(E1.id, 'CL', '2026-04-27', '2026-04-28'));                            // stays pending

  // Binu joined 16 Apr: April does not count, May earns 1. Opening 2 -> 3 days; apply 3, then claw back 2.
  await ok(api('POST', '/leave/adjustments', { employeeId: E2.id, leaveTypeId: T.CL.id, days: 2, date: '2026-05-01', reason: 'Opening' }));
  assert.equal((await bal1(E2.id, 'CL', '2026-05-04')).balance, 3);
  const bin = await ok(apply(E2.id, 'CL', '2026-05-05', '2026-05-07'));
  await ok(api('POST', '/leave/adjustments', { employeeId: E2.id, leaveTypeId: T.CL.id, days: -2, date: '2026-05-04', reason: 'Correction' }));
  const fail = await decide(bin.id, 'approve');
  assert.equal(fail.status, 400);
  assert.match(fail.body.error, /Insufficient CL balance/);
  const asLwp = await ok(decide(bin.id, 'approve', { leaveTypeId: T.LWP.id, note: 'Converted to unpaid' }));
  assert.equal(asLwp.leaveTypeId, T.LWP.id);
  assert.deepEqual((await marks(E2.id, '2026-05')).marks['2026-05-05'], 'A');
  assert.equal((await bal1(E2.id, 'CL', '2026-05-31')).balance, 1, 'the CL balance was not touched by the conversion');
});

test('payroll sees the leave; a finalized month freezes leave changes; cancelling restores the register', async () => {
  const run = await ok(api('POST', '/payroll/runs', { month: '2026-04' }));
  const d = (await api('GET', `/payroll/runs/${run.id}`)).body;
  const slip = d.slips.find((s) => s.employeeId === E1.id);
  assert.deepEqual([Number(slip.lopDays), Number(slip.paidDays)], [2, 28], 'only the unpaid days reduce pay');

  await ok(api('POST', `/payroll/runs/${run.id}/finalize`, {}));
  const pending = (await api('GET', '/leave/applications?status=pending&employeeId=' + E1.id)).body[0];
  const locked = await decide(pending.id, 'approve');
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Payroll for 2026-04 is finalized/);
  const approved = (await api('GET', '/leave/applications?status=approved&employeeId=' + E1.id)).body.find((x) => x.fromDate === '2026-04-03');
  assert.equal((await decide(approved.id, 'cancel')).status, 409, 'cancelling approved leave would change a finalized month');
  assert.equal((await decide(pending.id, 'cancel')).status, 200, 'withdrawing a pending request changes nothing');
  assert.equal((await decide(pending.id, 'cancel')).status, 409);

  await ok(api('POST', `/payroll/runs/${run.id}/reopen`, {}));
  const c = await ok(decide(approved.id, 'cancel'));
  assert.equal(c.status, 'cancelled');
  const m = (await marks(E1.id)).marks;
  assert.deepEqual(['2026-04-03', '2026-04-04', '2026-04-06', '2026-04-07'].map((x) => m[x]), ['P', 'P', 'P', 'P'], 'back to what the register showed before');
  assert.equal(m['2026-04-05'], 'WO');
  assert.equal((await bal1(E1.id, 'CL', '2026-04-30')).balance, 10.5, 'the 4 days are returned: 11 - 0.5');
  // the half-day and unpaid marks are untouched
  assert.deepEqual([m['2026-04-08'], m['2026-04-09']], ['HL', 'A']);
});

test('applications list filters; summary pending count; isolation', async () => {
  assert.equal((await api('GET', '/leave/applications?status=approved')).body.length, 3);
  assert.equal((await api('GET', `/leave/applications?employeeId=${E2.id}`)).body.length, 1);
  assert.equal((await api('GET', '/leave/applications?month=2026-05')).body.length, 1);
  assert.equal((await api('GET', '/leave/applications?month=2026-07')).body.length, 0);
  const row = (await api('GET', '/leave/applications?status=approved&employeeId=' + E1.id)).body[0];
  assert.deepEqual([row.employeeName, typeof row.typeCode, typeof row.paid], ['Asha', 'string', 'boolean']);
  assert.equal((await api('GET', '/leave/summary?asOf=2026-04-06')).body.pending, 0, 'the other pending request was withdrawn');

  const other = await register('leave-other2@example.com');
  assert.equal((await api('GET', '/leave/applications', null, other)).body.length, 0);
  assert.equal((await api('POST', `/leave/applications/${row.id}/cancel`, {}, other)).status, 404);
  assert.equal((await api('POST', '/leave/applications', { employeeId: E1.id, leaveTypeId: T.CL.id, fromDate: '2026-06-01', toDate: '2026-06-01' }, other)).status, 404);
  assert.equal((await balances('2026-04-30', other)).employees.length, 0);
  assert.equal((await api('GET', '/leave/balances?asOf=soon')).status, 400);
  assert.equal((await api('GET', '/leave/balances', null, null)).status, 401);
});
