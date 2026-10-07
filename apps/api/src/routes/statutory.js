import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { buildEcr, buildEsi, ecrCsv, esiCsv, periodLabel, TRRN_RE } from '../statutory.js';
import { parseFy } from '../compliance.js';
import { fyOf } from '../compliance.js';
import { today as todayFn } from '../util.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
const dueDate = (month) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`; };
const fixRun = (r) => ({ ...r, remitted_pf: r.remitted_pf ? ymd(r.remitted_pf) : null, remitted_esi: r.remitted_esi ? ymd(r.remitted_esi) : null });

export function statutoryRoutes(pool) {
  const r = Router();
  const needOwner = (req) => { if (req.user.role !== 'owner') throw Object.assign(httpError(403, 'Only the account owner can change these records.'), { code: 'OWNER_ONLY' }); };

  /** The finalized (or paid) run for a month with its payslips and the employee master. */
  async function load(cid, rawMonth) {
    const month = monthSchema.parse(rawMonth);
    const run = (await pool.query("SELECT * FROM payroll_runs WHERE company_id=$1 AND month=$2 AND status IN ('finalized','paid')", [cid, month])).rows[0];
    if (!run) {
      const draft = (await pool.query('SELECT status FROM payroll_runs WHERE company_id=$1 AND month=$2', [cid, month])).rows[0];
      return { month, run: null, slips: [], employees: [], draft: draft?.status === 'draft' };
    }
    const slips = (await pool.query('SELECT * FROM payslips WHERE run_id=$1 ORDER BY emp_code', [run.id])).rows;
    const employees = (await pool.query('SELECT * FROM employees WHERE company_id=$1', [cid])).rows
      .map((e) => ({ ...e, exit_date: e.exit_date ? ymd(e.exit_date) : null }));
    return { month, run: fixRun(run), slips, employees, draft: false };
  }
  const missingRun = (d) => (d.draft ? `Payroll for ${d.month} is still a draft: finalize it first.` : `There is no finalized payroll for ${d.month}.`);

  const runInfo = (run, head) => run && {
    id: run.id, status: run.status, due_date: dueDate(run.month),
    remitted_on: run[`remitted_${head}`], reference: head === 'pf' ? run.pf_trrn : run.esi_challan, late: !!run[`remitted_${head}`] && run[`remitted_${head}`] > dueDate(run.month),
  };

  // One line per payroll month of a year: what is due and what has been recorded.
  r.get('/statutory/overview', h(async (req, res) => {
    const fy = req.query.fy ?? fyOf(todayFn());
    const s0 = parseFy(fy);
    if (s0 === null) throw httpError(400, 'fy must look like 2026-27');
    const { rows } = await pool.query("SELECT * FROM payroll_runs WHERE company_id=$1 AND month >= $2 AND month <= $3 AND status IN ('finalized','paid') ORDER BY month", [req.user.companyId, `${s0}-04`, `${s0 + 1}-03`]);
    res.json({
      fy,
      months: rows.map(fixRun).map((x) => ({
        month: x.month, run_id: x.id, status: x.status, due_date: dueDate(x.month),
        pf: { amount: Number(x.pf_employee) + Number(x.pf_employer) + Number(x.edli) + Number(x.pf_admin), remitted_on: x.remitted_pf, trrn: x.pf_trrn, late: !!x.remitted_pf && x.remitted_pf > dueDate(x.month) },
        esi: { amount: Number(x.esi_employee) + Number(x.esi_employer), remitted_on: x.remitted_esi, challan: x.esi_challan, late: !!x.remitted_esi && x.remitted_esi > dueDate(x.month) },
      })),
    });
  }));

  r.get('/statutory/pf', h(async (req, res) => {
    const d = await load(req.user.companyId, req.query.month);
    const e = d.run ? buildEcr(d) : { rows: [], errors: [missingRun(d)], warnings: [], challan: null, totals: null };
    res.json({ month: d.month, file_name: `ECR_${periodLabel(d.month)}.txt`, run: runInfo(d.run, 'pf'), rows: e.rows, challan: e.challan, totals: e.totals, errors: e.errors, warnings: e.warnings });
  }));

  r.get('/statutory/pf/export', h(async (req, res) => {
    const format = z.enum(['ecr', 'csv']).parse(req.query.format ?? 'ecr');
    const d = await load(req.user.companyId, req.query.month);
    if (!d.run) throw httpError(409, missingRun(d));
    const e = buildEcr(d);
    if (!e.rows.length) throw httpError(409, 'No employee has PF wages in this month, so there is no file to make.');
    if (e.errors.length) throw Object.assign(httpError(409, `Fix these first: ${e.errors.join(' ')}`), { code: 'VALIDATION' });
    if (format === 'ecr') {
      res.setHeader('Content-Disposition', `attachment; filename="ECR_${periodLabel(d.month)}.txt"`);
      return res.type('text/plain').send(e.text);
    }
    res.setHeader('Content-Disposition', `attachment; filename="ECR_${periodLabel(d.month)}.csv"`);
    res.type('text/csv').send(ecrCsv(e.rows));
  }));

  r.get('/statutory/esi', h(async (req, res) => {
    const d = await load(req.user.companyId, req.query.month);
    const e = d.run ? buildEsi(d) : { rows: [], errors: [missingRun(d)], warnings: [], summary: null };
    res.json({ month: d.month, file_name: `ESI_${periodLabel(d.month)}.csv`, run: runInfo(d.run, 'esi'), rows: e.rows, summary: e.summary, errors: e.errors, warnings: e.warnings });
  }));

  r.get('/statutory/esi/export', h(async (req, res) => {
    const d = await load(req.user.companyId, req.query.month);
    if (!d.run) throw httpError(409, missingRun(d));
    const e = buildEsi(d);
    if (!e.rows.length) throw httpError(409, 'No employee is covered by ESI in this month, so there is no file to make.');
    if (e.errors.length) throw Object.assign(httpError(409, `Fix these first: ${e.errors.join(' ')}`), { code: 'VALIDATION' });
    res.setHeader('Content-Disposition', `attachment; filename="ESI_${periodLabel(d.month)}.csv"`);
    res.type('text/csv').send(esiCsv(e.rows));
  }));

  // The numbers the portals return once the file is uploaded and the challan paid. A paid head completes its calendar item.
  r.put('/statutory/runs/:id/refs', h(async (req, res) => {
    needOwner(req);
    const b = z.object({
      pfTrrn: z.string().regex(TRRN_RE, 'The TRRN is 13 digits').nullable(),
      esiChallan: z.string().trim().min(3).max(30).nullable(),
    }).partial().parse(req.body);
    if (!Object.keys(b).length) throw httpError(400, 'Nothing to update');
    const run = (await pool.query('SELECT * FROM payroll_runs WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!run) throw httpError(404, 'Not found');
    const fields = { ...(b.pfTrrn !== undefined && { pf_trrn: b.pfTrrn }), ...(b.esiChallan !== undefined && { esi_challan: b.esiChallan }) };
    const keys = Object.keys(fields);
    await pool.query(`UPDATE payroll_runs SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => fields[k]), run.id]);

    const done = [['pf_trrn', 'remitted_pf', 'PF'], ['esi_challan', 'remitted_esi', 'ESI']];
    for (const [refCol, paidCol, rule] of done) {
      const ref = fields[refCol];
      if (ref && run[paidCol]) {
        const cur = (await pool.query('SELECT id FROM compliance_records WHERE company_id=$1 AND rule_code=$2 AND period_key=$3', [run.company_id, rule, run.month])).rows[0];
        if (cur) await pool.query('UPDATE compliance_records SET completed_on=$1, reference=$2 WHERE id=$3', [ymd(run[paidCol]), ref, cur.id]);
        else await pool.query('INSERT INTO compliance_records (company_id, rule_code, period_key, completed_on, reference) VALUES ($1,$2,$3,$4,$5)', [run.company_id, rule, run.month, ymd(run[paidCol]), ref]);
      }
    }
    res.json({ ok: true });
  }));

  return r;
}
