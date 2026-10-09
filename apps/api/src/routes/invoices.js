import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { signToken } from '../auth.js';
import { computeInvoice } from '../gst.js';
import { recordPayment } from '../payments.js';
import { assertPeriodOpen } from '../filing-lock.js';
import { A, post, taxLines } from '../ledger.js';
import { STATES, stateName } from '../states.js';
import { splitLineTax } from '../gst.js';
import { fyOf, parseFy } from '../compliance.js';
import { createInvoice } from '../docs.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const invoiceSchema = z.object({
  partyId: z.number().int(),
  date: isoDate,
  dueDate: isoDate.nullable().optional(),
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
  shipTo: z.string().trim().max(300).optional(),
  charges: z.array(z.object({ label: z.string().trim().min(1).max(60), amount: z.number().positive().max(1e9), hsn: z.string().regex(/^\d{4,8}$/, 'The SAC must be 4 to 8 digits').optional() })).max(5).optional(),
  discountPct: z.number().min(0).max(100).optional(),       // a discount on the whole invoice, shared over the lines before tax
  dispatchedThrough: z.string().trim().max(80).optional(),
  destination: z.string().trim().max(80).optional(),
  paymentTerms: z.string().trim().max(120).optional(),
  otherRefs: z.string().trim().max(120).optional(),
  placeOfSupply: z.string().refine((v) => v in STATES, 'Unknown state code').optional(),     // when it differs from the buyer's state
  lines: z.array(z.object({
    itemId: z.number().int(),
    qty: z.number().positive(),
    rate: z.number().nonnegative().optional(),
    discountPct: z.number().min(0).max(100).optional(),
    description: z.string().trim().min(1).max(200).optional(),
  })).min(1).max(100),
});

