import { Router } from 'express';
import { h, httpError, ymd } from '../util.js';
import { buildGstr1, buildGstr3b } from '../gstreports.js';

const paise = (n) => Math.round(Number(n) * 100);
const inList = (ids, start = 1) => ids.map((_, i) => `$${i + start}`).join(',');

function periodRange(q) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(q ?? ''));
  if (!m) throw httpError(400, 'period must be YYYY-MM');
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { period: q, from: `${q}-01`, to: `${q}-${String(last).padStart(2, '0')}` };
}

export function gstRoutes(pool) {
  const r = Router();

  async function load(cid, rawPeriod) {
    const { period, from, to } = periodRange(rawPeriod);
    const company = (await pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
    const fix = (rows) => rows.map((x) => ({ ...x, date: ymd(x.date) }));

    const invoices = fix((await pool.query(
      `SELECT i.*, p.name AS party_name, p.gstin AS party_gstin FROM invoices i JOIN parties p ON p.id=i.party_id
       WHERE i.company_id=$1 AND i.date >= $2 AND i.date <= $3 ORDER BY i.date, i.id`, [cid, from, to])).rows);
    const notes = fix((await pool.query(
      `SELECT n.*, p.name AS party_name, p.gstin AS party_gstin, i.number AS doc_number, i.total AS doc_total, i.place_of_supply AS doc_pos
       FROM notes n JOIN parties p ON p.id=n.party_id JOIN invoices i ON i.id=n.invoice_id
       WHERE n.company_id=$1 AND n.kind='credit' AND n.date >= $2 AND n.date <= $3 ORDER BY n.date, n.id`, [cid, from, to])).rows);
    const purchases = fix((await pool.query(
      `SELECT b.*, p.gstin AS party_gstin FROM purchases b JOIN parties p ON p.id=b.party_id
       WHERE b.company_id=$1 AND b.date >= $2 AND b.date <= $3 ORDER BY b.date, b.id`, [cid, from, to])).rows);
    const debitNotes = fix((await pool.query(
      `SELECT n.*, p.gstin AS party_gstin FROM notes n JOIN parties p ON p.id=n.party_id
       WHERE n.company_id=$1 AND n.kind='debit' AND n.date >= $2 AND n.date <= $3`, [cid, from, to])).rows);

    const invLines = invoices.length
      ? (await pool.query(`SELECT * FROM invoice_lines WHERE invoice_id IN (${inList(invoices)})`, invoices.map((i) => i.id))).rows : [];
    const noteLines = notes.length
      ? (await pool.query(`SELECT * FROM note_lines WHERE note_id IN (${inList(notes)})`, notes.map((n) => n.id))).rows : [];
    const items = (await pool.query('SELECT id, unit FROM items WHERE company_id=$1', [cid])).rows;
    return { period, from, to, company, invoices, notes, purchases, debitNotes, invLines, noteLines, items };
  }

  // GST accounts as posted in the ledger for the period, for reconciliation.
  async function ledgerTax(cid, from, to) {
    const rows = (await pool.query(
      `SELECT a.code, SUM(l.debit) AS d, SUM(l.credit) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
       WHERE e.company_id=$1 AND e.date >= $2 AND e.date <= $3 GROUP BY a.code`, [cid, from, to])).rows;
    const by = new Map(rows.map((x) => [x.code, x]));
    const out = (code) => paise(by.get(code)?.c ?? 0) - paise(by.get(code)?.d ?? 0); // liability: credit-normal
    const inn = (code) => paise(by.get(code)?.d ?? 0) - paise(by.get(code)?.c ?? 0); // asset: debit-normal
    return {
      output: { igst: out('2120'), cgst: out('2100'), sgst: out('2110') },
      input: { igst: inn('1220'), cgst: inn('1200'), sgst: inn('1210') },
    };
  }

  r.get('/gst/gstr1', h(async (req, res) => res.json(buildGstr1(await load(req.user.companyId, req.query.period)))));

  async function gstr3bFor(cid, rawPeriod) {
    const d = await load(cid, rawPeriod);
    return buildGstr3b({ ...d, ledger: await ledgerTax(cid, d.from, d.to) });
  }
  // Used by the filing workflow, which needs the same figures for any company and period.
  r.reports = {
    gstr1: async (cid, period) => buildGstr1(await load(cid, period)),
    gstr3b: gstr3bFor,
  };

  r.get('/gst/gstr3b', h(async (req, res) => {
    res.json(await gstr3bFor(req.user.companyId, req.query.period));
  }));

  return r;
}
