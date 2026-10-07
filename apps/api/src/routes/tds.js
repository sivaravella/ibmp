import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { fyOf, parseFy } from '../compliance.js';
import {
  BSR_RE, CHALLAN_SERIAL_RE, CSV_COLUMNS, DEDUCTOR_TYPES, PAN_RE, TAN_RE, TOKEN_RE, annualSummary, assessmentYear, build24q, quarterMonths, quarterOf, statementDue, tdsDueDate, toCsv,
} from '../tds.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = (err, c) => Object.assign(err, { code: c });
const blank = (v) => (v === '' ? null : v);

export function tdsRoutes(pool) {
  const r = Router();
  const needOwner = (req) => { if (req.user.role !== 'owner') throw code(httpError(403, 'Only the account owner can change TDS records.'), 'OWNER_ONLY'); };

  const fyParam = (req) => {
    const fy = req.query.fy ?? fyOf(todayFn());
    if (parseFy(fy) === null) throw httpError(400, 'fy must look like 2026-27');
    return fy;
  };
  const asOf = (req) => {
    if (req.query.asOf === undefined) return todayFn();
    if (!isoDate.safeParse(req.query.asOf).success) throw httpError(400, 'asOf must be YYYY-MM-DD');
    return req.query.asOf;
  };
  const company = async (cid) => (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];

  const fixRun = (x) => ({ ...x, paid_on: x.paid_on ? ymd(x.paid_on) : null, remitted_tds: x.remitted_tds ? ymd(x.remitted_tds) : null });

  /** Finalized and paid payroll for a financial year: runs, payslips and the employee master. */
  async function loadFy(cid, fy) {
    const s0 = parseFy(fy);
    const from = `${s0}-04`, to = `${s0 + 1}-03`;
    const runs = (await pool.query("SELECT * FROM payroll_runs WHERE company_id=$1 AND month >= $2 AND month <= $3 AND status IN ('finalized','paid') ORDER BY month", [cid, from, to])).rows.map(fixRun);
    const slips = (await pool.query(
      `SELECT s.*, r.month FROM payslips s JOIN payroll_runs r ON r.id=s.run_id
       WHERE r.company_id=$1 AND r.month >= $2 AND r.month <= $3 AND r.status IN ('finalized','paid') ORDER BY r.month, s.emp_code`, [cid, from, to])).rows;
    const employees = (await pool.query('SELECT * FROM employees WHERE company_id=$1', [cid])).rows.map((e) => ({ ...e, doj: ymd(e.doj), exit_date: e.exit_date ? ymd(e.exit_date) : null }));
    // A PAN corrected after payroll was run is the one to report, so the current record wins over the payslip's snapshot.
    const panOf = new Map(employees.map((e) => [e.id, e.pan]));
    for (const s of slips) s.pan = panOf.get(s.employee_id) ?? s.pan;
    const statements = (await pool.query('SELECT * FROM tds_statements WHERE company_id=$1 AND fy=$2', [cid, fy])).rows.map((s) => ({ ...s, filed_on: ymd(s.filed_on) }));
    return { runs, slips, employees, statements };
  }

  // ---------- deductor details ----------

  r.get('/tds/settings', h(async (req, res) => {
    const c = await company(req.user.companyId);
    res.json({
      tan: c.tan, pan: c.pan, pan_from_gstin: c.gstin ? c.gstin.slice(2, 12) : null, deductor_type: c.deductor_type,
      responsible_name: c.tds_person_name, responsible_designation: c.tds_person_designation, deductor_types: DEDUCTOR_TYPES,
      address_ok: !!(c.addr1 && c.loc && c.pin),
    });
  }));

  r.put('/tds/settings', h(async (req, res) => {
    needOwner(req);
    const raw = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, blank(typeof v === 'string' ? v.trim() : v)]));
    const b = z.object({
      tan: z.string().toUpperCase().regex(TAN_RE, 'TAN must be 4 letters, 5 digits and 1 letter, e.g. HYDR12345A').nullable(),
      pan: z.string().toUpperCase().regex(PAN_RE, 'PAN must look like ABCDE1234F').nullable(),
      deductorType: z.enum(DEDUCTOR_TYPES).nullable(), responsibleName: z.string().max(100).nullable(), responsibleDesignation: z.string().max(100).nullable(),
    }).partial().parse(raw);
    const cols = { tan: 'tan', pan: 'pan', deductorType: 'deductor_type', responsibleName: 'tds_person_name', responsibleDesignation: 'tds_person_designation' };
    const keys = Object.keys(b);
    if (!keys.length) throw httpError(400, 'Nothing to update');
    await pool.query(`UPDATE companies SET ${keys.map((k, i) => `${cols[k]}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => b[k]), req.user.companyId]);
    res.json({ ok: true });
  }));

  // ---------- challans: the bank details of each month's TDS deposit ----------

  r.get('/tds/runs', h(async (req, res) => {
    const fy = fyParam(req);
    const { runs, slips } = await loadFy(req.user.companyId, fy);
    res.json({
      fy,
      runs: runs.map((x) => {
        const tds = slips.filter((s) => s.run_id === x.id).reduce((t, s) => t + Number(s.tds), 0);
        return {
          run_id: x.id, month: x.month, quarter: quarterOf(x.month), tds, due_date: tdsDueDate(x.month), deposited_on: x.remitted_tds,
          bsr: x.tds_bsr, challan_serial: x.tds_challan_serial, interest: Number(x.tds_interest), fee: Number(x.tds_fee),
          late: !!x.remitted_tds && x.remitted_tds > tdsDueDate(x.month),
        };
      }).filter((x) => x.tds > 0),
    });
  }));

  r.put('/tds/runs/:id/challan', h(async (req, res) => {
    needOwner(req);
    const b = z.object({
      bsr: z.string().regex(BSR_RE, 'BSR code is 7 digits'), serial: z.string().regex(CHALLAN_SERIAL_RE, 'Challan serial number is 5 digits'),
      interest: z.number().min(0).max(100000000).default(0), fee: z.number().min(0).max(100000000).default(0),
    }).parse(req.body);
    const run = (await pool.query('SELECT * FROM payroll_runs WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!run) throw httpError(404, 'Not found');
    if (!run.remitted_tds) throw httpError(409, 'Record the TDS payment on the payroll run first; the challan details belong to that deposit.');
    await pool.query('UPDATE payroll_runs SET tds_bsr=$1, tds_challan_serial=$2, tds_interest=$3, tds_fee=$4 WHERE id=$5', [b.bsr, b.serial, b.interest, b.fee, run.id]);
    res.json({ ok: true });
  }));

  // ---------- Form 24Q ----------

  const quarterParam = (req) => {
    const q = Number(req.query.quarter);
    if (![1, 2, 3, 4].includes(q)) throw httpError(400, 'quarter must be 1, 2, 3 or 4');
    return q;
  };
  async function statementFor(req) {
    const fy = fyParam(req), quarter = quarterParam(req);
    const data = await loadFy(req.user.companyId, fy);
    return { fy, quarter, ...build24q({ company: await company(req.user.companyId), fy, quarter, ...data, asOf: asOf(req) }), recorded: data.statements.find((s) => s.quarter === quarter) ?? null };
  }

  r.get('/tds/24q', h(async (req, res) => res.json(await statementFor(req))));

  // Download: json (the whole statement), or one section as CSV.
  r.get('/tds/24q/export', h(async (req, res) => {
    const section = z.enum(['json', 'challans', 'deductees', 'annexure2']).parse(req.query.section ?? 'json');
    const { fy, quarter, statement } = await statementFor(req);
    const base = `24Q_${fy}_Q${quarter}`;
    if (section === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
      return res.type('application/json').send(JSON.stringify(statement, null, 2));
    }
    if (section === 'annexure2' && !statement.annexure2) throw httpError(400, 'Annexure II is part of the fourth quarter statement only.');
    res.setHeader('Content-Disposition', `attachment; filename="${base}_${section}.csv"`);
    res.type('text/csv').send(toCsv(statement[section], CSV_COLUMNS[section]));
  }));

  // Record that the statement was uploaded and got a token number. Completes the compliance calendar item.
  r.post('/tds/24q/filed', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ fy: z.string(), quarter: z.number().int().min(1).max(4), tokenNo: z.string().regex(TOKEN_RE, 'The token number is 15 digits'), filedOn: isoDate }).parse(req.body);
    if (parseFy(b.fy) === null) throw httpError(400, 'fy must look like 2026-27');
    const cid = req.user.companyId;
    if ((await pool.query('SELECT 1 FROM tds_statements WHERE company_id=$1 AND fy=$2 AND quarter=$3', [cid, b.fy, b.quarter])).rowCount)
      throw httpError(409, 'This quarter already has a recorded statement. Remove it first if it was entered by mistake.');
    await pool.query('INSERT INTO tds_statements (company_id, fy, quarter, token_no, filed_on, filed_by) VALUES ($1,$2,$3,$4,$5,$6)', [cid, b.fy, b.quarter, b.tokenNo, b.filedOn, req.user.id]);
    const key = `${parseFy(b.fy)}-Q${b.quarter}`;
    const cur = (await pool.query("SELECT id FROM compliance_records WHERE company_id=$1 AND rule_code='TDS_RET' AND period_key=$2", [cid, key])).rows[0];
    if (cur) await pool.query('UPDATE compliance_records SET completed_on=$1, reference=$2 WHERE id=$3', [b.filedOn, b.tokenNo, cur.id]);
    else await pool.query("INSERT INTO compliance_records (company_id, rule_code, period_key, completed_on, reference) VALUES ($1,'TDS_RET',$2,$3,$4)", [cid, key, b.filedOn, b.tokenNo]);
    res.status(201).json({ ok: true });
  }));

  r.get('/tds/statements', h(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM tds_statements WHERE company_id=$1 ORDER BY fy DESC, quarter DESC', [req.user.companyId]);
    res.json(rows.map((s) => ({ ...s, filed_on: ymd(s.filed_on) })));
  }));

  r.delete('/tds/statements/:id', h(async (req, res) => {
    needOwner(req);
    const x = (await pool.query('DELETE FROM tds_statements WHERE id=$1 AND company_id=$2 RETURNING fy, quarter', [req.params.id, req.user.companyId])).rows[0];
    if (!x) throw httpError(404, 'Not found');
    await pool.query("UPDATE compliance_records SET completed_on=NULL, reference=NULL WHERE company_id=$1 AND rule_code='TDS_RET' AND period_key=$2", [req.user.companyId, `${parseFy(x.fy)}-Q${x.quarter}`]);
    res.json({ ok: true });
  }));

  // ---------- Form 16 ----------

  const slipsOf = (slips, empId) => slips.filter((s) => s.employee_id === empId);

  r.get('/tds/form16', h(async (req, res) => {
    const fy = fyParam(req);
    const { slips, employees } = await loadFy(req.user.companyId, fy);
    const rows = [];
    for (const emp of employees) {
      const mine = slipsOf(slips, emp.id);
      if (!mine.length) continue;
      const a = annualSummary({ fy, employee: emp, slips: mine, asOf: asOf(req) });
      rows.push({
        incomplete: a.warnings.some((w) => /No finalized payroll for/.test(w)),
        employee_id: emp.id, code: emp.code, name: emp.name, pan: mine[mine.length - 1].pan ?? emp.pan ?? null, regime: a.regime, months: a.months,
        period_from: a.period_from, period_to: a.period_to, gross_salary: a.gross_salary, taxable_income: a.taxable_income, total_tax: a.net_tax_payable,
        tds_deducted: a.tds_deducted, shortfall: a.shortfall,
      });
    }
    res.json({ fy, ay: assessmentYear(fy), employees: rows.sort((a, b) => a.code.localeCompare(b.code)) });
  }));

  r.get('/tds/form16/:employeeId', h(async (req, res) => {
    const fy = fyParam(req);
    const cid = req.user.companyId;
    const { runs, slips, employees, statements } = await loadFy(cid, fy);
    const emp = employees.find((e) => e.id === Number(req.params.employeeId));
    if (!emp) throw httpError(404, 'Employee not found');
    const mine = slipsOf(slips, emp.id);
    if (!mine.length) throw httpError(404, `${emp.name} has no finalized payroll in ${fy}.`);

    const co = await company(cid);
    const b = annualSummary({ fy, employee: emp, slips: mine, asOf: asOf(req) });
    const warnings = [...b.warnings];
    const pan = mine[mine.length - 1].pan ?? emp.pan ?? null;
    if (!pan) warnings.push('The employee has no PAN: Form 16 needs it, and tax at a higher rate may apply.');
    if (!co.tan) warnings.push('The deductor TAN is not set.');
    const runBy = new Map(runs.map((x) => [x.month, x]));
    const monthly = mine.map((s) => {
      const run = runBy.get(s.month);
      return {
        month: s.month, gross: Number(s.gross), tds: Number(s.tds), deposited_on: Number(s.tds) > 0 ? run.remitted_tds : null,
        bsr: Number(s.tds) > 0 ? run.tds_bsr : null, challan_serial: Number(s.tds) > 0 ? run.tds_challan_serial : null,
      };
    });
    if (monthly.some((m) => m.tds > 0 && !m.deposited_on)) warnings.push('Some of this employee\'s tax is not recorded as deposited.');
    // Part A is TRACES's: show what our records say per quarter, and which statements are on record.
    const quarters = [1, 2, 3, 4].map((q) => {
      const ms = quarterMonths(fy, q);
      const inQ = monthly.filter((m) => ms.includes(m.month));
      const stmt = statements.find((s) => s.quarter === q);
      return { quarter: q, tds_deducted: inQ.reduce((s, m) => s + m.tds, 0), tds_deposited: inQ.filter((m) => m.deposited_on).reduce((s, m) => s + m.tds, 0), token_no: stmt?.token_no ?? null, filed_on: stmt?.filed_on ?? null };
    });
    res.json({
      fy, ay: b.ay,
      employee: { id: emp.id, code: emp.code, name: emp.name, pan, designation: emp.designation },
      deductor: {
        name: co.legal_name || co.name, tan: co.tan, pan: co.pan || (co.gstin ? co.gstin.slice(2, 12) : null),
        address: [co.addr1, co.addr2, co.loc, co.pin].filter(Boolean).join(', '), responsible_person: co.tds_person_name, responsible_designation: co.tds_person_designation,
      },
      part_b: { ...b, warnings: undefined }, monthly, part_a_summary: quarters,
      warnings: [...new Set([...warnings, 'Part A of Form 16 is issued from TRACES once the quarterly statements are processed: this summary is from your own records.'])],
    });
  }));

  return r;
}