const emailSchema = z.object({ to: z.string().trim().email('Enter a valid email address').max(120), message: z.string().trim().max(1000).optional() });
const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function invoiceRoutes(pool, { channels = null, pdf = null, baseUrl = 'http://127.0.0.1:4000', emailsPerHour = 30 } = {}) {
  const r = Router();

  r.get('/invoices', h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT i.*, p.name AS party_name FROM invoices i JOIN parties p ON p.id=i.party_id
       WHERE i.company_id=$1 ORDER BY i.id DESC`, [req.user.companyId]);
    res.json(rows);
  }));

  r.get('/invoices/:id', h(async (req, res) => {
    const inv = (await pool.query(
      `SELECT i.*, p.name AS party_name, p.gstin AS party_gstin FROM invoices i JOIN parties p ON p.id=i.party_id
       WHERE i.id=$1 AND i.company_id=$2`, [req.params.id, req.user.companyId])).rows[0];
    if (!inv) throw httpError(404, 'Not found');
    inv.lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [inv.id])).rows;
    res.json(inv);
  }));

  /**
   * The invoice as a document: supplier, buyer, lines with each line's tax, the tax summary by HSN and rate, and the e-invoice and
   * e-way bill details when they exist. Invoices made before per-line tax was stored have it worked out here the same way.
   */
  r.get('/invoices/:id/document', h(async (req, res) => {
    const cid = req.user.companyId;
    const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND company_id=$2', [req.params.id, cid])).rows[0];
    if (!inv) throw httpError(404, 'Not found');
    const company = (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
    const party = (await pool.query('SELECT * FROM parties WHERE id=$1', [inv.party_id])).rows[0];
    const rows = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [inv.id])).rows;
    const paise = (n) => Math.round(Number(n) * 100), rupees = (p) => p / 100;
    const intra = company.state_code === inv.place_of_supply;
    let lines = rows;
    if (rows.some((l) => l.cgst === null)) {
      const taxes = rows.map((l) => Math.round((paise(l.taxable) * Number(l.gst_pct)) / 100));
      const sp = splitLineTax(taxes);
      lines = rows.map((l, i) => ({ ...l, cgst: intra ? rupees(sp[i].cgst) : 0, sgst: intra ? rupees(sp[i].sgst) : 0, igst: intra ? 0 : rupees(taxes[i]) }));
    }
    // HSN and rate summary (table 12 of GSTR-1 is the same idea): what each code and rate contributed.
    const sum = new Map();
    for (const l of lines) {
      const k = `${l.hsn ?? ''}|${Number(l.gst_pct)}`;
      const x = sum.get(k) ?? { hsn: l.hsn ?? '', rate: Number(l.gst_pct), taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      x.taxable += paise(l.taxable); x.cgst += paise(l.cgst); x.sgst += paise(l.sgst); x.igst += paise(l.igst);
      sum.set(k, x);
    }
    const taxSummary = [...sum.values()].map((x) => ({ hsn: x.hsn, rate: x.rate, taxable: rupees(x.taxable), cgst: rupees(x.cgst), sgst: rupees(x.sgst), igst: rupees(x.igst), tax: rupees(x.cgst + x.sgst + x.igst) }));
    const einv = (await pool.query("SELECT status, irn, ack_no, ack_date, signed_qr FROM einvoices WHERE company_id=$1 AND doc_type='INV' AND doc_id=$2", [cid, inv.id])).rows[0] ?? null;
    const ewb = (await pool.query("SELECT ewb_no, valid_upto, status FROM ewaybills WHERE company_id=$1 AND invoice_id=$2 ORDER BY id DESC LIMIT 1", [cid, inv.id])).rows[0] ?? null;
    res.json({
      invoice: { ...inv, lines, intra, placeOfSupplyName: stateName(inv.place_of_supply), balance: Math.max(0, Number(inv.total) - Number(inv.paid) - Number(inv.returned)) },
      company: {
        name: company.legal_name || company.name, tradeName: company.trade_name, gstin: company.gstin, pan: company.pan || (company.gstin ? company.gstin.slice(2, 12) : null),
        stateCode: company.state_code, stateName: stateName(company.state_code), addr1: company.addr1, addr2: company.addr2, loc: company.loc, pin: company.pin, phone: company.phone, email: company.email,
        bankName: company.bank_name, bankAccount: company.bank_account, bankIfsc: company.bank_ifsc, bankBranch: company.bank_branch, upiId: company.upi_id,
        terms: company.invoice_terms, footer: company.invoice_footer, signatory: company.signatory, logo: company.logo,
      },
      party: { name: party.name, gstin: party.gstin, pan: party.pan, stateCode: party.state_code, stateName: stateName(party.state_code), addr1: party.addr1, addr2: party.addr2, loc: party.loc, pin: party.pin, phone: party.phone, email: party.email },
      taxSummary, einvoice: einv, ewaybill: ewb,
    });
  }));

  /**
   * Email the invoice to a customer with the PDF attached. The PDF is the app's own print page, opened in a headless browser as this user
   * with a token that lasts three minutes (see pdf.js). Every attempt is recorded.
   */
  r.post('/invoices/:id/email', h(async (req, res) => {
    if (!channels?.email) throw Object.assign(httpError(503, 'Email is not set up on this server. Ask your administrator to configure SMTP.'), { code: 'EMAIL_OFF' });
    if (!pdf) throw Object.assign(httpError(503, 'The PDF engine is not installed on this server, so the invoice cannot be attached.'), { code: 'PDF_OFF' });
    const b = emailSchema.parse(req.body);
    const cid = req.user.companyId;
    const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND company_id=$2', [req.params.id, cid])).rows[0];
    if (!inv) throw httpError(404, 'Not found');
    // An open mail feature is a spam channel: each company can send a limited number of invoices an hour (failed attempts count).
    const recent = Number((await pool.query('SELECT COUNT(*) AS n FROM invoice_emails WHERE company_id=$1 AND created_at > $2', [cid, new Date(Date.now() - 3600_000)])).rows[0].n);
    if (recent >= emailsPerHour) throw Object.assign(httpError(429, `You have emailed ${recent} invoices in the last hour, which is the limit. Try again later.`), { code: 'EMAIL_LIMIT' });
    const company = (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
    const party = (await pool.query('SELECT name FROM parties WHERE id=$1', [inv.party_id])).rows[0];
    const sender = company.legal_name || company.name;
    const balance = Math.max(0, Number(inv.total) - Number(inv.paid) - Number(inv.returned));
    const money = (n) => `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let file;
    try { file = await pdf.render({ url: `${baseUrl}/#/invoice-print?id=${inv.id}`, token: signToken({ id: req.user.id, company_id: cid, role: req.user.role }, '3m') }); }
    catch { throw httpError(502, 'The PDF could not be created. Try again in a moment.'); }

    const lines = [
      `Dear ${party.name},`, '', `Please find attached invoice ${inv.number} dated ${ymd(inv.date)} from ${sender}.`, '',
      `Invoice total: ${money(inv.total)}`, ...(balance > 0 ? [`Amount due: ${money(balance)}`] : []), ...(inv.due_date ? [`Due date: ${ymd(inv.due_date)}`] : []),
      ...(b.message ? ['', b.message] : []),
      ...(balance > 0 && (company.bank_account || company.upi_id) ? ['', 'To pay:', ...(company.bank_account ? [`Bank: ${company.bank_name ?? ''} account ${company.bank_account}${company.bank_ifsc ? `, IFSC ${company.bank_ifsc}` : ''}`] : []), ...(company.upi_id ? [`UPI: ${company.upi_id}`] : [])] : []),
      '', `Regards,`, sender,
    ];
    const text = lines.join('\n');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">${lines.map((l) => (l ? `<p style="margin:0 0 8px">${esc(l)}</p>` : '<br>')).join('')}</div>`;
    try {
      await channels.email.send({ to: b.to, subject: `Invoice ${inv.number} from ${sender}`, text, html, attachments: [{ filename: `${fileSafe(inv.number)}.pdf`, content: file, contentType: 'application/pdf' }] });
    } catch (e) {
      await pool.query("INSERT INTO invoice_emails (company_id, invoice_id, to_address, sent_by, status, error) VALUES ($1,$2,$3,$4,'failed',$5)", [cid, inv.id, b.to, req.user.id, String(e.message).slice(0, 300)]);
      throw httpError(502, 'The email could not be sent. Check the address and the email settings, then try again.');
    }
    const row = (await pool.query("INSERT INTO invoice_emails (company_id, invoice_id, to_address, sent_by, status) VALUES ($1,$2,$3,$4,'sent') RETURNING id, to_address, status, created_at", [cid, inv.id, b.to, req.user.id])).rows[0];
    res.status(201).json(row);
  }));

  r.get('/invoices/:id/emails', h(async (req, res) => {
    const cid = req.user.companyId;
    if (!(await pool.query('SELECT 1 FROM invoices WHERE id=$1 AND company_id=$2', [req.params.id, cid])).rowCount) throw httpError(404, 'Not found');
    res.json((await pool.query('SELECT id, to_address, status, created_at FROM invoice_emails WHERE company_id=$1 AND invoice_id=$2 ORDER BY id DESC LIMIT 20', [cid, req.params.id])).rows);
  }));

  r.post('/invoices', h(async (req, res) => {
    const b = invoiceSchema.parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await createInvoice(client, cid, b);
      await client.query('COMMIT');
      res.status(201).json(inv);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  r.post('/invoices/:id/payments', h(async (req, res) => res.json(await recordPayment(pool, 'invoices', req))));

  r.get('/dashboard', h(async (req, res) => {
    const cid = [req.user.companyId];
    const due = 'CASE WHEN total-paid-returned > 0 THEN total-paid-returned ELSE 0 END';
    const s = (await pool.query(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total),0) AS sales, COALESCE(SUM(${due}),0) AS outstanding,
              COALESCE(SUM(cgst+sgst+igst),0) AS output_gst FROM invoices WHERE company_id=$1`, cid)).rows[0];
    const p = (await pool.query(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS purchases, COALESCE(SUM(CASE WHEN total-paid-returned-tds > 0 THEN total-paid-returned-tds ELSE 0 END),0) AS payable,
              COALESCE(SUM(cgst+sgst+igst),0) AS input_gst FROM purchases WHERE company_id=$1`, cid)).rows[0];
    const n = (await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN kind='credit' THEN total ELSE 0 END),0) AS sales_returns,
              COALESCE(SUM(CASE WHEN kind='debit' THEN total ELSE 0 END),0) AS purchase_returns,
              COALESCE(SUM(CASE WHEN kind='credit' THEN cgst+sgst+igst ELSE 0 END),0) AS cn_gst,
              COALESCE(SUM(CASE WHEN kind='debit' THEN cgst+sgst+igst ELSE 0 END),0) AS dn_gst
       FROM notes WHERE company_id=$1`, cid)).rows[0];
    // GST figures are net of notes: credit notes reduce output tax, debit notes reduce input credit.
    const out = { ...s, ...p, sales_returns: n.sales_returns, purchase_returns: n.purchase_returns };
    out.output_gst = Number(s.output_gst) - Number(n.cn_gst);
    out.input_gst = Number(p.input_gst) - Number(n.dn_gst);
    res.json(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Number(v)])));
  }));
  return r;
}

