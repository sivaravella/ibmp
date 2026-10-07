import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { datesInMonth, employmentRange, summarize, weekday } from '../src/attendance.js';

const emp = (o = {}) => ({ doj: '2020-01-01', exit_date: null, ...o });

test('helpers: weekday, month dates, employment range', () => {
  assert.equal(weekday('2026-04-05'), 0, 'Sunday');
  assert.equal(weekday('2026-04-01'), 3, 'Wednesday');
  assert.equal(datesInMonth('2026-02').length, 28);
  assert.equal(datesInMonth('2028-02').length, 29);
  assert.deepEqual(employmentRange(emp({ doj: '2026-04-16' }), '2026-04'), { from: '2026-04-16', to: '2026-04-30' });
  assert.deepEqual(employmentRange(emp({ exit_date: '2026-04-10' }), '2026-04'), { from: '2026-04-01', to: '2026-04-10' });
  assert.equal(employmentRange(emp({ doj: '2026-05-01' }), '2026-04'), null);
});

test('summarize: absent = 1 LOP, half day = 0.5, leave and holidays are paid, only employed days count', () => {
  const marks = new Map([['2026-04-01', 'P'], ['2026-04-02', 'A'], ['2026-04-03', 'A'], ['2026-04-04', 'HD'], ['2026-04-05', 'WO'], ['2026-04-06', 'L'], ['2026-04-07', 'H']]);
  const s = summarize(marks, emp(), '2026-04');
  assert.deepEqual([s.P, s.A, s.HD, s.L, s.H, s.WO, s.marked, s.unmarked, s.employed, s.lop], [1, 2, 1, 1, 1, 1, 7, 23, 30, 2.5]);
  // Marks outside the employment range are ignored.
  const j = summarize(new Map([['2026-04-02', 'A'], ['2026-04-20', 'A']]), emp({ doj: '2026-04-16' }), '2026-04');
  assert.deepEqual([j.A, j.employed, j.unmarked, j.lop], [1, 15, 14, 1]);
  assert.equal(summarize(marks, emp({ doj: '2026-05-01' }), '2026-04').employed, 0);
});

// ---- API ----
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
const register = async (email) => (await api('POST', '/auth/register', {
  name: 'A', email, password: 'password123', company: `Co ${email}`, sector: 'trading', stateCode: '29',
}, null)).body.token;

let E1, E2, E3;
const M = '2026-04';
const grid = async (tok = token) => (await api('GET', `/attendance?month=${M}`, null, tok)).body;
const row = async (id) => (await grid()).employees.find((e) => e.id === id);
const mark = (employeeId, date, status) => api('PUT', '/attendance/mark', { employeeId, date, status });

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  token = await register('attendance@example.com');
  const pay = { basic: 30000, hra: 12000, special: 8000 };
  E1 = await ok(api('POST', '/payroll/employees', { name: 'Full', doj: '2020-01-01', ...pay }));
  E2 = await ok(api('POST', '/payroll/employees', { name: 'Joiner', doj: '2026-04-16', ...pay }));
  E3 = await ok(api('POST', '/payroll/employees', { name: 'Leaver', doj: '2020-01-01', exitDate: '2026-04-10', ...pay }));
});

test('settings and holidays', async () => {
  assert.deepEqual((await api('GET', '/attendance/settings')).body, { weekOffs: [0] }, 'Sunday by default');
  assert.deepEqual((await ok(api('PUT', '/attendance/settings', { weekOffs: [0, 0] }))).weekOffs, [0], 'duplicates collapse');
  assert.equal((await api('PUT', '/attendance/settings', { weekOffs: [7] })).status, 400);

  const h = await ok(api('POST', '/attendance/holidays', { date: '2026-04-14', name: 'Ambedkar Jayanti' }));
  assert.equal(h.date, '2026-04-14');
  assert.equal((await api('POST', '/attendance/holidays', { date: '2026-04-14', name: 'Again' })).status, 409);
  assert.equal((await api('GET', '/attendance/holidays?year=2026')).body.length, 1);
  assert.equal((await api('GET', '/attendance/holidays?year=2027')).body.length, 0);

  const other = await register('att-other@example.com');
  assert.equal((await api('DELETE', `/attendance/holidays/${h.id}`, null, other)).status, 404);
  assert.deepEqual((await api('GET', '/attendance/settings', null, other)).body, { weekOffs: [0] });
});

