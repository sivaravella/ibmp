import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { buildEinvoice, buildEwb } from '../einvoice.js';
import { requireSession } from '../gsp-session.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const parse = (s) => (s ? JSON.parse(s) : null);
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const code = (err, c) => Object.assign(err, { code: c });
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function edocRoutes(pool, { gsp }) {
  const r = Router();

  const needGsp = () => { if (!gsp) throw code(httpError(503, 'No GSP is configured on this server, so documents cannot be sent to the IRP or the e-way bill portal.'), 'NO_GSP'); return gsp; };
  const needOwner = (req) => { if (req.user.role !== 'owner') throw code(httpError(403, 'Only the account owner can generate or cancel e-documents.'), 'OWNER_ONLY'); };
  const company = async (cid) => (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
  const event = (kind, docId, userId, action, detail) => pool.query('INSERT INTO edoc_events (kind, doc_id, user_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [kind, docId, userId, action, detail ?? null]);
  const unitsOf = async (cid) => new Map((await pool.query('SELECT id, unit FROM items WHERE company_id=$1', [cid])).rows.map((i) => [i.id, i.unit]));
  const fixDoc = (x) => ({ ...x, date: ymd(x.date) });

  async function set(table, id, fields) {
    const keys = Object.keys(fields);
    return (await pool.query(`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => fields[k]), id])).rows[0];
  }

  // ---------- e-invoice ----------

  /** The document, its party and lines, ready for the payload builder. */
  async function loadDoc(cid, type, docId) {
    if (type === 'INV') {
      const doc = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND company_id=$2', [docId, cid])).rows[0];
      if (!doc) throw httpError(404, 'Invoice not found');
      const party = (await pool.query('SELECT * FROM parties WHERE id=$1', [doc.party_id])).rows[0];
      const lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [doc.id])).rows;
      return { doc: fixDoc(doc), party, lines, against: null };
    }
    const note = (await pool.query("SELECT * FROM notes WHERE id=$1 AND company_id=$2 AND kind='credit'", [docId, cid])).rows[0];
    if (!note) throw httpError(404, 'Credit note not found');
    const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1', [note.invoice_id])).rows[0];
    const party = (await pool.query('SELECT * FROM parties WHERE id=$1', [note.party_id])).rows[0];
    const lines = (await pool.query('SELECT * FROM note_lines WHERE note_id=$1 ORDER BY id', [note.id])).rows;
    return { doc: { ...fixDoc(note), doc_pos: inv.place_of_supply }, party, lines, against: { number: inv.number, date: ymd(inv.date) } };
  }

  async function buildFor(cid, type, docId) {
    const { doc, party, lines, against } = await loadDoc(cid, type, docId);
    const out = buildEinvoice({ type, company: await company(cid), party, doc, lines, against, units: await unitsOf(cid), today: todayFn() });
    return { ...out, doc, text: JSON.stringify(out.payload) };
  }

  const einvView = (e) => ({
    id: e.id, doc_type: e.doc_type, doc_id: e.doc_id, doc_number: e.doc_number, status: e.status, irn: e.irn, ack_no: e.ack_no, ack_date: iso(e.ack_date),
    validation: parse(e.validation), gsp_errors: parse(e.gsp_errors) ?? [], cancel_reason: e.cancel_reason, cancelled_on: iso(e.cancelled_on), signed_qr: e.signed_qr,
    simulated: !!e.signed_qr?.startsWith('SIMULATED.'),
  });
  const loadEinv = async (req) => {
    const e = (await pool.query('SELECT * FROM einvoices WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!e) throw httpError(404, 'Not found');
    return e;
  };

  // Everything that could need an IRN, with where it stands.
  r.get('/einvoice/documents', h(async (req, res) => {
    const cid = req.user.companyId;
    const co = await company(cid);
    const days = Math.min(Number(req.query.days) || 90, 400);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const einv = new Map((await pool.query('SELECT * FROM einvoices WHERE company_id=$1', [cid])).rows.map((e) => [`${e.doc_type}|${e.doc_id}`, e]));
    const ewb = new Map();
    for (const w of (await pool.query("SELECT * FROM ewaybills WHERE company_id=$1 AND status IN ('draft','generated','failed') ORDER BY id", [cid])).rows) ewb.set(w.invoice_id, w);
    const required = (date, gstin) => co.einvoice_enabled && co.einvoice_from && date >= ymd(co.einvoice_from) && !!gstin;

    const invs = (await pool.query(
      `SELECT i.id, i.number, i.date, i.total, i.place_of_supply, p.name AS party_name, p.gstin AS party_gstin
       FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.company_id=$1 AND i.date >= $2 ORDER BY i.date DESC, i.id DESC`, [cid, from])).rows;
    const notes = (await pool.query(
      `SELECT n.id, n.number, n.date, n.total, p.name AS party_name, p.gstin AS party_gstin, i.number AS against
       FROM notes n JOIN parties p ON p.id=n.party_id JOIN invoices i ON i.id=n.invoice_id WHERE n.company_id=$1 AND n.kind='credit' AND n.date >= $2 ORDER BY n.date DESC, n.id DESC`, [cid, from])).rows;

    const row = (type, x) => {
      const e = einv.get(`${type}|${x.id}`);
      const date = ymd(x.date);
      const w = type === 'INV' ? ewb.get(x.id) : null;
      return {
        doc_type: type, doc_id: x.id, number: x.number, date, total: Number(x.total), party: x.party_name, gstin: x.party_gstin, against: x.against ?? null,
        b2b: !!x.party_gstin, required: required(date, x.party_gstin), einvoice: e ? einvView(e) : null,
        ewb: w ? { id: w.id, status: w.status, ewb_no: w.ewb_no, valid_upto: iso(w.valid_upto) } : null,
        ewb_suggested: type === 'INV' && Number(x.total) > Number(co.ewb_threshold) && !w,
      };
    };
    const docs = [...invs.map((x) => row('INV', x)), ...notes.map((x) => row('CRN', x))].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
    res.json({ enabled: co.einvoice_enabled, applicable_from: co.einvoice_from ? ymd(co.einvoice_from) : null, documents: docs });
  }));

  r.post('/einvoice/prepare', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ type: z.enum(['INV', 'CRN']), docId: z.number().int() }).parse(req.body);
    const cid = req.user.companyId;
    const existing = (await pool.query('SELECT * FROM einvoices WHERE company_id=$1 AND doc_type=$2 AND doc_id=$3', [cid, b.type, b.docId])).rows[0];
    if (existing?.status === 'generated') throw httpError(409, 'This document already has an IRN.');
    if (existing?.status === 'cancelled') throw code(httpError(409, 'The IRN for this document was cancelled. The IRP does not allow the same document number to be reported again: issue a new document.'), 'IRN_CANCELLED');
    const built = await buildFor(cid, b.type, b.docId);
    const fields = { payload: built.text, payload_hash: sha256(built.text), validation: json({ errors: built.errors, warnings: built.warnings }), status: 'pending', gsp_errors: null };
    let e;
    if (existing) e = await set('einvoices', existing.id, fields);
    else {
      const keys = Object.keys(fields);
      e = (await pool.query(`INSERT INTO einvoices (company_id, doc_type, doc_id, doc_number, ${keys.join(', ')}) VALUES ($1,$2,$3,$4,${keys.map((_, i) => `$${i + 5}`).join(',')}) RETURNING *`, [cid, b.type, b.docId, built.doc.number, ...keys.map((k) => fields[k])])).rows[0];
    }
    await event('einvoice', e.id, req.user.id, 'prepared', `${built.errors.length} error(s), ${built.warnings.length} warning(s)`);
    res.status(existing ? 200 : 201).json(einvView(e));
  }));

  r.get('/einvoice/:id', h(async (req, res) => {
    const e = await loadEinv(req);
    const events = (await pool.query("SELECT ev.action, ev.detail, ev.created_at, u.name AS by FROM edoc_events ev LEFT JOIN users u ON u.id=ev.user_id WHERE ev.kind='einvoice' AND ev.doc_id=$1 ORDER BY ev.id", [e.id])).rows;
    res.json({ ...einvView(e), payload: parse(e.payload), events, gsp: gsp ? { name: gsp.name, mode: gsp.mode } : null });
  }));

  // Generate the IRN. The payload is rebuilt from current data first, so a fixed address is picked up without re-preparing.
  r.post('/einvoice/:id/generate', h(async (req, res) => {
    needOwner(req);
    const e = await loadEinv(req);
    if (!['pending', 'failed'].includes(e.status)) throw httpError(409, `This document is ${e.status}.`);
    const cid = req.user.companyId;
    const built = await buildFor(cid, e.doc_type, e.doc_id);
    await set('einvoices', e.id, { payload: built.text, payload_hash: sha256(built.text), validation: json({ errors: built.errors, warnings: built.warnings }) });
    if (built.errors.length) throw code(httpError(409, `Fix these first: ${built.errors.join(' ')}`), 'VALIDATION');
    const co = await company(cid);
    try {
      const out = await needGsp().generateIrn({ gstin: co.gstin, payload: built.payload, session: await requireSession(pool, cid, co.gstin) });
      const up = await set('einvoices', e.id, { status: 'generated', irn: out.irn, ack_no: out.ackNo, ack_date: out.ackDate, signed_qr: out.signedQr, gsp_errors: json([]) });
      await event('einvoice', e.id, req.user.id, 'generated', `IRN ${out.irn.slice(0, 16)}…, Ack ${out.ackNo}`);
      res.json(einvView(up));
    } catch (err) {
      if (err.code === 'GSP_ERROR') {
        await set('einvoices', e.id, { status: 'failed', gsp_errors: json(err.errors?.length ? err.errors : [{ message: err.message }]) });
        await event('einvoice', e.id, req.user.id, 'rejected', err.message);
      }
      throw err;
    }
  }));

  const REASONS = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Others' };
  r.post('/einvoice/:id/cancel', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ reason: z.number().int().min(1).max(4), remarks: z.string().max(100).optional() }).parse(req.body);
    const e = await loadEinv(req);
    if (e.status !== 'generated') throw httpError(409, `An IRN can only be cancelled when it is generated (this one is ${e.status}).`);
    const co = await company(req.user.companyId);
    await needGsp().cancelIrn({ gstin: co.gstin, irn: e.irn, reason: b.reason, remarks: b.remarks, session: await requireSession(pool, req.user.companyId, co.gstin) });
    const up = await set('einvoices', e.id, { status: 'cancelled', cancel_reason: `${REASONS[b.reason]}${b.remarks ? `: ${b.remarks}` : ''}`, cancelled_on: new Date() });
    await event('einvoice', e.id, req.user.id, 'cancelled', up.cancel_reason);
    res.json(einvView(up));
  }));

  // ---------- e-way bill ----------

  const transportSchema = z.object({
    mode: z.number().int().min(1).max(4), distance: z.number().int().min(0).max(4000).default(0),
    transporterId: z.string().max(15).optional(), transporterName: z.string().max(100).optional(),
    docNo: z.string().max(15).optional(), docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    vehicleNo: z.string().max(15).optional(), vehicleType: z.enum(['R', 'O']).optional(),
  });
  const ewbView = (w) => ({
    id: w.id, invoice_id: w.invoice_id, status: w.status, ewb_no: w.ewb_no, ewb_date: iso(w.ewb_date), valid_upto: iso(w.valid_upto), vehicle_no: w.vehicle_no,
    transporter_id: w.transporter_id, distance: w.distance, validation: parse(w.validation), gsp_errors: parse(w.gsp_errors) ?? [], cancel_reason: w.cancel_reason,
    payload_hash: w.payload_hash,
  });
  const loadEwb = async (req) => {
    const w = (await pool.query('SELECT * FROM ewaybills WHERE id=$1 AND company_id=$2', [req.params.id, req.user.companyId])).rows[0];
    if (!w) throw httpError(404, 'Not found');
    return w;
  };

  r.post('/ewb/prepare', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ invoiceId: z.number().int(), transport: transportSchema }).parse(req.body);
    const cid = req.user.companyId;
    const { doc, party, lines } = await loadDoc(cid, 'INV', b.invoiceId);
    const live = (await pool.query("SELECT * FROM ewaybills WHERE company_id=$1 AND invoice_id=$2 AND status <> 'cancelled' ORDER BY id DESC", [cid, doc.id])).rows[0];
    if (live?.status === 'generated') throw httpError(409, `An e-way bill (${live.ewb_no}) already exists for this invoice. Cancel it first to make a new one.`);
    const co = await company(cid);
    const built = buildEwb({ company: co, party, invoice: doc, lines, units: await unitsOf(cid), transport: b.transport, threshold: co.ewb_threshold });
    const text = JSON.stringify(built.payload);
    const fields = { payload: text, payload_hash: sha256(text), validation: json({ errors: built.errors, warnings: built.warnings }), status: 'draft', gsp_errors: null,
      vehicle_no: b.transport.vehicleNo ?? null, transporter_id: b.transport.transporterId ?? null, distance: b.transport.distance };
    let w;
    if (live) w = await set('ewaybills', live.id, fields);
    else {
      const keys = Object.keys(fields);
      w = (await pool.query(`INSERT INTO ewaybills (company_id, invoice_id, ${keys.join(', ')}) VALUES ($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`, [cid, doc.id, ...keys.map((k) => fields[k])])).rows[0];
    }
    await event('ewb', w.id, req.user.id, 'prepared', `${built.errors.length} error(s), ${built.warnings.length} warning(s)`);
    res.status(live ? 200 : 201).json(ewbView(w));
  }));

  r.get('/ewb', h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT w.*, i.number AS invoice_number, p.name AS party_name FROM ewaybills w JOIN invoices i ON i.id=w.invoice_id JOIN parties p ON p.id=i.party_id
       WHERE w.company_id=$1 ORDER BY w.id DESC`, [req.user.companyId]);
    res.json(rows.map((w) => ({ ...ewbView(w), invoice_number: w.invoice_number, party: w.party_name })));
  }));

  r.get('/ewb/:id', h(async (req, res) => {
    const w = await loadEwb(req);
    const events = (await pool.query("SELECT ev.action, ev.detail, ev.created_at, u.name AS by FROM edoc_events ev LEFT JOIN users u ON u.id=ev.user_id WHERE ev.kind='ewb' AND ev.doc_id=$1 ORDER BY ev.id", [w.id])).rows;
    res.json({ ...ewbView(w), payload: parse(w.payload), events, gsp: gsp ? { name: gsp.name, mode: gsp.mode } : null });
  }));

  r.post('/ewb/:id/generate', h(async (req, res) => {
    needOwner(req);
    const w = await loadEwb(req);
    if (!['draft', 'failed'].includes(w.status)) throw httpError(409, `This e-way bill is ${w.status}.`);
    const v = parse(w.validation);
    if (v.errors.length) throw code(httpError(409, `Fix these first: ${v.errors.join(' ')}`), 'VALIDATION');
    const co = await company(w.company_id);
    try {
      const out = await needGsp().generateEwb({ gstin: co.gstin, payload: parse(w.payload), session: await requireSession(pool, w.company_id, co.gstin) });
      const up = await set('ewaybills', w.id, { status: 'generated', ewb_no: out.ewbNo, ewb_date: out.ewbDate, valid_upto: out.validUpto, gsp_errors: json([]) });
      await event('ewb', w.id, req.user.id, 'generated', `EWB ${out.ewbNo}, valid until ${iso(out.validUpto)}`);
      res.json(ewbView(up));
    } catch (err) {
      if (err.code === 'GSP_ERROR') {
        await set('ewaybills', w.id, { status: 'failed', gsp_errors: json(err.errors?.length ? err.errors : [{ message: err.message }]) });
        await event('ewb', w.id, req.user.id, 'rejected', err.message);
      }
      throw err;
    }
  }));

  // Part B: record or change the vehicle once the goods are loaded (or the transporter assigns it).
  r.post('/ewb/:id/vehicle', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ vehicleNo: z.string().max(15), reason: z.number().int().min(1).max(4).default(4), remarks: z.string().max(50).optional() }).parse(req.body);
    const w = await loadEwb(req);
    if (w.status !== 'generated') throw httpError(409, 'Only a generated e-way bill can have its vehicle updated.');
    const co = await company(w.company_id);
    const out = await needGsp().updateVehicle({ gstin: co.gstin, ewbNo: w.ewb_no, vehicleNo: b.vehicleNo.toUpperCase(), reason: b.reason, remarks: b.remarks, session: await requireSession(pool, w.company_id, co.gstin) });
    const payload = { ...parse(w.payload), vehicleNo: b.vehicleNo.toUpperCase(), vehicleType: 'R' };
    const up = await set('ewaybills', w.id, { vehicle_no: b.vehicleNo.toUpperCase(), valid_upto: out.validUpto ?? w.valid_upto, payload: JSON.stringify(payload) });
    await event('ewb', w.id, req.user.id, 'vehicle_updated', b.vehicleNo.toUpperCase());
    res.json(ewbView(up));
  }));

  r.post('/ewb/:id/cancel', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ reason: z.number().int().min(1).max(4), remarks: z.string().max(100).optional() }).parse(req.body);
    const w = await loadEwb(req);
    if (w.status !== 'generated') throw httpError(409, `Only a generated e-way bill can be cancelled (this one is ${w.status}).`);
    const co = await company(w.company_id);
    await needGsp().cancelEwb({ gstin: co.gstin, ewbNo: w.ewb_no, reason: b.reason, remarks: b.remarks, session: await requireSession(pool, w.company_id, co.gstin) });
    const labels = { 1: 'Duplicate', 2: 'Order cancelled', 3: 'Data entry mistake', 4: 'Others' };
    const up = await set('ewaybills', w.id, { status: 'cancelled', cancel_reason: `${labels[b.reason]}${b.remarks ? `: ${b.remarks}` : ''}`, cancelled_on: new Date() });
    await event('ewb', w.id, req.user.id, 'cancelled', up.cancel_reason);
    res.json(ewbView(up));
  }));

  return r;
}
