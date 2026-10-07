import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { STATUSES, datesInMonth, employmentRange, summarize, weekday } from '../attendance.js';
import { employedDays, monthInfo } from '../payroll.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const status = z.enum(STATUSES);

const fixEmp = (e) => ({ ...e, doj: ymd(e.doj), exit_date: e.exit_date ? ymd(e.exit_date) : null });

export function attendanceRoutes(pool) {
  const r = Router();

  const month = (req) => {
    const p = monthStr.safeParse(req.query.month);
    if (!p.success) throw httpError(400, 'month must be YYYY-MM');
    return p.data;
  };

  async function settings(q, cid) {
    const row = (await q.query('SELECT week_offs FROM attendance_settings WHERE company_id=$1', [cid])).rows[0];
    return { weekOffs: (row ? row.week_offs : '0').split(',').filter((x) => x !== '').map(Number) };
  }
  async function holidays(q, cid, m) {
    const { start, end } = monthInfo(m);
    return (await q.query('SELECT * FROM attendance_holidays WHERE company_id=$1 AND date >= $2 AND date <= $3 ORDER BY date', [cid, start, end]))
      .rows.map((x) => ({ ...x, date: ymd(x.date) }));
  }
  const employedIn = async (q, cid, m) =>
    (await q.query('SELECT * FROM employees WHERE company_id=$1 ORDER BY code', [cid])).rows.map(fixEmp).filter((e) => employedDays(e, m) > 0);

  /** Marks for a month as Map(employeeId -> Map(date -> status)). */
  async function marksFor(q, cid, m) {
    const { start, end } = monthInfo(m);
    const rows = (await q.query('SELECT employee_id, date, status FROM attendance WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, start, end])).rows;
    const out = new Map();
    for (const x of rows) {
      if (!out.has(x.employee_id)) out.set(x.employee_id, new Map());
      out.get(x.employee_id).set(ymd(x.date), x.status);
    }
    return out;
  }

  // Once payroll for a month is finalized or paid, its attendance is frozen so the register can never disagree with a payslip.
  async function isLocked(q, cid, m) {
    return (await q.query("SELECT 1 FROM payroll_runs WHERE company_id=$1 AND month=$2 AND status IN ('finalized','paid')", [cid, m])).rowCount > 0;
  }
  const assertUnlocked = async (q, cid, m) => {
    if (await isLocked(q, cid, m)) throw httpError(409, `Payroll for ${m} is finalized: reopen it to change attendance`);
  };

  const setMark = async (q, cid, empId, date, s) => {
    await q.query('DELETE FROM attendance WHERE employee_id=$1 AND date=$2', [empId, date]);
    if (s) await q.query('INSERT INTO attendance (company_id, employee_id, date, status) VALUES ($1,$2,$3,$4)', [cid, empId, date, s]);
  };

  r.get('/attendance', h(async (req, res) => {
    const m = month(req), cid = req.user.companyId;
    const [emps, marks, hol, st, locked] = await Promise.all([employedIn(pool, cid, m), marksFor(pool, cid, m), holidays(pool, cid, m), settings(pool, cid), isLocked(pool, cid, m)]);
    const holName = new Map(hol.map((x) => [x.date, x.name]));
    res.json({
      month: m, locked, settings: st, holidays: hol,
      days: datesInMonth(m).map((date) => ({ date, dow: weekday(date), week_off: st.weekOffs.includes(weekday(date)), holiday: holName.get(date) ?? null })),
      employees: emps.map((e) => {
        const mm = marks.get(e.id) ?? new Map();
        return { id: e.id, code: e.code, name: e.name, designation: e.designation, range: employmentRange(e, m), marks: Object.fromEntries(mm), summary: summarize(mm, e, m) };
      }),
    });
  }));

  r.put('/attendance/mark', h(async (req, res) => {
    const b = z.object({ employeeId: z.number().int(), date: isoDate, status: status.nullable() }).parse(req.body);
    const cid = req.user.companyId;
    const emp = (await pool.query('SELECT * FROM employees WHERE id=$1 AND company_id=$2', [b.employeeId, cid])).rows[0];
    if (!emp) throw httpError(404, 'Employee not found');
    const m = b.date.slice(0, 7);
    const range = employmentRange(fixEmp(emp), m);
    if (!range || b.date < range.from || b.date > range.to) throw httpError(400, 'Employee was not on the books on that date');
    await assertUnlocked(pool, cid, m);
    await setMark(pool, cid, emp.id, b.date, b.status);
    res.json({ ok: true, summary: summarize((await marksFor(pool, cid, m)).get(emp.id) ?? new Map(), fixEmp(emp), m) });
  }));

  // Apply one status (or clear) to a set of employees and dates. By default only unmarked cells are touched.
  r.put('/attendance/bulk', h(async (req, res) => {
    const b = z.object({
      month: monthStr, status: status.nullable(), employeeIds: z.array(z.number().int()).optional(),
      dates: z.array(isoDate).optional(), onlyUnmarked: z.boolean().default(true),
    }).parse(req.body);
    const cid = req.user.companyId;
    await assertUnlocked(pool, cid, b.month);
    if (b.dates?.some((d) => d.slice(0, 7) !== b.month)) throw httpError(400, 'All dates must fall in the month');
    const emps = (await employedIn(pool, cid, b.month)).filter((e) => !b.employeeIds || b.employeeIds.includes(e.id));
    const marks = await marksFor(pool, cid, b.month);
    let changed = 0;
    for (const e of emps) {
      const range = employmentRange(e, b.month);
      for (const d of b.dates ?? datesInMonth(b.month)) {
        if (d < range.from || d > range.to) continue;
        if (b.onlyUnmarked && marks.get(e.id)?.has(d)) continue;
        await setMark(pool, cid, e.id, d, b.status);
        changed++;
      }
    }
    res.json({ changed });
  }));

  // Fill unmarked days from the week-off and holiday settings; optionally default everything else to present.
  r.post('/attendance/autofill', h(async (req, res) => {
    const b = z.object({ month: monthStr, presentByDefault: z.boolean().default(false) }).parse(req.body);
    const cid = req.user.companyId;
    await assertUnlocked(pool, cid, b.month);
    const [emps, marks, hol, st] = await Promise.all([employedIn(pool, cid, b.month), marksFor(pool, cid, b.month), holidays(pool, cid, b.month), settings(pool, cid)]);
    const holSet = new Set(hol.map((x) => x.date));
    const tally = { WO: 0, H: 0, P: 0 };
    for (const e of emps) {
      const range = employmentRange(e, b.month);
      for (const d of datesInMonth(b.month)) {
        if (d < range.from || d > range.to || marks.get(e.id)?.has(d)) continue;
        const s = holSet.has(d) ? 'H' : st.weekOffs.includes(weekday(d)) ? 'WO' : b.presentByDefault ? 'P' : null;
        if (!s) continue;
        await setMark(pool, cid, e.id, d, s);
        tally[s]++;
      }
    }
    res.json({ filled: tally.WO + tally.H + tally.P, ...tally });
  }));

  r.get('/attendance/settings', h(async (req, res) => res.json(await settings(pool, req.user.companyId))));

  r.put('/attendance/settings', h(async (req, res) => {
    const b = z.object({ weekOffs: z.array(z.number().int().min(0).max(6)).max(6) }).parse(req.body);
    const cid = req.user.companyId, val = [...new Set(b.weekOffs)].sort().join(',');
    const exists = (await pool.query('SELECT 1 FROM attendance_settings WHERE company_id=$1', [cid])).rowCount;
    if (exists) await pool.query('UPDATE attendance_settings SET week_offs=$1 WHERE company_id=$2', [val, cid]);
    else await pool.query('INSERT INTO attendance_settings (week_offs, company_id) VALUES ($1,$2)', [val, cid]);
    res.json(await settings(pool, cid));
  }));

  r.get('/attendance/holidays', h(async (req, res) => {
    const y = /^\d{4}$/.test(String(req.query.year)) ? req.query.year : null;
    const { rows } = await pool.query(
      `SELECT * FROM attendance_holidays WHERE company_id=$1 ${y ? 'AND date >= $2 AND date <= $3' : ''} ORDER BY date`,
      y ? [req.user.companyId, `${y}-01-01`, `${y}-12-31`] : [req.user.companyId]);
    res.json(rows.map((x) => ({ ...x, date: ymd(x.date) })));
  }));

  r.post('/attendance/holidays', h(async (req, res) => {
    const b = z.object({ date: isoDate, name: z.string().min(1).max(80) }).parse(req.body);
    const cid = req.user.companyId;
    if ((await pool.query('SELECT 1 FROM attendance_holidays WHERE company_id=$1 AND date=$2', [cid, b.date])).rowCount) throw httpError(409, 'A holiday is already set on that date');
    const row = (await pool.query('INSERT INTO attendance_holidays (company_id, date, name) VALUES ($1,$2,$3) RETURNING *', [cid, b.date, b.name])).rows[0];
    res.status(201).json({ ...row, date: ymd(row.date) });
  }));

  r.delete('/attendance/holidays/:id', h(async (req, res) => {
    const x = await pool.query('DELETE FROM attendance_holidays WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    res.json({ ok: true });
  }));

  return r;
}

