import { Router } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { buildWorkbook, toCsv, readTable } from '../sheets.js';
import { createInvoice, createPurchase } from '../docs.js';
import { fyOf } from '../compliance.js';
import { STATES } from '../states.js';
import { analyse, columnsFor, errorReportRows, publicDoc, sampleRows, summarise, templateSheets } from '../importexport.js';

// Excel and CSV import and export of sales invoices and purchase bills.
//
// Import is two calls: POST /import/preview reads and checks the file and keeps the checked documents here on the server under a random
// token (30 minutes, one company); POST /import/commit {token} then creates them, so the file is not uploaded twice and what was
// previewed is exactly what is created. The token store is in memory: with several API processes the commit must reach the one that
// made the preview (the app runs as one process; if a commit finds no preview the person is asked to upload the file again).
// Every document is created in its own transaction, so a bad one never blocks the others.

const TTL_MS = 30 * 60 * 1000;
const sessions = new Map();
const prune = () => { const now = Date.now(); for (const [k, s] of sessions) if (now - s.at > TTL_MS) sessions.delete(k); };
const session = (token, cid) => {
  prune();
  const s = sessions.get(String(token ?? ''));
  if (!s || s.companyId !== cid) throw Object.assign(httpError(404, 'This preview has expired. Upload the file again.'), { code: 'PREVIEW_EXPIRED' });
  return s;
};

const typeSchema = z.enum(['sales', 'purchases']);
const formatSchema = z.enum(['xlsx', 'csv']).default('xlsx');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-04-01');
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dmy = (d) => { const s = ymd(d); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : ''; };
const n = (v) => Number(v ?? 0);
const r2 = (v) => Math.round(n(v) * 100) / 100;
const collapse = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const posLabel = (c) => (c in STATES ? `${c} - ${STATES[c]}` : String(c ?? ''));

