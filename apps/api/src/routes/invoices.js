import { Router } from 'express';
import { z } from 'zod';
import { h, httpError } from '../util.js';
import { computeInvoice } from '../gst.js';
import { recordPayment } from '../payments.js';
import { assertPeriodOpen } from '../filing-lock.js';
import { A, post, taxLines } from '../ledger.js';

const invoiceSchema = z.object({
  partyId: z.number().int(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({
    itemId: z.number().int(),
    qty: z.number().positive(),
    rate: z.number().nonnegative().optional(),
  })).min(1),
});

export function invoiceRoutes(pool) {
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

  r.post('/invoices', h(async (req, res) => {
    const b = invoiceSchema.parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertPeriodOpen(client, cid, ['GSTR1', 'GSTR3B'], b.date, 'sales invoice');
      const company = (await client.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
      const party = (await client.query(
        "SELECT * FROM parties WHERE id=$1 AND company_id=$2 AND type='customer'", [b.partyId, cid])).rows[0];
      if (!party) throw httpError(400, 'Unknown customer');

      const lines = [];
      for (const l of b.lines) {
        const it = (await client.query('SELECT * FROM items WHERE id=$1 AND company_id=$2', [l.itemId, cid])).rows[0];
        if (!it) throw httpError(400, `Unknown item ${l.itemId}`);
        if (Number(it.stock) < l.qty) throw httpError(400, `Insufficient stock for ${it.name}`);
        lines.push({ item: it, qty: l.qty, rate: l.rate ?? Number(it.rate), gst_pct: Number(it.gst_pct) });
      }
      const calc = computeInvoice(lines, company.state_code, party.state_code);

      const seq = (await client.query(
        'UPDATE companies SET invoice_seq = invoice_seq + 1 WHERE id=$1 RETURNING invoice_seq', [cid])).rows[0].invoice_seq;
      const number = `INV-${String(seq).padStart(4, '0')}`;
      const inv = (await client.query(
        `INSERT INTO invoices (company_id,party_id,number,date,place_of_supply,taxable,cgst,sgst,igst,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [cid, party.id, number, b.date, party.state_code, calc.taxable, calc.cgst, calc.sgst, calc.igst, calc.total])).rows[0];

      for (const l of calc.lines) {
        await client.query(
          `INSERT INTO invoice_lines (invoice_id,item_id,description,hsn,qty,rate,gst_pct,taxable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [inv.id, l.item.id, l.item.name, l.item.hsn, l.qty, l.rate, l.gst_pct, l.taxable]);
        await client.query('UPDATE items SET stock = stock - $1 WHERE id=$2', [l.qty, l.item.id]);
      }
      await post(client, {
        companyId: cid, date: b.date, sourceType: 'invoice', sourceId: inv.id, narration: `Sales invoice ${number}`,
        lines: [
          { code: A.DEBTORS, debit: calc.total, partyId: party.id },
          { code: A.SALES, credit: calc.taxable },
          ...taxLines(calc, 'out', 'credit'),
        ],
      });
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

