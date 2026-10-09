import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { fyOf, parseFy } from '../compliance.js';
import { PIN_RE } from '../einvoice.js';
import { GSTIN_RE } from '../gst.js';
import { PAN_RE } from '../tds.js';
import { STATES } from '../states.js';
import { parseGstin } from '../gstin-lookup.js';

const text = (max) => z.string().trim().max(max).nullable();
const pin = z.string().regex(PIN_RE, 'PIN code must be 6 digits').nullable();

export const ENTITY_TYPES = ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'opc', 'huf', 'trust', 'society', 'other'];

export const profileSchema = z.object({
  legalName: text(100), tradeName: text(100), addr1: text(100), addr2: text(100), loc: text(50), pin,
  phone: z.string().regex(/^\d{6,12}$/, 'Phone must be 6 to 12 digits').nullable(), email: z.string().email().nullable(),
  // printed on tax invoices
  bankName: text(80), bankAccount: z.string().trim().regex(/^\d{6,20}$/, 'Account number is 6 to 20 digits').nullable(), bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').nullable(),
  bankBranch: text(80), upiId: z.string().trim().regex(/^[\w.\-]{2,}@[\w]{2,}$/, 'UPI ID looks like name@bank').nullable(),
  logo: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'The logo must be a PNG, JPEG or WebP image').max(200_000, 'The logo is too large: use an image under about 140 KB').nullable(),
  invoiceNumbering: z.enum(['continuous', 'financial_year']),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,5}$/, 'The prefix is 1 to 5 letters or digits'),
  invoiceTerms: text(1000), invoiceFooter: text(200), signatory: text(80), paymentDays: z.number().int().min(0).max(365),
  // the business profile: who the enterprise is
  gstin: z.string().trim().toUpperCase().regex(GSTIN_RE, 'A GSTIN has 15 characters, for example 29ABCDE1234F1Z5').nullable(),
  pan: z.string().trim().toUpperCase().regex(PAN_RE, 'PAN must look like ABCDE1234F').nullable(),
  stateCode: z.string().regex(/^\d{2}$/, 'State code is two digits, for example 29').refine((c) => c in STATES, 'That is not a GST state code'),
  entityType: z.enum(ENTITY_TYPES).nullable(),
  cin: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,25}$/, 'CIN or LLPIN looks like U74999AP2020PTC123456 or AAB-1234').nullable(),
  udyam: z.string().trim().toUpperCase().regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'Udyam number looks like UDYAM-AP-01-1234567').nullable(),
  tan: z.string().trim().toUpperCase().regex(/^[A-Z]{4}\d{5}[A-Z]$/, 'TAN looks like HYDA12345B').nullable(),
  website: z.string().trim().max(120).nullable(), contactPerson: text(80),
  incorporatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD').nullable(),
}).partial();

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const COLS = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? snake(k) : undefined) });
const blank = (v) => (v === '' ? null : v);

const PROFILE_FIELDS = 'id, name, legal_name, trade_name, gstin, state_code, addr1, addr2, loc, pin, phone, email, pan, bank_name, bank_account, bank_ifsc, bank_branch, upi_id, invoice_terms, invoice_footer, signatory, payment_days, logo, invoice_numbering, invoice_prefix, entity_type, cin, udyam, tan, website, contact_person, incorporated_on';
const AATO_LIMIT = 5_00_00_000;      // e-invoicing applies above ₹5 crore aggregate turnover (check the current notification)

// What a complete business profile has. GSTIN is listed because most businesses have one; an unregistered business simply leaves it out.
const PROFILE_CHECKLIST = [['legal_name', 'Legal name'], ['entity_type', 'Type of business'], ['gstin', 'GSTIN (if registered)'], ['pan', 'PAN'], ['addr1', 'Address'], ['loc', 'Town or city'], ['pin', 'PIN code'],
  ['phone', 'Phone'], ['email', 'Email'], ['bank_account', 'Bank account'], ['bank_ifsc', 'IFSC code']];
export function completeness(row) {
  const missing = PROFILE_CHECKLIST.filter(([k]) => row[k] === null || row[k] === undefined || String(row[k]).trim() === '').map(([key, label]) => ({ key, label }));
  return { percent: Math.round(((PROFILE_CHECKLIST.length - missing.length) / PROFILE_CHECKLIST.length) * 100), missing };
}