const send = (res, buf, format, name) => {
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`);
  res.type(format === 'csv' ? 'text/csv; charset=utf-8' : XLSX_TYPE).send(buf);
};

export function importExportRoutes(pool) {
  const r = Router();

  // ---- templates -------------------------------------------------------------------------------------------------------------
  r.get('/import/template', h(async (req, res) => {
    const type = typeSchema.parse(req.query.type), format = formatSchema.parse(req.query.format);
    const name = `ibmp-${type}-import-template`;
    if (format === 'csv') return send(res, toCsv([columnsFor(type).map((c) => c.h + (c.req ? ' *' : '')), ...sampleRows(type)]), 'csv', name);
    const company = (await pool.query('SELECT state_code FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    send(res, await buildWorkbook(templateSheets(type, company?.state_code)), 'xlsx', name);
  }));

  // ---- preview ---------------------------------------------------------------------------------------------------------------
  r.post('/import/preview', express.raw({ type: () => true, limit: '5mb' }), h(async (req, res) => {
    const type = typeSchema.parse(req.query.type);
    const cid = req.user.companyId;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'No file was received. Choose an .xlsx or .csv file.');
    if (buf.slice(0, 4).toString('hex') === 'd0cf11e0') throw httpError(400, 'This looks like an old Excel (.xls) file. Open it in Excel, save it as .xlsx or .csv, and upload that.');
    let fileName = String(req.headers['x-filename'] ?? req.query.name ?? '').slice(0, 200);
    try { fileName = decodeURIComponent(fileName); } catch { /* keep as sent */ }
    let rows;
    try { rows = await readTable(buf); } catch { throw httpError(400, 'This file could not be read. Check that it is a valid .xlsx or .csv file.'); }
    if (!rows.length) throw httpError(400, 'The file is empty.');

    const S = type === 'sales';
    const company = (await pool.query('SELECT state_code FROM companies WHERE id=$1', [cid])).rows[0];
    const parties = (await pool.query('SELECT id, name, gstin, state_code FROM parties WHERE company_id=$1 AND type=$2', [cid, S ? 'customer' : 'vendor'])).rows
      .map((p) => ({ id: p.id, name: p.name, gstin: p.gstin, stateCode: p.state_code }));
    const items = (await pool.query('SELECT id, name, gst_pct, stock, hsn, unit FROM items WHERE company_id=$1', [cid])).rows
      .map((i) => ({ id: i.id, name: i.name, gstPct: n(i.gst_pct), stock: n(i.stock), hsn: i.hsn, unit: i.unit }));
    const existing = new Set(S
      ? (await pool.query('SELECT number FROM invoices WHERE company_id=$1', [cid])).rows.map((x) => String(x.number).toUpperCase())
      : (await pool.query('SELECT party_id, supplier_bill_no FROM purchases WHERE company_id=$1', [cid])).rows.map((x) => `${x.party_id}|${String(x.supplier_bill_no).toUpperCase()}`));
    // A month whose GST return is submitted or filed takes no new documents (the same rule the screens apply, see filing-lock.js).
    const types = S ? ['GSTR1', 'GSTR3B'] : ['GSTR3B'];
    const filed = (await pool.query("SELECT period, return_type, status FROM gst_filings WHERE company_id=$1 AND status IN ('submitted','filed')", [cid])).rows.filter((x) => types.includes(x.return_type));
    const locked = (date) => {
      const hit = filed.find((x) => x.period === date.slice(0, 7));
      return hit ? `${hit.return_type === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} for ${hit.period} is already ${hit.status}, so ${S ? 'an invoice' : 'a bill'} dated ${date} cannot be imported. Date it in the current period instead.` : null;
    };

    const { documents } = analyse(type, rows, { companyState: company.state_code, today: ymd(new Date()), parties, items, existing, locked });
    prune();
    // Each company keeps a few previews at a time; the oldest goes first.
    const mine = [...sessions.entries()].filter(([, s]) => s.companyId === cid);
    if (mine.length >= 5) sessions.delete(mine.sort((a, b) => a[1].at - b[1].at)[0][0]);
    const token = randomBytes(18).toString('base64url');
    sessions.set(token, { companyId: cid, type, docs: documents, fileName, at: Date.now(), busy: false, result: null });
    res.json({ token, fileName, type, expiresInMinutes: TTL_MS / 60000, summary: summarise(documents), documents: documents.map(publicDoc) });
  }));

  // ---- commit ----------------------------------------------------------------------------------------------------------------
  r.post('/import/commit', h(async (req, res) => {
    const b = z.object({ token: z.string().min(1), skipErrors: z.boolean().optional() }).parse(req.body);
    const cid = req.user.companyId;
    const s = session(b.token, cid);
    if (s.result) return res.json({ ...s.result, created: 0, alreadyImported: true });       // the same preview is never imported twice
    if (s.busy) throw httpError(409, 'This import is already running.');
    const bad = s.docs.filter((d) => d.status === 'error');
    if (bad.length && b.skipErrors !== true) throw Object.assign(httpError(409, `${bad.length} document${bad.length === 1 ? ' has' : 's have'} errors. Fix the file, or choose to skip them.`), { code: 'HAS_ERRORS' });
    const todo = s.docs.filter((d) => d.status !== 'error').map((d, i) => ({ d, i })).sort((a, c) => (a.d.date < c.d.date ? -1 : a.d.date > c.d.date ? 1 : a.i - c.i)).map((x) => x.d);
    if (!todo.length) throw httpError(400, 'There is nothing to import: every document has errors.');
    s.busy = true;
    const result = { type: s.type, created: 0, skipped: bad.map((d) => ({ no: d.no, reason: d.errors[0] })), failed: [], documents: [], createdParties: 0, createdItems: 0 };
    try {
      for (const d of todo) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const made = await commitOne(client, cid, s.type, d);
          await client.query('COMMIT');
          result.created += 1; result.createdParties += made.newParties; result.createdItems += made.newItems;
          result.documents.push({ no: d.no, id: made.id, number: made.number });
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          if (!(e.status && e.status < 500)) console.error('import commit failed', d.no, e);
          result.failed.push({ no: d.no, reason: e.status && e.status < 500 ? e.message : 'It could not be saved. Try again.' });
        } finally { client.release(); }
      }
      s.result = result;
    } finally { s.busy = false; }
    res.status(result.created ? 201 : 200).json(result);
  }));

  // ---- error report ----------------------------------------------------------------------------------------------------------
  r.get('/import/error-report', h(async (req, res) => {
    const s = session(req.query.token, req.user.companyId);
    const format = z.enum(['xlsx', 'csv']).parse(req.query.format ?? 'csv');
    const rows = errorReportRows(s.docs);
    const name = `ibmp-${s.type}-import-errors`;
    if (format === 'csv') return send(res, toCsv(rows), 'csv', name);
    const [head, ...body] = rows;
    send(res, await buildWorkbook([{ name: 'Errors', columns: head.map((x, i) => ({ header: x, key: String(i), width: [16, 14, 10, 110][i] })), rows: body.map((x) => Object.fromEntries(x.map((v, i) => [String(i), v]))) }]), 'xlsx', name);
  }));

  // ---- export ----------------------------------------------------------------------------------------------------------------
  r.get('/export/:type(sales|purchases)', h(async (req, res) => {
    const type = typeSchema.parse(req.params.type), S = type === 'sales';
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), format: formatSchema, layout: z.enum(['register', 'lines']).default('register') }).parse(req.query);
    if (q.from && q.to && q.from > q.to) throw httpError(400, 'The start date is after the end date.');
    const cid = req.user.companyId;
    const T = S ? 'invoices' : 'purchases', args = [cid];
    let where = 'd.company_id=$1';
    if (q.from) { args.push(q.from); where += ` AND d.date >= $${args.length}`; }
    if (q.to) { args.push(q.to); where += ` AND d.date <= $${args.length}`; }
    const span = `${q.from ?? 'start'}-to-${q.to ?? 'today'}`;
    const C = columnsFor(type);

    if (q.layout === 'lines') {
      // One row per line item, in exactly the import template's columns, so the file can be imported into another set of books.
      const L = S ? 'invoice_lines' : 'purchase_lines', fk = S ? 'invoice_id' : 'purchase_id';
      const { rows } = await pool.query(
        `SELECT d.${S ? 'number' : 'supplier_bill_no'} AS doc_no, d.date, p.name AS party, p.gstin, d.place_of_supply AS pos, COALESCE(it.name, l.description) AS item, l.hsn, l.qty,
                ${S ? 'COALESCE(l.unit, it.unit)' : 'it.unit'} AS unit, l.rate, l.gst_pct, l.taxable, ${S ? 'l.discount_pct, d.notes' : 'NULL AS discount_pct, NULL AS notes'}
         FROM ${T} d JOIN parties p ON p.id=d.party_id JOIN ${L} l ON l.${fk}=d.id LEFT JOIN items it ON it.id=l.item_id
         WHERE ${where} ORDER BY d.date, d.id, l.id`, args);
      const out = rows.map((x) => {
        // A purchase line keeps only its taxable value, so its discount is whatever the rate and quantity leave over.
        const gross = n(x.qty) * n(x.rate);
        const disc = S ? n(x.discount_pct) : gross > 0 ? Math.max(0, Math.round((1 - n(x.taxable) / gross) * 100000) / 1000) : 0;
        return [x.doc_no, dmy(x.date), x.party, x.gstin ?? '', x.pos, x.item, x.hsn ?? '', n(x.qty), x.unit ?? '', n(x.rate), disc, n(x.gst_pct), x.notes ?? ''];
      });
      const name = `ibmp-${type}-lines-${span}`;
      if (q.format === 'csv') return send(res, toCsv([C.map((c) => c.h), ...out]), 'csv', name);
      const numFmt = { qty: '#,##0.###', rate: '#,##0.00', disc: '0.###', gst: '0.##' };
      return send(res, await buildWorkbook([{ name: S ? 'Sales' : 'Purchases', columns: C.map((c) => ({ header: c.h + (c.req ? ' *' : ''), key: c.k, width: c.width, numFmt: numFmt[c.k] })), rows: out.map((v) => Object.fromEntries(C.map((c, i) => [c.k, v[i]]))) }]), 'xlsx', name);
    }

    const { rows } = await pool.query(
      `SELECT d.number, ${S ? 'NULL AS supplier_bill_no' : 'd.supplier_bill_no'}, d.date, p.name AS party, p.gstin, d.place_of_supply AS pos, d.taxable, d.cgst, d.sgst, d.igst, d.total, d.paid, d.returned,
              ${S ? '0 AS tds, false AS reverse_charge' : 'd.tds, d.reverse_charge'}, d.status
       FROM ${T} d JOIN parties p ON p.id=d.party_id WHERE ${where} ORDER BY d.date, d.id`, args);
    const head = [
      [S ? 'Invoice No' : 'Bill No', 'number', 16], ...(S ? [] : [['Vendor Bill No', 'billNo', 16]]), ['Date', 'date', 12], [S ? 'Customer' : 'Vendor', 'party', 28], ['GSTIN', 'gstin', 18], ['Place of Supply', 'pos', 22],
      ['Taxable', 'taxable', 14, 1], ['CGST', 'cgst', 12, 1], ['SGST', 'sgst', 12, 1], ['IGST', 'igst', 12, 1], ['Total', 'total', 14, 1], ['Paid', 'paid', 14, 1], ['Balance', 'balance', 14, 1],
      ...(S ? [] : [['Reverse Charge', 'rcm', 10]]), ['Status', 'status', 12],
    ];
    const data = rows.map((x) => ({
      number: x.number, billNo: x.supplier_bill_no, date: dmy(x.date), party: x.party, gstin: x.gstin ?? '', pos: posLabel(x.pos),
      taxable: n(x.taxable), cgst: n(x.cgst), sgst: n(x.sgst), igst: n(x.igst), total: n(x.total), paid: n(x.paid),
      balance: Math.max(0, r2(n(x.total) - n(x.paid) - n(x.returned) - n(x.tds))), rcm: x.reverse_charge ? 'Yes' : 'No', status: x.status,
    }));
    const name = `ibmp-${type}-register-${span}`;
    if (q.format === 'csv') return send(res, toCsv([head.map((c) => c[0]), ...data.map((d) => head.map((c) => d[c[1]]))]), 'csv', name);
    const sum = (k) => r2(data.reduce((t, d) => t + d[k], 0));
    const totals = { number: 'Total', ...Object.fromEntries(['taxable', 'cgst', 'sgst', 'igst', 'total', 'paid', 'balance'].map((k) => [k, sum(k)])) };
    send(res, await buildWorkbook([{
      name: S ? 'Sales register' : 'Purchase register', title: S ? 'Sales register' : 'Purchase register',
      subtitle: `${q.from ? dmy(q.from) : 'Beginning'} to ${q.to ? dmy(q.to) : 'today'}, ${data.length} ${S ? 'invoice' : 'bill'}${data.length === 1 ? '' : 's'}`,
      columns: head.map(([header, key, width, money]) => ({ header, key, width, numFmt: money ? '#,##0.00' : undefined })), rows: data, totals,
    }]), 'xlsx', name);
  }));

  return r;
}

// ---- creating one checked document -------------------------------------------------------------------------------------------
async function commitOne(client, cid, type, d) {
  const S = type === 'sales';
  let newParties = 0, newItems = 0;
  let partyId = d.partyId;
  if (!partyId) {
    const name = collapse(d.party);
    const found = (await client.query('SELECT id FROM parties WHERE company_id=$1 AND type=$2 AND lower(name)=$3', [cid, S ? 'customer' : 'vendor', name.toLowerCase()])).rows[0];
    if (found) partyId = found.id;
    else {
      partyId = (await client.query('INSERT INTO parties (company_id,type,name,gstin,state_code) VALUES ($1,$2,$3,$4,$5) RETURNING id', [cid, S ? 'customer' : 'vendor', name, d.gstin || null, d.partyState])).rows[0].id;
      newParties += 1;
    }
  }
  const lines = [];
  for (const l of d.lines) {
    let itemId = l.itemId;
    if (!itemId) {
      const found = (await client.query('SELECT id FROM items WHERE company_id=$1 AND lower(name)=$2', [cid, l.name.toLowerCase()])).rows[0];
      if (found) itemId = found.id;
      else {
        itemId = (await client.query('INSERT INTO items (company_id,name,hsn,unit,rate,gst_pct,stock) VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id', [cid, l.name, l.hsn || null, l.unit || 'Nos', l.rate, l.gstPct])).rows[0].id;
        newItems += 1;
      }
    }
    lines.push({ itemId, qty: l.qty, rate: l.rate, discountPct: l.disc, gstPct: l.gstPct, hsn: l.hsn || undefined });
  }
  if (S) {
    const inv = await createInvoice(client, cid, { partyId, date: d.date, placeOfSupply: d.pos, notes: d.narration ? d.narration.slice(0, 500) : undefined, lines }, { number: d.no, allowShortStock: true });
    await keepSeriesAhead(client, cid, inv);
    return { id: inv.id, number: inv.number, newParties, newItems };
  }
  const bill = await createPurchase(client, cid, { partyId, supplierBillNo: d.no, date: d.date, lines });
  return { id: bill.id, number: bill.number, newParties, newItems };
}

/**
 * An imported invoice keeps the number from the file. If that number is in the shape of this company's own series (INV-0007, or INV/26/0007),
 * the series moves up to it, so the next invoice made on screen does not try to reuse it.
 */
async function keepSeriesAhead(client, cid, inv) {
  const c = (await client.query('SELECT invoice_prefix, invoice_numbering, invoice_seq FROM companies WHERE id=$1', [cid])).rows[0];
  const prefix = (c.invoice_prefix || 'INV').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (c.invoice_numbering === 'financial_year') {
    const fy = fyOf(ymd(inv.date));
    const m = new RegExp(`^${prefix}/${fy.slice(2)}/(\\d+)$`).exec(inv.number);
    if (!m) return;
    const count = Number((await client.query('SELECT count(*) AS n FROM invoices WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, `${fy.slice(0, 4)}-04-01`, `${Number(fy.slice(0, 4)) + 1}-03-31`])).rows[0].n);
    const want = Math.max(Number(m[1]), count);
    const row = (await client.query('SELECT seq FROM invoice_sequences WHERE company_id=$1 AND fy=$2', [cid, fy])).rows[0];
    if (!row) await client.query('INSERT INTO invoice_sequences (company_id, fy, seq) VALUES ($1,$2,$3)', [cid, fy, want]);
    else if (Number(row.seq) < want) await client.query('UPDATE invoice_sequences SET seq=$3 WHERE company_id=$1 AND fy=$2', [cid, fy, want]);
  } else {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(inv.number);
    if (m && Number(m[1]) > Number(c.invoice_seq)) await client.query('UPDATE companies SET invoice_seq=$1 WHERE id=$2', [Number(m[1]), cid]);
  }
}