test('grid lists only employees on the books, with their day range', async () => {
  const g = await grid();
  assert.equal(g.days.length, 30);
  assert.deepEqual(g.employees.map((e) => e.name), ['Full', 'Joiner', 'Leaver']);
  assert.deepEqual(g.employees.map((e) => e.range), [{ from: '2026-04-01', to: '2026-04-30' }, { from: '2026-04-16', to: '2026-04-30' }, { from: '2026-04-01', to: '2026-04-10' }]);
  assert.deepEqual(g.days.filter((d) => d.weekOff).map((d) => d.date), ['2026-04-05', '2026-04-12', '2026-04-19', '2026-04-26']);
  assert.equal(g.days.find((d) => d.date === '2026-04-14').holiday, 'Ambedkar Jayanti');
  assert.equal(g.locked, false);
  assert.equal((await api('GET', '/attendance?month=2026-4')).status, 400);
  assert.equal((await api('GET', '/attendance')).status, 400);
  assert.equal((await api('GET', `/attendance?month=${M}`, null, null)).status, 401);
});

test('autofill: week offs and holidays first, then optionally everything else as present', async () => {
  // Full: 4 Sundays + 1 holiday; Joiner (16-30): Sundays 19 and 26; Leaver (1-10): Sunday 5
  const a = await ok(api('POST', '/attendance/autofill', { month: M }));
  assert.deepEqual([a.WO, a.H, a.P, a.filled], [7, 1, 0, 8]);
  const f = await row(E1.id);
  assert.deepEqual([f.summary.WO, f.summary.H, f.summary.unmarked], [4, 1, 25]);
  assert.equal(f.marks['2026-04-05'], 'WO');
  assert.equal(f.marks['2026-04-14'], 'H');

  const b = await ok(api('POST', '/attendance/autofill', { month: M, presentByDefault: true }));
  assert.deepEqual([b.WO, b.H, b.P], [0, 0, 47], '25 + 13 + 9 unmarked working days');
  assert.deepEqual((await grid()).employees.map((e) => e.summary.unmarked), [0, 0, 0]);
  assert.equal((await ok(api('POST', '/attendance/autofill', { month: M, presentByDefault: true }))).filled, 0, 'idempotent');
});

test('marking: validation, employment range, overwrite and clear', async () => {
  assert.equal((await mark(E1.id, '2026-04-07', 'X')).status, 400);
  assert.equal((await mark(E2.id, '2026-04-10', 'A')).status, 400, 'before joining');
  assert.equal((await mark(E3.id, '2026-04-20', 'A')).status, 400, 'after leaving');
  assert.equal((await mark(999999, '2026-04-07', 'A')).status, 404);

  for (const [d, s] of [['2026-04-07', 'A'], ['2026-04-08', 'A'], ['2026-04-09', 'HD']]) assert.equal((await mark(E1.id, d, s)).status, 200);
  const f = await row(E1.id);
  assert.deepEqual([f.summary.A, f.summary.HD, f.summary.lop], [2, 1, 2.5]);
  assert.equal((await mark(E1.id, '2026-04-05', 'P')).status, 200, 'a week-off can be overridden');

  const cleared = await ok(mark(E3.id, '2026-04-03', null));
  assert.deepEqual([cleared.summary.unmarked, cleared.summary.marked], [1, 9]);

  const other = await register('att-other2@example.com');
  assert.equal((await api('PUT', '/attendance/mark', { employeeId: E1.id, date: '2026-04-07', status: 'A' }, other)).status, 404);
  assert.equal((await grid(other)).employees.length, 0);
});

test('bulk: only unmarked cells by default; explicit overwrite; dates must be in the month', async () => {
  const same = await ok(api('PUT', '/attendance/bulk', { month: M, status: 'A', employeeIds: [E1.id] }));
  assert.equal(same.changed, 0, 'every cell is already marked');

  const over = await ok(api('PUT', '/attendance/bulk', { month: M, status: 'A', employeeIds: [E1.id], dates: ['2026-04-20', '2026-04-21'], onlyUnmarked: false }));
  assert.equal(over.changed, 2);
  assert.equal((await row(E1.id)).summary.lop, 4.5);
  await ok(api('PUT', '/attendance/bulk', { month: M, status: 'P', employeeIds: [E1.id], dates: ['2026-04-20', '2026-04-21'], onlyUnmarked: false }));
  assert.equal((await row(E1.id)).summary.lop, 2.5);

  // dates outside someone's employment are skipped, not errors
  const joiner = await ok(api('PUT', '/attendance/bulk', { month: M, status: 'L', employeeIds: [E2.id], dates: ['2026-04-02', '2026-04-17'], onlyUnmarked: false }));
  assert.equal(joiner.changed, 1);
  assert.equal((await api('PUT', '/attendance/bulk', { month: M, status: 'P', dates: ['2026-05-01'] })).status, 400);
  await ok(mark(E2.id, '2026-04-17', 'P'));
});

