import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today, ymd } from '../util.js';
import { A, post } from '../ledger.js';
import { fyOf, parseFy } from '../compliance.js';
import { computePayslip, employedDays, monthInfo, runTotals, taxTable } from '../payroll.js';
import { summarize } from '../attendance.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().nonnegative().max(100000000);
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const empSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  designation: z.string().max(100).nullable(), department: z.string().max(100).nullable(),
  empType: z.enum(['full_time', 'part_time', 'intern', 'contract']),
  doj: isoDate, exitDate: isoDate.nullable(),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').nullable(),
  uan: z.string().regex(/^\d{12}$/, 'UAN is a 12-digit number').nullable(), esiNo: z.string().regex(/^(\d{10}|\d{17})$/, 'ESI insurance number is 10 or 17 digits').nullable(),
  bankAccount: z.string().max(30).nullable(),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC').nullable(),
  mobile: z.string().max(15).nullable(), email: z.string().email().nullable(),
  basic: z.number().positive().max(100000000), hra: money, special: money, travel: money, medical: money,
  pfApplicable: z.boolean(), pfOnActual: z.boolean(), esiApplicable: z.boolean(),
  ptMonthly: money, taxRegime: z.enum(['new', 'old']), declaredDeductions: money,
}).partial();

const DEFAULTS = {
  designation: null, department: null, empType: 'full_time', exitDate: null, pan: null, uan: null, esiNo: null, bankAccount: null,
  ifsc: null, mobile: null, email: null, hra: 0, special: 0, travel: 0, medical: 0,
  pfApplicable: true, pfOnActual: false, esiApplicable: true, ptMonthly: 0, taxRegime: 'new', declaredDeductions: 0,
};
const COLS = { empType: 'emp_type', exitDate: 'exit_date', esiNo: 'esi_no', bankAccount: 'bank_account', pfApplicable: 'pf_applicable',
  pfOnActual: 'pf_on_actual', esiApplicable: 'esi_applicable', ptMonthly: 'pt_monthly', taxRegime: 'tax_regime', declaredDeductions: 'declared_deductions' };
const toCols = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [COLS[k] ?? k, v]));

// Generic helpers. Table and column names come from code, never from the request.
const insertObj = async (q, table, o) => {
  const k = Object.keys(o);
  return (await q.query(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => o[x]))).rows[0];
};
const updateObj = async (q, table, id, o) => {
  const k = Object.keys(o);
  return (await q.query(`UPDATE ${table} SET ${k.map((x, i) => `${x}=$${i + 1}`).join(', ')} WHERE id=$${k.length + 1} RETURNING *`, [...k.map((x) => o[x]), id])).rows[0];
};

const fixEmp = (e) => ({ ...e, doj: ymd(e.doj), exit_date: e.exit_date ? ymd(e.exit_date) : null });
const DATE_COLS = ['finalized_on', 'paid_on', 'remitted_pf', 'remitted_esi', 'remitted_tds', 'remitted_pt'];
const fixRun = (r) => ({ ...r, ...Object.fromEntries(DATE_COLS.map((c) => [c, r[c] ? ymd(r[c]) : null])) });
const fixSlip = (s) => ({ ...s, doj: s.doj ? ymd(s.doj) : null, warnings: s.warnings ? JSON.parse(s.warnings) : [] });

const HEADS = {
  pf: { label: 'PF', col: 'remitted_pf', account: A.PF_PAYABLE, amount: (r) => Number(r.pf_employee) + Number(r.pf_employer) + Number(r.edli) + Number(r.pf_admin) },
  esi: { label: 'ESI', col: 'remitted_esi', account: A.ESI_PAYABLE, amount: (r) => Number(r.esi_employee) + Number(r.esi_employer) },
  tds: { label: 'TDS on salary', col: 'remitted_tds', account: A.TDS_PAYABLE, amount: (r) => Number(r.tds) },
  pt: { label: 'Professional tax', col: 'remitted_pt', account: A.PT_PAYABLE, amount: (r) => Number(r.professional_tax) },
};