export function profileRoutes(pool) {
  const r = Router();
  const needOwner = (req) => { if (req.user.role !== 'owner') throw Object.assign(httpError(403, 'Only the account owner can change this.'), { code: 'OWNER_ONLY' }); };

  r.get('/company/profile', h(async (req, res) => {
    const row = (await pool.query(`SELECT ${PROFILE_FIELDS} FROM companies WHERE id=$1`, [req.user.companyId])).rows[0];
    res.json({ ...row, incorporated_on: row.incorporated_on ? ymd(row.incorporated_on) : null, completeness: completeness(row) });
  }));

  r.put('/company/profile', h(async (req, res) => {
    needOwner(req);
    const raw = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, blank(v)]));
    const confirm = raw.confirmStateChange === true;
    delete raw.confirmStateChange;
    const b = profileSchema.parse(raw);
    const cid = req.user.companyId;
    const now = (await pool.query('SELECT gstin, pan, state_code FROM companies WHERE id=$1', [cid])).rows[0];

    // The GSTIN can be added (and corrected) at any time. It carries the state and the PAN, so the three have to agree.
    if (b.gstin) {
      const p = parseGstin(b.gstin);
      if (!p.checkOk) throw httpError(400, 'This GSTIN fails the check-character test, so it is probably mistyped. Check it against the GST certificate.');
      const pan = b.pan ?? now.pan;
      if (pan && pan !== p.pan) throw httpError(400, `The PAN inside this GSTIN is ${p.pan}, but the PAN on file is ${pan}. Correct whichever is wrong.`);
      if (!pan) b.pan = p.pan;
      b.stateCode = p.stateCode;
    } else if (b.pan && (b.gstin === undefined ? now.gstin : null)) {
      const own = parseGstin(now.gstin);
      if (own.pan && own.pan !== b.pan) throw httpError(400, `The PAN inside your GSTIN is ${own.pan}. Change the GSTIN first if the PAN is going to change.`);
    }
    if (b.stateCode && b.stateCode !== now.state_code) {
      const used = (await pool.query('SELECT (SELECT count(*) FROM invoices WHERE company_id=$1) + (SELECT count(*) FROM purchases WHERE company_id=$1) AS n', [cid])).rows[0].n;
      if (Number(used) > 0 && !confirm)
        throw Object.assign(httpError(409, `This changes your state from ${STATES[now.state_code] ?? now.state_code} to ${STATES[b.stateCode]}. New invoices and bills will charge CGST and SGST or IGST by the new state; the ones already made stay as they are. Confirm to continue.`), { code: 'STATE_CHANGE' });
    }
    const keys = Object.keys(b);
    if (!keys.length) throw httpError(400, 'Nothing to update');
    const row = (await pool.query(
      `UPDATE companies SET ${keys.map((k, i) => `${COLS[k] ?? k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1} RETURNING ${PROFILE_FIELDS}`,
      [...keys.map((k) => b[k]), cid])).rows[0];
    res.json({ ...row, incorporated_on: row.incorporated_on ? ymd(row.incorporated_on) : null, completeness: completeness(row) });
  }));

  // Parties: postal details are needed for e-invoices and e-way bills. The GSTIN is deliberately not editable here.
  r.put('/parties/:id', h(async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(100), addr1: text(100), addr2: text(100), loc: text(50), pin, phone: z.string().regex(/^\d{6,12}$/).nullable(), email: z.string().email().nullable() })
      .partial().parse(Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, blank(v)])));
    const keys = Object.keys(b);
    if (!keys.length) throw httpError(400, 'Nothing to update');
    const row = (await pool.query(
      `UPDATE parties SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1} AND company_id=$${keys.length + 2} RETURNING *`,
      [...keys.map((k) => b[k]), req.params.id, req.user.companyId])).rows[0];
    if (!row) throw httpError(404, 'Not found');
    res.json(row);
  }));

  // ---- e-invoice and e-way bill settings ----
  async function aato(cid, today) {
    const s0 = parseFy(fyOf(today));
    const sum = async (from, to) => Number((await pool.query('SELECT COALESCE(SUM(taxable),0) AS t FROM invoices WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, to])).rows[0].t);
    return { current: await sum(`${s0}-04-01`, `${s0 + 1}-03-31`), previous: await sum(`${s0 - 1}-04-01`, `${s0}-03-31`) };
  }

  r.get('/einvoice/settings', h(async (req, res) => {
    const c = (await pool.query('SELECT einvoice_enabled, einvoice_from, ewb_threshold, gstin FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    const t = await aato(req.user.companyId, new Date().toISOString().slice(0, 10));
    const over = Math.max(t.current, t.previous) > AATO_LIMIT;
    res.json({
      enabled: c.einvoice_enabled, applicable_from: c.einvoice_from ? ymd(c.einvoice_from) : null, ewb_threshold: Number(c.ewb_threshold),
      recorded_turnover: t, suggested: over && !c.einvoice_enabled,
      note: 'E-invoicing applies when the aggregate turnover of every GSTIN under your PAN exceeded ₹5 crore in any year since 2017-18. IBMP only sees this GSTIN, so decide this yourself and confirm against the current notification.',
    });
  }));

  r.put('/einvoice/settings', h(async (req, res) => {
    needOwner(req);
    const b = z.object({ enabled: z.boolean(), applicableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), ewbThreshold: z.number().min(0).max(10_00_00_000) }).partial().parse(req.body);
    const cur = (await pool.query('SELECT einvoice_enabled, einvoice_from, ewb_threshold FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    const enabled = b.enabled ?? cur.einvoice_enabled;
    const from = b.applicableFrom !== undefined ? b.applicableFrom : (cur.einvoice_from ? ymd(cur.einvoice_from) : null);
    if (enabled && !from) throw httpError(400, 'Say from which date e-invoicing applies to you.');
    await pool.query('UPDATE companies SET einvoice_enabled=$1, einvoice_from=$2, ewb_threshold=$3 WHERE id=$4', [enabled, from, b.ewbThreshold ?? cur.ewb_threshold, req.user.companyId]);
    res.json({ enabled, applicable_from: from, ewb_threshold: b.ewbThreshold ?? Number(cur.ewb_threshold) });
  }));

  return r;
}