test('payroll uses the register: LOP, part-month employment, unmarked-day warning, sync, and the lock', async () => {
  const run = await ok(api('POST', '/payroll/runs', { month: M }));
  let d = (await api('GET', `/payroll/runs/${run.id}`)).body;
  const s1 = d.slips.find((s) => s.employeeId === E1.id), s2 = d.slips.find((s) => s.employeeId === E2.id), s3 = d.slips.find((s) => s.employeeId === E3.id);

  // Full: 2 absent + a half day = 2.5 LOP -> 27.5 of 30 days: 27,500 + 11,000 + 7,333
  assert.deepEqual([s1.lopDays, s1.paidDays, s1.gross].map(Number), [2.5, 27.5, 45833]);
  assert.deepEqual(s1.warnings, []);
  assert.equal(s1.register.lop, 2.5);
  // Joiner: 15 days employed, no loss of pay
  assert.deepEqual([s2.employedDays, s2.lopDays, s2.paidDays, s2.gross].map(Number), [15, 0, 15, 25000]);
  // Leaver: 10 days, one of them unmarked while the rest are marked
  assert.deepEqual([s3.employedDays, s3.paidDays].map(Number), [10, 10]);
  assert.match(s3.warnings.join(' '), /1 day\(s\) are not marked/);

  // Change the register while the run is still a draft: the slip is stale until synced.
  await ok(mark(E1.id, '2026-04-10', 'A'));
  d = (await api('GET', `/payroll/runs/${run.id}`)).body;
  const stale = d.slips.find((s) => s.employeeId === E1.id);
  assert.deepEqual([Number(stale.lopDays), stale.register.lop], [2.5, 3.5]);
  const sync = await ok(api('POST', `/payroll/runs/${run.id}/sync-attendance`, {}));
  assert.equal(sync.changed, 1);
  d = (await api('GET', `/payroll/runs/${run.id}`)).body;
  const fresh = d.slips.find((s) => s.employeeId === E1.id);
  // 26.5 of 30 days: 26,500 + 10,600 + 7,067
  assert.deepEqual([Number(fresh.lopDays), Number(fresh.paidDays), Number(fresh.gross)], [3.5, 26.5, 44167]);
  assert.equal(Number(d.gross), 44167 + 25000 + Number(d.slips.find((s) => s.employeeId === E3.id).gross));
  assert.equal((await ok(api('POST', `/payroll/runs/${run.id}/sync-attendance`, {}))).changed, 0, 'nothing left to change');

  // Manual override after sync is still possible in draft
  await ok(api('PUT', `/payroll/runs/${run.id}/payslips/${fresh.id}`, { lopDays: 1 }));
  assert.equal((await ok(api('POST', `/payroll/runs/${run.id}/sync-attendance`, {}))).changed, 1, 'sync restores the register value');

  // Finalizing freezes the month's attendance
  await ok(api('POST', `/payroll/runs/${run.id}/finalize`, {}));
  assert.equal((await grid()).locked, true);
  assert.equal((await mark(E1.id, '2026-04-11', 'A')).status, 409);
  assert.equal((await api('PUT', '/attendance/bulk', { month: M, status: 'P' })).status, 409);
  assert.equal((await api('POST', '/attendance/autofill', { month: M })).status, 409);
  assert.equal((await api('POST', `/payroll/runs/${run.id}/sync-attendance`, {})).status, 409);
  // other months are unaffected
  assert.equal((await api('GET', '/attendance?month=2026-05')).body.locked, false);

  await ok(api('POST', `/payroll/runs/${run.id}/reopen`, {}));
  assert.equal((await grid()).locked, false);
  assert.equal((await mark(E1.id, '2026-04-11', 'P')).status, 200);
});

test('a company that never uses the register gets no loss of pay and no warnings', async () => {
  const t = await register('att-unused@example.com');
  await ok(api('POST', '/payroll/employees', { name: 'Solo', doj: '2020-01-01', basic: 30000, hra: 12000, special: 8000 }, t));
  const run = await ok(api('POST', '/payroll/runs', { month: M }, t));
  const s = (await api('GET', `/payroll/runs/${run.id}`, null, t)).body.slips[0];
  assert.deepEqual([Number(s.lopDays), Number(s.gross), s.warnings], [0, 50000, []]);
  assert.equal(s.register.marked, 0);
});
