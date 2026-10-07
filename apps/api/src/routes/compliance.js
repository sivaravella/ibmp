import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { CATEGORIES, DEFAULT_SETTINGS, fyOf, generateItems, parseFy, prevFy, withStatus } from '../compliance.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const settingsSchema = z.object({
  gstFrequency: z.enum(['monthly', 'quarterly']),
  tdsDeductor: z.boolean(), tdsNonsalary: z.boolean(), pf: z.boolean(), esi: z.boolean(), advanceTax: z.boolean(), taxAudit: z.boolean(),
  trackFrom: isoDate.nullable(),
}).partial();
const COLUMN = { gstFrequency: 'gst_frequency', tdsDeductor: 'tds_deductor', tdsNonsalary: 'tds_nonsalary', advanceTax: 'advance_tax', taxAudit: 'tax_audit', trackFrom: 'track_from' };

const keyOf = (r) => `${r.rule_code}|${r.period_key}`;

export function complianceRoutes(pool) {
  const r = Router();

  async function getSettings(cid) {
    const row = (await pool.query('SELECT * FROM compliance_settings WHERE company_id=$1', [cid])).rows[0];
    return row ? { ...DEFAULT_SETTINGS, ...row, company_id: undefined, track_from: row.track_from ? ymd(row.track_from) : null } : { ...DEFAULT_SETTINGS, track_from: null };
  }
  const getCompany = async (cid) => (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
  const fixRec = (x) => ({ ...x, completed_on: x.completed_on ? ymd(x.completed_on) : null, due_override: x.due_override ? ymd(x.due_override) : null, due_date: x.due_date ? ymd(x.due_date) : null });
  async function getRecords(cid) {
    return (await pool.query('SELECT * FROM compliance_records WHERE company_id=$1', [cid])).rows.map(fixRec);
  }
  const asOf = (req) => {
    const v = req.query.asOf;
    if (v === undefined) return todayFn();
    if (!isoDate.safeParse(v).success) throw httpError(400, 'asOf must be YYYY-MM-DD');
    return v;
  };
  const fyParam = (req, today) => {
    const fy = req.query.fy ?? fyOf(today);
    if (parseFy(fy) === null) throw httpError(400, 'fy must look like 2026-27');
    return fy;
  };

  // Generated items for a FY plus the user's custom items falling in it, each merged with its record and status.
  async function build(cid, fy, today) {
    const [company, settings, recs] = await Promise.all([getCompany(cid), getSettings(cid), getRecords(cid)]);
    const byKey = new Map(recs.map((x) => [keyOf(x), x]));
    const s0 = parseFy(fy);
    const trackFrom = settings.track_from ?? ymd(company.created_at);
    const known = (it) => it.due >= trackFrom || byKey.has(keyOf(it));   // older periods only show if the user already acted on them
    const items = generateItems(company, settings, fy).filter(known).map((it) => withStatus(it, byKey.get(keyOf({ rule_code: it.rule_code, period_key: it.period_key })), today));
    for (const c of recs.filter((x) => x.rule_code === 'CUSTOM')) {
      if (c.due_date >= `${s0}-04-01` && c.due_date <= `${s0 + 1}-03-31`)
        items.push(withStatus({ rule_code: 'CUSTOM', period_key: c.period_key, name: c.name, category: c.category || 'Custom', period_label: '', due: c.due_date }, c, today));
    }
    return { company, settings, items: items.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name)) };
  }

  r.get('/compliance/settings', h(async (req, res) => {
    const company = await getCompany(req.user.companyId);
    const s = await getSettings(req.user.companyId);
    res.json({ ...s, tracking_from: s.track_from ?? ymd(company.created_at), gst_registered: !!company.gstin });
  }));

  r.put('/compliance/settings', h(async (req, res) => {
    const b = Object.fromEntries(Object.entries(settingsSchema.parse(req.body)).map(([k, v]) => [COLUMN[k] ?? k, v]));
    const cid = req.user.companyId;
    const s = { ...(await getSettings(cid)), ...b };
    const exists = (await pool.query('SELECT 1 FROM compliance_settings WHERE company_id=$1', [cid])).rowCount;
    const vals = [s.gst_frequency, s.tds_deductor, s.pf, s.esi, s.advance_tax, s.tax_audit, s.track_from, s.tds_nonsalary, cid];
    if (exists) await pool.query('UPDATE compliance_settings SET gst_frequency=$1, tds_deductor=$2, pf=$3, esi=$4, advance_tax=$5, tax_audit=$6, track_from=$7, tds_nonsalary=$8 WHERE company_id=$9', vals);
    else await pool.query('INSERT INTO compliance_settings (gst_frequency,tds_deductor,pf,esi,advance_tax,tax_audit,track_from,tds_nonsalary,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', vals);
    res.json(s);
  }));

  r.get('/compliance', h(async (req, res) => {
    const today = asOf(req);
    const fy = fyParam(req, today);
    const { settings, items, company } = await build(req.user.companyId, fy, today);
    const count = (s) => items.filter((i) => i.status === s).length;
    res.json({
      fy, as_of: today, settings, gst_registered: !!company.gstin,
      summary: { overdue: count('overdue'), due_soon: count('due_soon'), upcoming: count('upcoming'), completed: count('completed'), total: items.length },
      items,
    });
  }));

  // Lightweight roll-up for the dashboard: open items across the previous and current FY (March returns fall due in the next FY).
  async function summaryFor(cid, today) {
    const cur = fyOf(today);
    const all = [...(await build(cid, prevFy(cur), today)).items, ...(await build(cid, cur, today)).items];
    const open = all.filter((i) => i.status !== 'completed').sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
    return {
      overdue: open.filter((i) => i.status === 'overdue').length,
      due_soon: open.filter((i) => i.status === 'due_soon').length,
      next: open.filter((i) => i.status !== 'overdue').slice(0, 3).map((i) => ({ name: i.name, due: i.due, days_to_due: i.days_to_due, status: i.status })),
      most_overdue: open.filter((i) => i.status === 'overdue').slice(0, 3).map((i) => ({ name: i.name, due: i.due, days_to_due: i.days_to_due })),
    };
  }
  // Open items across the previous and current FY with their status, for the reminder job.
  r.openItems = async (cid, today) => {
    const cur = fyOf(today);
    return [...(await build(cid, prevFy(cur), today)).items, ...(await build(cid, cur, today)).items].filter((i) => i.status !== 'completed');
  };
  r.summaryFor = summaryFor;     // also used by the consultant practice overview

  r.get('/compliance/summary', h(async (req, res) => res.json(await summaryFor(req.user.companyId, asOf(req)))));

  // Mark filed / undo, extend or restore a due date, add notes. Absent field = unchanged, null = clear.
  r.put('/compliance/records', h(async (req, res) => {
    const b = z.object({
      fy: z.string().optional(), ruleCode: z.string(), periodKey: z.string(),
      completedOn: isoDate.nullable().optional(), reference: z.string().max(100).nullable().optional(),
      dueOverride: isoDate.nullable().optional(), overrideNote: z.string().max(200).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    const cid = req.user.companyId;

    const existing = (await pool.query('SELECT * FROM compliance_records WHERE company_id=$1 AND rule_code=$2 AND period_key=$3',
      [cid, b.ruleCode, b.periodKey])).rows[0];
    if (b.ruleCode === 'CUSTOM') {
      if (!existing) throw httpError(404, 'Not found');
    } else {
      const fy = b.fy ?? fyOf(todayFn());
      if (parseFy(fy) === null) throw httpError(400, 'fy must look like 2026-27');
      const settings = await getSettings(cid);
      const ok = generateItems(await getCompany(cid), settings, fy).some((i) => i.rule_code === b.ruleCode && i.period_key === b.periodKey);
      if (!ok) throw httpError(404, 'No such compliance item for this company and financial year');
    }

    const pick = (k, col) => (b[k] !== undefined ? b[k] : existing?.[col] ?? null);
    const v = [pick('completedOn', 'completed_on'), pick('reference', 'reference'), pick('dueOverride', 'due_override'), pick('overrideNote', 'override_note'), pick('notes', 'notes')];
    if (v[2] === null) v[3] = b.overrideNote !== undefined ? b.overrideNote : null; // clearing an override clears its note
    if (existing) await pool.query('UPDATE compliance_records SET completed_on=$1, reference=$2, due_override=$3, override_note=$4, notes=$5 WHERE id=$6', [...v, existing.id]);
    else await pool.query('INSERT INTO compliance_records (completed_on,reference,due_override,override_note,notes,company_id,rule_code,period_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [...v, cid, b.ruleCode, b.periodKey]);
    res.json({ ok: true });
  }));

  r.post('/compliance/custom', h(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(120), category: z.enum(CATEGORIES).default('Custom'), dueDate: isoDate, notes: z.string().max(500).optional() }).parse(req.body);
    const key = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await pool.query('INSERT INTO compliance_records (company_id,rule_code,period_key,name,category,due_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.companyId, 'CUSTOM', key, b.name, b.category, b.dueDate, b.notes ?? null]);
    res.status(201).json({ periodKey: key });
  }));

  r.delete('/compliance/custom/:key', h(async (req, res) => {
    const x = await pool.query("DELETE FROM compliance_records WHERE company_id=$1 AND rule_code='CUSTOM' AND period_key=$2", [req.user.companyId, req.params.key]);
    if (!x.rowCount) throw httpError(404, 'Not found');
    res.json({ ok: true });
  }));

  return r;
}