/** Statutory due dates for a payroll month (matches the compliance calendar rules). */
function dueDates(month) {
  const { y, m } = monthInfo(month);
  const nm = m === 12 ? [y + 1, 1] : [y, m + 1];
  const d = (day) => `${nm[0]}-${String(nm[1]).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { pf: d(15), esi: d(15), tds: m === 3 ? `${y}-04-30` : d(7) };
}

export function payrollRoutes(pool) {
  const r = Router();

  async function getEmployee(q, req, id = req.params.id) {
    const e = (await q.query('SELECT * FROM employees WHERE id=$1 AND company_id=$2', [id, req.user.companyId])).rows[0];
    if (!e) throw httpError(404, 'Not found');
    return fixEmp(e);
  }
  async function getRun(q, req) {
    const run = (await q.query('SELECT * FROM payroll_runs WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!run) throw httpError(404, 'Not found');
    return fixRun(run);
  }

  // ---- employees ----
  r.get('/payroll/employees', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM employees WHERE company_id=$1 ORDER BY code', [req.user.companyId]);
    res.json(rows.map(fixEmp));
  }));

  r.get('/payroll/employees/:id', h(async (req, res) => res.json(await getEmployee(pool, req))));

  r.post('/payroll/employees', h(async (req, res) => {
    const b = { ...DEFAULTS, ...empSchema.parse(req.body) };
    if (!b.name || !b.doj || !b.basic) throw httpError(400, 'name, doj and basic are required');
    if (b.exitDate && b.exitDate < b.doj) throw httpError(400, 'Exit date cannot be before the joining date');
    const cid = req.user.companyId;
    if (!b.code) {
      const n = (await pool.query('SELECT COUNT(*) AS n FROM employees WHERE company_id=$1', [cid])).rows[0].n;
      b.code = `EMP-${String(Number(n) + 1).padStart(3, '0')}`;
    }
    if ((await pool.query('SELECT 1 FROM employees WHERE company_id=$1 AND code=$2', [cid, b.code])).rowCount)
      throw httpError(409, `Employee code ${b.code} already exists`);
    res.status(201).json(fixEmp(await insertObj(pool, 'employees', { company_id: cid, ...toCols(b) })));
  }));

  r.put('/payroll/employees/:id', h(async (req, res) => {
    const b = empSchema.omit({ code: true }).parse(req.body);
    const cur = await getEmployee(pool, req);
    if (!Object.keys(b).length) throw httpError(400, 'Nothing to update');
    const doj = b.doj ?? cur.doj, exit = b.exitDate === undefined ? cur.exit_date : b.exitDate;
    if (exit && exit < doj) throw httpError(400, 'Exit date cannot be before the joining date');
    res.json(fixEmp(await updateObj(pool, 'employees', cur.id, toCols(b))));
  }));

  // ---- runs ----
  async function ytdFor(q, cid, empId, month) {
    const s0 = parseFy(fyOf(`${month}-01`));
    const row = (await q.query(
      `SELECT COALESCE(SUM(s.gross),0) AS gross, COALESCE(SUM(s.tds),0) AS tds
       FROM payslips s JOIN payroll_runs r ON r.id=s.run_id
       WHERE r.company_id=$1 AND s.employee_id=$2 AND r.month >= $3 AND r.month < $4 AND r.status IN ('finalized','paid')`,
      [cid, empId, `${s0}-04`, month])).rows[0];
    return { gross: Number(row.gross), tds: Number(row.tds) };
  }

  /** Attendance register summary (loss of pay, unmarked days) for one employee and month. */
  async function registerFor(q, cid, emp, month) {
    const { start, end } = monthInfo(month);
    const rows = (await q.query('SELECT date, status FROM attendance WHERE employee_id=$1 AND company_id=$2 AND date >= $3 AND date <= $4', [emp.id, cid, start, end])).rows;
    return summarize(new Map(rows.map((x) => [ymd(x.date), x.status])), emp, month);
  }

  /** Slip columns for an employee in a month (snapshot + computed amounts). */
  async function buildSlip(q, cid, emp, month, adj) {
    const c = computePayslip(emp, month, {
      lopDays: adj.lop_days ?? 0, otherEarnings: adj.other_earnings ?? 0, otherDeductions: adj.other_deductions ?? 0,
      ytd: await ytdFor(q, cid, emp.id, month),
    });
    const { warnings, ...cols } = c;
    // Only comment on the register if it is being used for this employee and month.
    const reg = await registerFor(q, cid, emp, month);
    if (reg.marked > 0 && reg.unmarked > 0) warnings.push(`${reg.unmarked} day(s) are not marked in the attendance register and are paid as present.`);
    return {
      emp_code: emp.code, emp_name: emp.name, designation: emp.designation, department: emp.department, pan: emp.pan, uan: emp.uan,
      bank_account: emp.bank_account, ifsc: emp.ifsc, doj: emp.doj, ...cols, warnings: JSON.stringify(warnings),
    };
  }

  async function refreshTotals(q, runId) {
    const slips = (await q.query('SELECT * FROM payslips WHERE run_id=$1', [runId])).rows;
    const t = runTotals(slips);
    await updateObj(q, 'payroll_runs', runId, {
      employees: t.employees, gross: t.gross, net: t.net, pf_employee: t.pf_employee, pf_employer: t.pf_employer, edli: t.edli, pf_admin: t.pf_admin,
      esi_employee: t.esi_employee, esi_employer: t.esi_employer, tds: t.tds, professional_tax: t.professional_tax, other_deductions: t.other_deductions,
    });
    return t;
  }

  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  r.get('/payroll/runs', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM payroll_runs WHERE company_id=$1 ORDER BY month DESC', [req.user.companyId]);
    res.json(rows.map(fixRun));
  }));

  r.get('/payroll/runs/:id', h(async (req, res) => {
    const run = await getRun(pool, req);
    const slips = (await pool.query('SELECT * FROM payslips WHERE run_id=$1 ORDER BY emp_code', [run.id])).rows.map(fixSlip);
    for (const s of slips) {
      const emp = (await pool.query('SELECT * FROM employees WHERE id=$1', [s.employee_id])).rows[0];
      s.register = await registerFor(pool, req.user.companyId, fixEmp(emp), run.month);
    }
    const company = (await pool.query('SELECT name, gstin, address, state_code FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    const { fy, verified, exact } = taxTable(fyOf(`${run.month}-01`));
    res.json({ ...run, slips, company, due_dates: dueDates(run.month), tax_table: { fy, verified, exact } });
  }));

  r.post('/payroll/runs', h(async (req, res) => {
    const { month } = z.object({ month: monthStr }).parse(req.body);
    if (month > today().slice(0, 7)) throw httpError(400, 'Cannot run payroll for a future month');
    const cid = req.user.companyId;
    const run = await withTx(async (q) => {
      if ((await q.query('SELECT 1 FROM payroll_runs WHERE company_id=$1 AND month=$2', [cid, month])).rowCount)
        throw httpError(409, `Payroll for ${month} already exists`);
      const emps = (await q.query('SELECT * FROM employees WHERE company_id=$1 ORDER BY code', [cid])).rows.map(fixEmp)
        .filter((e) => employedDays(e, month) > 0);
      if (!emps.length) throw httpError(400, 'No employees on payroll for this month');
      const run = await insertObj(q, 'payroll_runs', { company_id: cid, month });
      for (const e of emps) {
        const reg = await registerFor(q, cid, e, month);
        await insertObj(q, 'payslips', { run_id: run.id, employee_id: e.id, ...(await buildSlip(q, cid, e, month, { lop_days: reg.lop })) });
      }
      await refreshTotals(q, run.id);
      return run;
    });
    res.status(201).json(fixRun((await pool.query('SELECT * FROM payroll_runs WHERE id=$1', [run.id])).rows[0]));
  }));

  const requireDraft = (run) => { if (run.status !== 'draft') throw httpError(409, `Payroll is ${run.status}; only a draft can be edited`); };

  // Edit one payslip's loss of pay / one-off earnings / deductions (draft only). Recomputes TDS for that employee.
  r.put('/payroll/runs/:id/payslips/:slipId', h(async (req, res) => {
    const b = z.object({ lopDays: z.number().min(0).max(31), otherEarnings: money, otherDeductions: money }).partial().parse(req.body);
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      requireDraft(run);
      const slip = (await q.query('SELECT * FROM payslips WHERE id=$1 AND run_id=$2', [req.params.slipId, run.id])).rows[0];
      if (!slip) throw httpError(404, 'Not found');
      const emp = await getEmployee(q, req, slip.employee_id);
      const next = await buildSlip(q, req.user.companyId, emp, run.month, {
        lop_days: b.lopDays ?? Number(slip.lop_days), other_earnings: b.otherEarnings ?? Number(slip.other_earnings), other_deductions: b.otherDeductions ?? Number(slip.other_deductions),
      });
      const updated = await updateObj(q, 'payslips', slip.id, next);
      await refreshTotals(q, run.id);
      return fixSlip(updated);
    });
    res.json(out);
  }));

  // Recompute every slip from the current employee master, keeping the LOP and adjustments already entered.
  r.post('/payroll/runs/:id/recalculate', h(async (req, res) => {
    await withTx(async (q) => {
      const run = await getRun(q, req);
      requireDraft(run);
      const slips = (await q.query('SELECT * FROM payslips WHERE run_id=$1', [run.id])).rows;
      for (const s of slips) {
        const emp = await getEmployee(q, req, s.employee_id);
        if (employedDays(emp, run.month) === 0) { await q.query('DELETE FROM payslips WHERE id=$1', [s.id]); continue; }
        await updateObj(q, 'payslips', s.id, await buildSlip(q, req.user.companyId, emp, run.month, {
          lop_days: Math.min(Number(s.lop_days), employedDays(emp, run.month)), other_earnings: Number(s.other_earnings), other_deductions: Number(s.other_deductions),
        }));
      }
      await refreshTotals(q, run.id);
    });
    res.json({ ok: true });
  }));

  // Overwrite every slip's loss of pay with what the attendance register says (draft only). Other adjustments are kept.
  r.post('/payroll/runs/:id/sync-attendance', h(async (req, res) => {
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      requireDraft(run);
      const slips = (await q.query('SELECT * FROM payslips WHERE run_id=$1', [run.id])).rows;
      let changed = 0;
      for (const s of slips) {
        const emp = await getEmployee(q, req, s.employee_id);
        const reg = await registerFor(q, req.user.companyId, emp, run.month);
        if (Number(s.lop_days) !== reg.lop) changed++;
        await updateObj(q, 'payslips', s.id, await buildSlip(q, req.user.companyId, emp, run.month, {
          lop_days: reg.lop, other_earnings: Number(s.other_earnings), other_deductions: Number(s.other_deductions),
        }));
      }
      await refreshTotals(q, run.id);
      return { changed };
    });
    res.json(out);
  }));

  r.delete('/payroll/runs/:id', h(async (req, res) => {
    await withTx(async (q) => {
      const run = await getRun(q, req);
      requireDraft(run);
      await q.query('DELETE FROM payslips WHERE run_id=$1', [run.id]);
      await q.query('DELETE FROM payroll_runs WHERE id=$1', [run.id]);
    });
    res.json({ ok: true });
  }));

  // Finalize: lock the run and post the accrual journal.
  r.post('/payroll/runs/:id/finalize', h(async (req, res) => {
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      requireDraft(run);
      const slips = (await q.query('SELECT * FROM payslips WHERE run_id=$1', [run.id])).rows;
      if (!slips.length) throw httpError(400, 'Nothing to finalize');
      const neg = slips.filter((s) => Number(s.net) < 0);
      if (neg.length) throw httpError(400, `Negative net pay for ${neg.map((s) => s.emp_name).join(', ')}: fix before finalizing`);
      const t = runTotals(slips);
      await refreshTotals(q, run.id);
      const entryId = await post(q, {
        companyId: req.user.companyId, date: monthInfo(run.month).end, sourceType: 'payroll', sourceId: run.id,
        narration: `Payroll ${run.month}`,
        lines: [
          { code: A.SALARY_EXP, debit: t.gross }, { code: A.EMPR_CONTRIB_EXP, debit: t.employer_contributions },
          { code: A.SALARY_PAYABLE, credit: t.net }, { code: A.PF_PAYABLE, credit: t.pf_payable }, { code: A.ESI_PAYABLE, credit: t.esi_payable },
          { code: A.TDS_PAYABLE, credit: t.tds }, { code: A.PT_PAYABLE, credit: t.professional_tax }, { code: A.EMP_ADVANCES, credit: t.other_deductions },
        ],
      });
      return updateObj(q, 'payroll_runs', run.id, { status: 'finalized', journal_entry_id: entryId, finalized_on: today() });
    });
    res.json(fixRun(out));
  }));

  // Undo a finalize (not once paid or remitted): posts a reversing entry and returns the run to draft.
  r.post('/payroll/runs/:id/reopen', h(async (req, res) => {
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      if (run.status !== 'finalized') throw httpError(409, run.status === 'paid' ? 'Salary has been paid; the run can no longer be reopened' : 'Only a finalized run can be reopened');
      const done = Object.values(HEADS).filter((hd) => run[hd.col]);
      if (done.length) throw httpError(409, `${done.map((d) => d.label).join(', ')} already remitted; the run can no longer be reopened`);
      const lines = (await q.query('SELECT account_id, debit, credit FROM journal_lines WHERE entry_id=$1', [run.journal_entry_id])).rows;
      await post(q, {
        companyId: req.user.companyId, date: today() < monthInfo(run.month).end ? monthInfo(run.month).end : today(), sourceType: 'payroll', sourceId: run.id,
        narration: `Reversal of payroll ${run.month} (reopened)`,
        lines: lines.map((l) => ({ accountId: l.account_id, debit: Number(l.credit), credit: Number(l.debit) })),
      });
      return updateObj(q, 'payroll_runs', run.id, { status: 'draft', journal_entry_id: null, finalized_on: null });
    });
    res.json(fixRun(out));
  }));

  const payBody = z.object({ mode: z.enum(['cash', 'bank']).default('bank'), date: isoDate.optional() });

  r.post('/payroll/runs/:id/pay', h(async (req, res) => {
    const b = payBody.parse(req.body ?? {});
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      if (run.status !== 'finalized') throw httpError(409, run.status === 'paid' ? 'Already paid' : 'Finalize the payroll before paying salaries');
      const date = b.date ?? today();
      if (date < monthInfo(run.month).start) throw httpError(400, 'Payment date cannot be before the payroll month');
      if (Number(run.net) > 0)
        await post(q, { companyId: req.user.companyId, date, sourceType: 'payroll', sourceId: run.id, narration: `Salaries paid for ${run.month}`,
          lines: [{ code: A.SALARY_PAYABLE, debit: Number(run.net) }, { code: b.mode === 'bank' ? A.BANK : A.CASH, credit: Number(run.net) }] });
      return updateObj(q, 'payroll_runs', run.id, { status: 'paid', paid_on: date, pay_mode: b.mode });
    });
    res.json(fixRun(out));
  }));

  // Record paying a statutory liability (PF, ESI, TDS, professional tax) for a run.
  r.post('/payroll/runs/:id/remit', h(async (req, res) => {
    const b = payBody.extend({ head: z.enum(['pf', 'esi', 'tds', 'pt']) }).parse(req.body);
    const out = await withTx(async (q) => {
      const run = await getRun(q, req);
      if (run.status === 'draft') throw httpError(409, 'Finalize the payroll first');
      const hd = HEADS[b.head];
      if (run[hd.col]) throw httpError(409, `${hd.label} for ${run.month} is already recorded as paid`);
      const amount = hd.amount(run);
      if (amount <= 0) throw httpError(400, `No ${hd.label} to remit for ${run.month}`);
      const date = b.date ?? today();
      if (date < monthInfo(run.month).start) throw httpError(400, 'Payment date cannot be before the payroll month');
      await post(q, { companyId: req.user.companyId, date, sourceType: 'payroll', sourceId: run.id, narration: `${hd.label} remitted for ${run.month}`,
        lines: [{ code: hd.account, debit: amount }, { code: b.mode === 'bank' ? A.BANK : A.CASH, credit: amount }] });
      return updateObj(q, 'payroll_runs', run.id, { [hd.col]: date });
    });
    res.json(fixRun(out));
  }));

  return r;
}
