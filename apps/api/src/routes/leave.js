import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { fyOf } from '../compliance.js';
import { employmentRange, weekday } from '../attendance.js';
import { DEFAULT_TYPES, attendanceMark, balanceFor, datesBetween } from '../leave.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const days1 = z.number().multipleOf(0.5);

const typeSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{1,8}$/, 'Code must be 1-8 capital letters or digits'),
  name: z.string().min(1).max(60),
  paid: z.boolean(),
  quota: days1.min(0).max(366).nullable(),
  accrual: z.enum(['monthly', 'annual']),
  carryForwardMax: days1.min(0).max(366),
  active: z.boolean(),
}).partial();

const fixEmp = (e) => ({ ...e, doj: ymd(e.doj), exit_date: e.exit_date ? ymd(e.exit_date) : null });
const fixType = (t) => ({ ...t, quota: t.quota === null ? null : Number(t.quota), carry_forward_max: Number(t.carry_forward_max) });
const fixApp = (a) => ({ ...a, from_date: ymd(a.from_date), to_date: ymd(a.to_date), decided_on: a.decided_on ? ymd(a.decided_on) : null, days: Number(a.days) });
const add = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);

export function leaveRoutes(pool) {
  const r = Router();

  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  /** Leave types for a company; the default set is created the first time anyone asks. */
  async function types(q, cid) {
    let rows = (await q.query('SELECT * FROM leave_types WHERE company_id=$1 ORDER BY id', [cid])).rows;
    if (!rows.length) {
      for (const t of DEFAULT_TYPES)
        await q.query('INSERT INTO leave_types (company_id, code, name, paid, quota, accrual, carry_forward_max) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [cid, t.code, t.name, t.paid, t.quota, t.accrual, t.carry_forward_max]);
      rows = (await q.query('SELECT * FROM leave_types WHERE company_id=$1 ORDER BY id', [cid])).rows;
    }
    return rows.map(fixType);
  }
  async function getType(q, cid, id) {
    const t = (await types(q, cid)).find((x) => x.id === Number(id));
    if (!t) throw httpError(404, 'Leave type not found');
    return t;
  }
  async function getEmployee(q, cid, id) {
    const e = (await q.query('SELECT * FROM employees WHERE id=$1 AND company_id=$2', [id, cid])).rows[0];
    if (!e) throw httpError(404, 'Employee not found');
    return fixEmp(e);
  }

  /** Approved leave and adjustments as Map(employeeId|typeId -> Map(year -> days)). */
  async function ledger(q, cid, status = 'approved') {
    const taken = new Map(), adj = new Map();
    const days = (await q.query(
      `SELECT d.date, d.fraction, a.employee_id, a.leave_type_id FROM leave_application_days d JOIN leave_applications a ON a.id=d.application_id
       WHERE a.company_id=$1 AND a.status=$2`, [cid, status])).rows;
    for (const d of days) {
      const k = `${d.employee_id}|${d.leave_type_id}`;
      if (!taken.has(k)) taken.set(k, new Map());
      add(taken.get(k), fyOf(ymd(d.date)), Number(d.fraction));
    }
    for (const a of (await q.query('SELECT * FROM leave_adjustments WHERE company_id=$1', [cid])).rows) {
      const k = `${a.employee_id}|${a.leave_type_id}`;
      if (!adj.has(k)) adj.set(k, new Map());
      add(adj.get(k), fyOf(ymd(a.date)), Number(a.days));
    }
    return { taken, adj };
  }

  async function pendingMap(q, cid) { return (await ledger(q, cid, 'pending')).taken; }

  const balance = (type, emp, asOf, led, pend) => {
    const k = `${emp.id}|${type.id}`, year = fyOf(asOf);
    const b = balanceFor({ type, emp, year, asOf, taken: led.taken.get(k), adj: led.adj.get(k) });
    const pending = pend.get(k)?.get(year) ?? 0;
    return { ...b, pending, available: b.balance === null ? null : b.balance - pending, year };
  };

  // ---- leave types ----
  r.get('/leave/types', h(async (req, res) => res.json(await types(pool, req.user.companyId))));

  r.post('/leave/types', h(async (req, res) => {
    const b = typeSchema.parse(req.body);
    if (!b.code || !b.name || b.paid === undefined) throw httpError(400, 'code, name and paid are required');
    const cid = req.user.companyId;
    if ((await types(pool, cid)).some((t) => t.code === b.code)) throw httpError(409, `Leave type ${b.code} already exists`);
    if (!b.paid && b.quota != null) throw httpError(400, 'Unpaid leave cannot have a quota: leave it unlimited');
    const row = (await pool.query(
      'INSERT INTO leave_types (company_id, code, name, paid, quota, accrual, carry_forward_max) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [cid, b.code, b.name, b.paid, b.quota ?? null, b.accrual ?? 'monthly', b.carryForwardMax ?? 0])).rows[0];
    res.status(201).json(fixType(row));
  }));

  r.put('/leave/types/:id', h(async (req, res) => {
    const b = typeSchema.omit({ code: true }).parse(req.body);
    const cur = await getType(pool, req.user.companyId, req.params.id);
    const next = { ...cur, ...Object.fromEntries(Object.entries({ name: b.name, paid: b.paid, quota: b.quota, accrual: b.accrual, carry_forward_max: b.carryForwardMax, active: b.active }).filter(([, v]) => v !== undefined)) };
    if (!next.paid && next.quota != null) throw httpError(400, 'Unpaid leave cannot have a quota: leave it unlimited');
    const row = (await pool.query('UPDATE leave_types SET name=$1, paid=$2, quota=$3, accrual=$4, carry_forward_max=$5, active=$6 WHERE id=$7 RETURNING *',
      [next.name, next.paid, next.quota, next.accrual, next.carry_forward_max, next.active, cur.id])).rows[0];
    res.json(fixType(row));
  }));

  // ---- balances ----
  r.get('/leave/balances', h(async (req, res) => {
    const cid = req.user.companyId;
    const asOf = req.query.asOf === undefined ? todayFn() : isoDate.parse(req.query.asOf);
    const [ts, led, pend] = await Promise.all([types(pool, cid), ledger(pool, cid), pendingMap(pool, cid)]);
    let emps = (await pool.query('SELECT * FROM employees WHERE company_id=$1 ORDER BY code', [cid])).rows.map(fixEmp);
    if (req.query.employeeId) emps = emps.filter((e) => e.id === Number(req.query.employeeId));
    else emps = emps.filter((e) => !e.exit_date || e.exit_date >= asOf);       // leavers drop off the overview
    res.json({
      as_of: asOf, year: fyOf(asOf), types: ts.filter((t) => t.active),
      employees: emps.map((e) => ({
        id: e.id, code: e.code, name: e.name,
        balances: Object.fromEntries(ts.filter((t) => t.active).map((t) => [t.code, { type_id: t.id, ...balance(t, e, asOf, led, pend) }])),
      })),
    });
  }));

  r.get('/leave/adjustments', h(async (req, res) => {
    const eid = req.query.employeeId ? Number(req.query.employeeId) : null;
    const { rows } = await pool.query(
      `SELECT a.*, e.name AS employee_name, t.code AS type_code FROM leave_adjustments a
       JOIN employees e ON e.id=a.employee_id JOIN leave_types t ON t.id=a.leave_type_id
       WHERE a.company_id=$1 ${eid ? 'AND a.employee_id=$2' : ''} ORDER BY a.id DESC`, eid ? [req.user.companyId, eid] : [req.user.companyId]);
    res.json(rows.map((x) => ({ ...x, date: ymd(x.date), days: Number(x.days) })));
  }));

  r.post('/leave/adjustments', h(async (req, res) => {
    const b = z.object({ employeeId: z.number().int(), leaveTypeId: z.number().int(), days: days1.refine((v) => v !== 0, 'days cannot be zero'), date: isoDate.optional(), reason: z.string().min(1).max(200) }).parse(req.body);
    const cid = req.user.companyId;
    const emp = await getEmployee(pool, cid, b.employeeId);
    const type = await getType(pool, cid, b.leaveTypeId);
    if (type.quota === null) throw httpError(400, `${type.code} is unlimited: there is no balance to adjust`);
    const date = b.date ?? todayFn();
    if (b.days < 0) {
      const bal = balance(type, emp, date, await ledger(pool, cid), new Map());
      if (bal.balance + b.days < -1e-9) throw httpError(400, `Balance is ${bal.balance} day(s): cannot deduct ${-b.days}`);
    }
    const row = (await pool.query('INSERT INTO leave_adjustments (company_id, employee_id, leave_type_id, date, days, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [cid, emp.id, type.id, date, b.days, b.reason, req.user.id])).rows[0];
    res.status(201).json({ ...row, date: ymd(row.date), days: Number(row.days) });
  }));

  // ---- applications ----
  async function workingDays(q, cid, emp, from, to) {
    const st = (await q.query('SELECT week_offs FROM attendance_settings WHERE company_id=$1', [cid])).rows[0];
    const offs = (st ? st.week_offs : '0').split(',').filter((x) => x !== '').map(Number);
    const hol = new Set((await q.query('SELECT date FROM attendance_holidays WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, to])).rows.map((x) => ymd(x.date)));
    return datesBetween(from, to).filter((d) => !offs.includes(weekday(d)) && !hol.has(d));
  }

  const lockedMonth = async (q, cid, months) => {
    for (const m of months) {
      if ((await q.query("SELECT 1 FROM payroll_runs WHERE company_id=$1 AND month=$2 AND status IN ('finalized','paid')", [cid, m])).rowCount)
        throw httpError(409, `Payroll for ${m} is finalized: reopen it before changing leave that falls in that month`);
    }
  };

  r.get('/leave/applications', h(async (req, res) => {
    const args = [req.user.companyId];
    let where = 'a.company_id=$1';
    const push = (sql, v) => { args.push(v); where += ` AND ${sql.replace('?', `$${args.length}`)}`; };
    if (req.query.status) push('a.status = ?', String(req.query.status));
    if (req.query.employeeId) push('a.employee_id = ?', Number(req.query.employeeId));
    if (/^\d{4}-\d{2}$/.test(String(req.query.month ?? ''))) { push('a.to_date >= ?', `${req.query.month}-01`); push('a.from_date <= ?', `${req.query.month}-31`); }
    const { rows } = await pool.query(
      `SELECT a.*, e.name AS employee_name, e.code AS employee_code, t.code AS type_code, t.name AS type_name, t.paid
       FROM leave_applications a JOIN employees e ON e.id=a.employee_id JOIN leave_types t ON t.id=a.leave_type_id
       WHERE ${where} ORDER BY a.from_date DESC, a.id DESC`, args);
    res.json(rows.map(fixApp));
  }));

  r.post('/leave/applications', h(async (req, res) => {
    const b = z.object({
      employeeId: z.number().int(), leaveTypeId: z.number().int(), fromDate: isoDate, toDate: isoDate,
      halfDay: z.enum(['first', 'second']).nullable().optional(), reason: z.string().max(300).optional(),
    }).parse(req.body);
    const cid = req.user.companyId;
    const out = await withTx(async (q) => {
      const emp = await getEmployee(q, cid, b.employeeId);
      const type = await getType(q, cid, b.leaveTypeId);
      if (!type.active) throw httpError(400, `${type.code} is not active`);
      if (b.toDate < b.fromDate) throw httpError(400, 'The end date is before the start date');
      if (b.halfDay && b.fromDate !== b.toDate) throw httpError(400, 'A half day can only be taken on a single date');
      if (fyOf(b.fromDate) !== fyOf(b.toDate)) throw httpError(400, 'Leave cannot span two leave years (April-March): apply for each year separately');

      const range = employmentRange(emp, b.fromDate.slice(0, 7));
      const endRange = employmentRange(emp, b.toDate.slice(0, 7));
      if (!range || !endRange || b.fromDate < emp.doj || (emp.exit_date && b.toDate > emp.exit_date)) throw httpError(400, 'Dates must fall within the employee\'s period of employment');

      const dates = await workingDays(q, cid, emp, b.fromDate, b.toDate);
      if (!dates.length) throw httpError(400, 'Those dates are all week offs or holidays: there is nothing to apply for');
      const fraction = b.halfDay ? 0.5 : 1;
      const total = dates.length * fraction;

      const clash = (await q.query(
        `SELECT 1 FROM leave_application_days d JOIN leave_applications a ON a.id=d.application_id
         WHERE a.employee_id=$1 AND a.status IN ('pending','approved') AND d.date IN (${dates.map((_, i) => `$${i + 2}`).join(',')})`, [emp.id, ...dates])).rowCount;
      if (clash) throw httpError(409, 'The employee already has leave applied for some of those dates');

      if (type.quota !== null) {
        const bal = balance(type, emp, b.fromDate, await ledger(q, cid), await pendingMap(q, cid));
        if (total > bal.available + 1e-9) throw httpError(400, `Only ${bal.available} day(s) of ${type.code} available (balance ${bal.balance}, ${bal.pending} already pending). Choose a leave-without-pay type or reduce the dates.`);
      }

      const app = (await q.query(
        `INSERT INTO leave_applications (company_id, employee_id, leave_type_id, from_date, to_date, half_day, days, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [cid, emp.id, type.id, b.fromDate, b.toDate, b.halfDay ?? null, total, b.reason ?? null])).rows[0];
      for (const d of dates) await q.query('INSERT INTO leave_application_days (application_id, date, fraction) VALUES ($1,$2,$3)', [app.id, d, fraction]);
      return fixApp(app);
    });
    res.status(201).json(out);
  }));

  const loadApp = async (q, req) => {
    const a = (await q.query('SELECT * FROM leave_applications WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!a) throw httpError(404, 'Not found');
    return a;
  };
  const dayRows = async (q, appId) => (await q.query('SELECT * FROM leave_application_days WHERE application_id=$1 ORDER BY date', [appId])).rows.map((d) => ({ ...d, date: ymd(d.date), fraction: Number(d.fraction) }));
  const monthsOf = (days) => [...new Set(days.map((d) => d.date.slice(0, 7)))];
  const markOf = async (q, empId, date) => (await q.query('SELECT status FROM attendance WHERE employee_id=$1 AND date=$2', [empId, date])).rows[0]?.status ?? null;
  const setMark = async (q, cid, empId, date, s) => {
    await q.query('DELETE FROM attendance WHERE employee_id=$1 AND date=$2', [empId, date]);
    if (s) await q.query('INSERT INTO attendance (company_id, employee_id, date, status) VALUES ($1,$2,$3,$4)', [cid, empId, date, s]);
  };

  // Approving writes the leave into the attendance register (L / HL paid, A / HD unpaid), so payroll picks up loss of pay.
  r.post('/leave/applications/:id/approve', h(async (req, res) => {
    const b = z.object({ note: z.string().max(200).optional(), leaveTypeId: z.number().int().optional() }).parse(req.body ?? {});
    const cid = req.user.companyId;
    const out = await withTx(async (q) => {
      const app = await loadApp(q, req);
      if (app.status !== 'pending') throw httpError(409, `Application is already ${app.status}`);
      const type = await getType(q, cid, b.leaveTypeId ?? app.leave_type_id);
      if (!type.active) throw httpError(400, `${type.code} is not active`);
      const emp = await getEmployee(q, cid, app.employee_id);
      const days = await dayRows(q, app.id);
      await lockedMonth(q, cid, monthsOf(days));

      if (type.quota !== null) {
        const bal = balance(type, emp, ymd(app.from_date), await ledger(q, cid), new Map());   // other pending requests do not block this one
        if (Number(app.days) > bal.balance + 1e-9) throw httpError(400, `Insufficient ${type.code} balance: ${bal.balance} day(s) available, ${Number(app.days)} requested. Approve it as another type, e.g. leave without pay.`);
      }
      for (const d of days) {
        const mark = attendanceMark(type.paid, d.fraction);
        const prev = await markOf(q, emp.id, d.date);
        await setMark(q, cid, emp.id, d.date, mark);
        await q.query('UPDATE leave_application_days SET mark=$1, prev_mark=$2 WHERE id=$3', [mark, prev, d.id]);
      }
      return fixApp((await q.query(
        `UPDATE leave_applications SET status='approved', leave_type_id=$1, decided_by=$2, decided_on=$3, decision_note=$4 WHERE id=$5 RETURNING *`,
        [type.id, req.user.id, todayFn(), b.note ?? null, app.id])).rows[0]);
    });
    res.json(out);
  }));

  r.post('/leave/applications/:id/reject', h(async (req, res) => {
    const b = z.object({ note: z.string().max(200).optional() }).parse(req.body ?? {});
    const app = await loadApp(pool, req);
    if (app.status !== 'pending') throw httpError(409, `Application is already ${app.status}`);
    res.json(fixApp((await pool.query(`UPDATE leave_applications SET status='rejected', decided_by=$1, decided_on=$2, decision_note=$3 WHERE id=$4 RETURNING *`,
      [req.user.id, todayFn(), b.note ?? null, app.id])).rows[0]));
  }));

  // Cancel a pending or approved application. An approved one restores whatever the register showed before.
  r.post('/leave/applications/:id/cancel', h(async (req, res) => {
    const cid = req.user.companyId;
    const out = await withTx(async (q) => {
      const app = await loadApp(q, req);
      if (!['pending', 'approved'].includes(app.status)) throw httpError(409, `Application is already ${app.status}`);
      if (app.status === 'approved') {
        const days = await dayRows(q, app.id);
        await lockedMonth(q, cid, monthsOf(days));
        for (const d of days) {
          if (d.mark && (await markOf(q, app.employee_id, d.date)) === d.mark) await setMark(q, cid, app.employee_id, d.date, d.prev_mark);
        }
      }
      return fixApp((await q.query(`UPDATE leave_applications SET status='cancelled' WHERE id=$1 RETURNING *`, [app.id])).rows[0]);
    });
    res.json(out);
  }));

  // Dashboard roll-up.
  r.get('/leave/summary', h(async (req, res) => {
    const cid = req.user.companyId;
    const asOf = req.query.asOf === undefined ? todayFn() : isoDate.parse(req.query.asOf);
    const pending = (await pool.query("SELECT COUNT(*) AS n FROM leave_applications WHERE company_id=$1 AND status='pending'", [cid])).rows[0].n;
    const away = (await pool.query(
      `SELECT DISTINCT e.name, t.code, d.fraction FROM leave_application_days d JOIN leave_applications a ON a.id=d.application_id
       JOIN employees e ON e.id=a.employee_id JOIN leave_types t ON t.id=a.leave_type_id
       WHERE a.company_id=$1 AND a.status='approved' AND d.date=$2`, [cid, asOf])).rows;
    res.json({ pending: Number(pending), on_leave: away.map((x) => ({ name: x.name, type: x.code, half_day: Number(x.fraction) === 0.5 })) });
  }));

  return r;
}
