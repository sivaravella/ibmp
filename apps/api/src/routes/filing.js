import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { fyOf, parseFy } from '../compliance.js';
import { badRecipientGstins, buildGstr1Json, buildGstr3bJson } from '../gstjson.js';
import { gstinValid, panOfGstin } from '../gstin.js';
import { encrypt } from '../secrets.js';
import { GSTIN_RE } from '../gst.js';
import { getSession, requireSession } from '../gsp-session.js';

const TYPES = { GSTR1: { label: 'GSTR-1', rule: 'GSTR1_M' }, GSTR3B: { label: 'GSTR-3B', rule: 'GSTR3B_M' } };
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM');
const code = (err, c) => Object.assign(err, { code: c });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = (s) => (s ? JSON.parse(s) : null);
const lastDay = (period) => { const [y, m] = period.split('-').map(Number); return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const prevPeriod = (period) => { const [y, m] = period.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

export function filingRoutes(pool, { gsp, reports }) {
  const r = Router();

  const needGsp = () => { if (!gsp) throw code(httpError(503, 'No GSP is configured on this server, so returns cannot be sent to the GST portal.'), 'NO_GSP'); return gsp; };
  const needOwner = (req) => { if (req.user.role !== 'owner') throw code(httpError(403, 'Only the account owner can connect to the GST portal and file returns.'), 'OWNER_ONLY'); };
  const company = async (cid) => (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
  const log = (filingId, userId, action, detail) => pool.query('INSERT INTO gst_filing_events (filing_id, user_id, action, detail) VALUES ($1,$2,$3,$4)', [filingId, userId, action, detail ?? null]);

  // ---------- building and validating a return ----------

  /** Aggregate turnover (taxable value net of credit notes) for the previous FY and for the current FY up to the period. */
  async function turnover(cid, period) {
    const s0 = parseFy(fyOf(`${period}-01`));
    const sum = async (from, to) => {
      const inv = (await pool.query('SELECT COALESCE(SUM(taxable),0) AS t FROM invoices WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, to])).rows[0].t;
      const cn = (await pool.query("SELECT COALESCE(SUM(taxable),0) AS t FROM notes WHERE company_id=$1 AND kind='credit' AND date >= $2 AND date <= $3", [cid, from, to])).rows[0].t;
      return Number(inv) - Number(cn);
    };
    return { prior: await sum(`${s0 - 1}-04-01`, `${s0}-03-31`), current: await sum(`${s0}-04-01`, lastDay(period)) };
  }

  /** The payload plus everything the user needs to review: blocking errors, warnings, and headline figures. */
  async function build(cid, type, period) {
    const co = await company(cid);
    const errors = [], warnings = [];
    if (!co.gstin) errors.push('The company has no GSTIN. Add it before filing.');
    else if (!GSTIN_RE.test(co.gstin)) errors.push('The company GSTIN is not in a valid format.');
    else if (!gstinValid(co.gstin)) warnings.push('The company GSTIN fails the check-digit test: the GST portal will reject it.');
    if (lastDay(period) >= todayFn()) errors.push(`${period} has not ended yet: a return can only be filed after the month is over.`);
    const settings = (await pool.query('SELECT gst_frequency FROM compliance_settings WHERE company_id=$1', [cid])).rows[0];
    if (settings?.gst_frequency === 'quarterly') errors.push('Quarterly (QRMP) filing is not supported yet: only monthly filers can prepare returns here.');

    const gstin = co.gstin ?? '';
    let payload, summary, extra = [];
    if (type === 'GSTR1') {
      const g1 = await reports.gstr1(cid, period);
      const built = buildGstr1Json(g1, { gstin, period, turnover: await turnover(cid, period) });
      payload = built.payload; extra = [...g1.warnings.filter((w) => !/^Company has no GSTIN/.test(w)), ...built.warnings];
      const bad = badRecipientGstins(g1);
      if (bad.length) warnings.push(`Recipient GSTIN(s) fail the check-digit test and will be rejected: ${bad.join(', ')}.`);
      const irp = Number((await pool.query("SELECT COUNT(*) AS n FROM einvoices e JOIN invoices i ON i.id=e.doc_id WHERE e.company_id=$1 AND e.doc_type='INV' AND e.status='generated' AND i.date >= $2 AND i.date <= $3", [cid, `${period}-01`, lastDay(period)])).rows[0].n);
      if (irp) warnings.push(`${irp} invoice(s) were reported to the IRP and reach GSTR-1 automatically. Ask your GSP whether they should be left out of this upload to avoid duplicates.`);
      if (!g1.docs.invoices.count && !g1.docs.credit_notes.count) warnings.push('There are no invoices or credit notes in this month: this will be filed as a nil return.');
      summary = { taxable: g1.totals.taxable, igst: g1.totals.igst, cgst: g1.totals.cgst, sgst: g1.totals.sgst, invoices: g1.docs.invoices.count, credit_notes: g1.docs.credit_notes.count };
    } else {
      const g3 = await reports.gstr3b(cid, period);
      const built = buildGstr3bJson(g3, { gstin, period });
      payload = built.payload; extra = [...g3.warnings.filter((w) => !/^Company has no GSTIN/.test(w)), ...built.warnings];
      if (!g3.reconciliation.ok) warnings.push('The ledger and the documents disagree on GST for this month. Resolve the difference before filing.');
      const f1 = (await pool.query("SELECT status FROM gst_filings WHERE company_id=$1 AND return_type='GSTR1' AND period=$2", [cid, period])).rows[0];
      if (f1?.status !== 'filed') warnings.push('GSTR-1 for this month has not been filed through IBMP yet. File it first so the figures agree.');
      summary = { taxable: g3.outward.taxable.taxable, igst: g3.outward.taxable.igst, cgst: g3.outward.taxable.cgst, sgst: g3.outward.taxable.sgst, itc_net: g3.itc.net, cash_payable: g3.liability.cash_total };
    }
    const prev = prevPeriod(period);
    const prevFiled = (await pool.query("SELECT 1 FROM gst_filings WHERE company_id=$1 AND return_type=$2 AND period=$3 AND status='filed'", [cid, type, prev])).rowCount;
    if (!prevFiled) warnings.push(`${TYPES[type].label} for ${prev} was not filed through IBMP (ignore this if it was filed elsewhere).`);
    const text = JSON.stringify(payload);
    return { payload, text, hash: sha256(text), errors, warnings: [...new Set([...warnings, ...extra])], summary };
  }

  const view = (f) => ({
    id: f.id, return_type: f.return_type, label: TYPES[f.return_type].label, period: f.period, status: f.status, payload_hash: f.payload_hash,
    summary: parse(f.summary), validation: parse(f.validation), gsp_reference: f.gsp_reference, gsp_errors: parse(f.gsp_errors) ?? [],
    payment_ref: f.payment_ref, arn: f.arn, filed_on: f.filed_on ? ymd(f.filed_on) : null, updated_at: f.updated_at,
  });
  const load = async (req) => {
    const f = (await pool.query('SELECT * FROM gst_filings WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!f) throw httpError(404, 'Not found');
    return f;
  };
  const set = async (id, fields) => {
    const keys = Object.keys(fields);
    return (await pool.query(`UPDATE gst_filings SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => fields[k]), id])).rows[0];
  };

  /** The saved snapshot, plus whether the books have changed since it was prepared. */
  const staleness = async (f) => (['submitted', 'filed'].includes(f.status) ? false : (await build(f.company_id, f.return_type, f.period)).hash !== f.payload_hash);
  const notStale = async (f) => { if (await staleness(f)) throw code(httpError(409, 'Your books have changed since this return was prepared. Prepare it again and review the new figures.'), 'STALE'); };

  // ---------- GST portal session ----------

  const session = (cid) => getSession(pool, cid);
  const needSession = (cid, gstin) => requireSession(pool, cid, gstin);

  r.get('/filing/gsp/session', h(async (req, res) => {
    const s = await session(req.user.companyId);
    res.json({ gsp: gsp ? { name: gsp.name, mode: gsp.mode } : null, connected: !!s, username: s?.username ?? null, expires_at: s?.expires_at ?? null });
  }));

  r.post('/filing/gsp/otp', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ username: z.string().min(2).max(50) }).parse(req.body);
    const co = await company(req.user.companyId);
    if (!co.gstin) throw httpError(400, 'Add the company GSTIN before connecting to the GST portal.');
    const out = await needGsp().sendOtp({ gstin: co.gstin, username: b.username });
    await pool.query('DELETE FROM gsp_sessions WHERE company_id=$1', [co.id]);
    await pool.query('INSERT INTO gsp_sessions (company_id, username, request_id) VALUES ($1,$2,$3)', [co.id, b.username, out.requestId ?? null]);
    res.json({ sent: true, hint: out.hint ?? null });
  }));

  r.post('/filing/gsp/session', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ otp: z.string().min(4).max(8) }).parse(req.body);
    const co = await company(req.user.companyId);
    const pending = (await pool.query('SELECT * FROM gsp_sessions WHERE company_id=$1', [co.id])).rows[0];
    if (!pending) throw httpError(409, 'Request an OTP first.');
    const out = await needGsp().verifyOtp({ gstin: co.gstin, username: pending.username, otp: b.otp, requestId: pending.request_id });
    await pool.query('UPDATE gsp_sessions SET token_enc=$1, expires_at=$2 WHERE company_id=$3', [encrypt(out.token), out.expiresAt, co.id]);
    res.json({ connected: true, username: pending.username, expires_at: out.expiresAt });
  }));

  r.delete('/filing/gsp/session', h(async (req, res) => {
    needOwner(req);
    await pool.query('DELETE FROM gsp_sessions WHERE company_id=$1', [req.user.companyId]);
    res.json({ connected: false });
  }));

  // ---------- GSTIN lookup ----------

  r.get('/filing/gstin/:gstin', h(async (req, res) => {
    const g = String(req.params.gstin).toUpperCase();
    if (!GSTIN_RE.test(g)) throw httpError(400, 'That is not a valid GSTIN format (15 characters).');
    if (!gstinValid(g)) throw httpError(400, 'The GSTIN check character is wrong: check it for a typing mistake.');
    res.json(await needGsp().searchGstin({ gstin: g }));
  }));

  // ---------- returns ----------

  r.get('/filing/status', h(async (req, res) => {
    const period = periodSchema.parse(req.query.period);
    const co = await company(req.user.companyId);
    const s = await session(co.id);
    const rows = (await pool.query('SELECT * FROM gst_filings WHERE company_id=$1 AND period=$2', [co.id, period])).rows;
    res.json({
      period, gsp: gsp ? { name: gsp.name, mode: gsp.mode } : null, session: { connected: !!s, username: s?.username ?? null, expires_at: s?.expires_at ?? null },
      company: { gstin: co.gstin, gstin_checksum_ok: co.gstin ? gstinValid(co.gstin) : false },
      filings: { GSTR1: rows.filter((x) => x.return_type === 'GSTR1').map(view)[0] ?? null, GSTR3B: rows.filter((x) => x.return_type === 'GSTR3B').map(view)[0] ?? null },
    });
  }));

  // The return as JSON for the GST portal's offline utility, without starting a filing.
  r.get('/filing/export/:type', h(async (req, res) => {
    const type = z.enum(['GSTR1', 'GSTR3B']).parse(req.params.type);
    const period = periodSchema.parse(req.query.period);
    const b = await build(req.user.companyId, type, period);
    if (req.query.file === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${type}_${period.replace('-', '')}.json"`);
      return res.type('application/json').send(JSON.stringify(b.payload, null, 2));
    }
    res.json({ payload: b.payload, hash: b.hash, errors: b.errors, warnings: b.warnings, summary: b.summary });
  }));

  r.post('/filing/returns', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ type: z.enum(['GSTR1', 'GSTR3B']), period: periodSchema }).parse(req.body);
    const cid = req.user.companyId;
    const existing = (await pool.query('SELECT * FROM gst_filings WHERE company_id=$1 AND return_type=$2 AND period=$3', [cid, b.type, b.period])).rows[0];
    if (existing && ['submitted', 'filed'].includes(existing.status)) throw httpError(409, `${TYPES[b.type].label} for ${b.period} is already ${existing.status}.`);
    const built = await build(cid, b.type, b.period);
    const fields = { payload: built.text, payload_hash: built.hash, validation: json({ errors: built.errors, warnings: built.warnings }), summary: json(built.summary),
      status: 'draft', gsp_reference: null, gsp_errors: null, prepared_by: req.user.id };
    let f;
    if (existing) f = await set(existing.id, fields);
    else {
      const keys = Object.keys(fields);
      f = (await pool.query(`INSERT INTO gst_filings (company_id, return_type, period, ${keys.join(', ')}) VALUES ($1,$2,$3,${keys.map((_, i) => `$${i + 4}`).join(',')}) RETURNING *`, [cid, b.type, b.period, ...keys.map((k) => fields[k])])).rows[0];
    }
    await log(f.id, req.user.id, 'prepared', `hash ${built.hash.slice(0, 12)}, ${built.errors.length} error(s), ${built.warnings.length} warning(s)`);
    res.status(existing ? 200 : 201).json(view(f));
  }));

  r.get('/filing/returns/:id', h(async (req, res) => {
    const f = await load(req);
    const events = (await pool.query('SELECT e.action, e.detail, e.created_at, u.name AS by FROM gst_filing_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.filing_id=$1 ORDER BY e.id', [f.id])).rows;
    res.json({ ...view(f), stale: await staleness(f), payload: parse(f.payload), events });
  }));

  r.get('/filing/returns/:id/json', h(async (req, res) => {
    const f = await load(req);
    res.setHeader('Content-Disposition', `attachment; filename="${f.return_type}_${f.period.replace('-', '')}.json"`);
    res.type('application/json').send(JSON.stringify(parse(f.payload), null, 2));
  }));

  const needStatus = (f, ok, verb) => { if (!ok.includes(f.status)) throw httpError(409, `A return that is ${f.status} cannot be ${verb}.`); };

  // Upload to the GSP/GSTN. The GSP validates it and reports errors, which are stored for the user to read.
  r.post('/filing/returns/:id/save', h(async (req, res) => {
    needOwner(req);
    const f = await load(req);
    needStatus(f, ['draft', 'saved', 'error'], 'saved');
    const v = parse(f.validation);
    if (v.errors.length) throw code(httpError(409, `Fix these first: ${v.errors.join(' ')}`), 'VALIDATION');
    await notStale(f);
    const co = await company(f.company_id);
    const s = await needSession(f.company_id, co.gstin);
    const g = needGsp();
    const { referenceId } = await g.saveReturn({ type: f.return_type, gstin: co.gstin, period: f.period, payload: parse(f.payload), session: s });
    const st = await g.returnStatus({ type: f.return_type, gstin: co.gstin, period: f.period, referenceId, session: s });
    const status = st.status === 'ER' ? 'error' : 'saved';
    const up = await set(f.id, { status, gsp_reference: referenceId, gsp_errors: json(st.errors ?? []) });
    await log(f.id, req.user.id, status === 'error' ? 'save_rejected' : 'saved', status === 'error' ? `${st.errors.length} error(s) from the GSP` : `reference ${referenceId}, status ${st.status}`);
    res.json(view(up));
  }));

  r.post('/filing/returns/:id/refresh', h(async (req, res) => {
    needOwner(req);
    const f = await load(req);
    needStatus(f, ['saved', 'error'], 'refreshed');
    const co = await company(f.company_id);
    const st = await needGsp().returnStatus({ type: f.return_type, gstin: co.gstin, period: f.period, referenceId: f.gsp_reference, session: await needSession(f.company_id, co.gstin) });
    const up = await set(f.id, { status: st.status === 'ER' ? 'error' : 'saved', gsp_errors: json(st.errors ?? []) });
    await log(f.id, req.user.id, 'refreshed', `GSP status ${st.status}`);
    res.json(view(up));
  }));

  // Submit freezes the return at the GSTN. From here the month is locked in IBMP too.
  r.post('/filing/returns/:id/submit', h(async (req, res) => {
    needOwner(req);
    const f = await load(req);
    needStatus(f, ['saved'], 'submitted');
    await notStale(f);
    const co = await company(f.company_id);
    await needGsp().submitReturn({ type: f.return_type, gstin: co.gstin, period: f.period, session: await needSession(f.company_id, co.gstin) });
    const up = await set(f.id, { status: 'submitted' });
    await log(f.id, req.user.id, 'submitted', 'Return frozen; the month is now locked for new documents');
    res.json(view(up));
  }));

  // File: irreversible. The caller must echo the payload hash they reviewed and tick the confirmation.
  r.post('/filing/returns/:id/file', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ otp: z.string().min(4).max(8), payloadHash: z.string(), confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm that you have reviewed the return' }) }), paymentRef: z.string().max(40).optional() }).parse(req.body);
    const f = await load(req);
    needStatus(f, ['submitted'], 'filed');
    if (b.payloadHash !== f.payload_hash) throw code(httpError(409, 'The return you reviewed is not the one on file. Reload and review it again.'), 'HASH_MISMATCH');
    const co = await company(f.company_id);
    const cash = parse(f.summary).cash_payable ?? 0;
    try {
      const out = await needGsp().fileReturn({
        type: f.return_type, gstin: co.gstin, period: f.period, pan: panOfGstin(co.gstin), evcOtp: b.otp,
        session: await needSession(f.company_id, co.gstin), paymentRef: b.paymentRef, liability: cash,
      });
      const up = await set(f.id, { status: 'filed', arn: out.arn, filed_on: out.filedOn ?? todayFn(), payment_ref: b.paymentRef ?? null, gsp_errors: json([]) });
      await log(f.id, req.user.id, 'filed', `ARN ${out.arn}`);
      await completeCompliance(f.company_id, f.return_type, f.period, out.arn, up.filed_on);
      res.json(view(up));
    } catch (e) {
      await set(f.id, { gsp_errors: json([{ code: e.code ?? 'ERROR', message: e.message }]) });
      await log(f.id, req.user.id, 'file_failed', e.message);
      throw e;
    }
  }));

  /** A filed return completes the matching compliance-calendar item, with the ARN as its reference. */
  async function completeCompliance(cid, type, period, arn, on) {
    const rule = TYPES[type].rule, date = ymd(on);
    const cur = (await pool.query('SELECT id FROM compliance_records WHERE company_id=$1 AND rule_code=$2 AND period_key=$3', [cid, rule, period])).rows[0];
    if (cur) await pool.query('UPDATE compliance_records SET completed_on=$1, reference=$2 WHERE id=$3', [date, arn, cur.id]);
    else await pool.query('INSERT INTO compliance_records (company_id, rule_code, period_key, completed_on, reference) VALUES ($1,$2,$3,$4,$5)', [cid, rule, period, date, arn]);
  }

  return r;
}
