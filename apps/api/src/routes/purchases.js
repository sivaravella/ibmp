import { Router } from 'express';
import { z } from 'zod';
import { h, httpError } from '../util.js';
import { computeInvoice } from '../gst.js';
import { recordPayment } from '../payments.js';
import { assertPeriodOpen } from '../filing-lock.js';
import { A, post, taxLines } from '../ledger.js';

const purchaseSchema = z.object({
  partyId: z.number().int(),
  supplierBillNo: z.string().min(1),
  reverseCharge: z.boolean().optional(),     // the vendor charged no GST: the buyer assesses and pays it
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({
    itemId: z.number().int(),
    qty: z.number().positive(),
    rate: z.number().nonnegative(),            // cost rate, excl. GST
    gstPct: z.number().refine((v) => [0, 0.25, 3, 5, 12, 18, 28].includes(v), 'Invalid GST slab').optional(),
  })).min(1),
});

export function purchaseRoutes(pool) {
  const r = Router();

  r.get('/purchases', h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT b.*, p.name AS party_name FROM purchases b JOIN parties p ON p.id=b.party_id
       WHERE b.company_id=$1 ORDER BY b.id DESC`, [req.user.companyId]);
    res.json(rows);
  }));

  r.get('/purchases/:id', h(async (req, res) => {
    const b = (await pool.query(
      `SELECT b.*, p.name AS party_name, p.gstin AS party_gstin FROM purchases b JOIN parties p ON p.id=b.party_id
       WHERE b.id=$1 AND b.company_id=$2`, [req.params.id, req.user.companyId])).rows[0];
    if (!b) throw httpError(404, 'Not found');
    b.lines = (await pool.query('SELECT * FROM purchase_lines WHERE purchase_id=$1 ORDER BY id', [b.id])).rows;
    res.json(b);
  }));

  r.post('/purchases', h(async (req, res) => {
    const b = purchaseSchema.parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertPeriodOpen(client, cid, ['GSTR3B'], b.date, 'purchase bill');
      const company = (await client.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
      const vendor = (await client.query(
        "SELECT * FROM parties WHERE id=$1 AND company_id=$2 AND type='vendor'", [b.partyId, cid])).rows[0];
      if (!vendor) throw httpError(400, 'Unknown vendor');
      if ((await client.query('SELECT 1 FROM purchases WHERE company_id=$1 AND party_id=$2 AND supplier_bill_no=$3',
        [cid, vendor.id, b.supplierBillNo])).rowCount)
        throw httpError(409, 'This vendor bill number is already recorded');

      const lines = [];
      for (const l of b.lines) {
        const it = (await client.query('SELECT * FROM items WHERE id=$1 AND company_id=$2', [l.itemId, cid])).rows[0];
        if (!it) throw httpError(400, `Unknown item ${l.itemId}`);
        lines.push({ item: it, qty: l.qty, rate: l.rate, gst_pct: l.gstPct ?? Number(it.gst_pct) });
      }
      const calc = computeInvoice(lines, company.state_code, vendor.state_code);
      const rcm = !!b.reverseCharge;
      if (rcm && !(calc.cgst + calc.sgst + calc.igst > 0)) throw httpError(400, 'Reverse charge applies to taxable supplies: every line here has a 0% rate, so there is no tax to assess.');

      const seq = (await client.query(
        'UPDATE companies SET bill_seq = bill_seq + 1 WHERE id=$1 RETURNING bill_seq', [cid])).rows[0].bill_seq;
      const number = `BILL-${String(seq).padStart(4, '0')}`;
      const bill = (await client.query(
        `INSERT INTO purchases (company_id,party_id,number,supplier_bill_no,date,place_of_supply,taxable,cgst,sgst,igst,total,reverse_charge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [cid, vendor.id, number, b.supplierBillNo, b.date, vendor.state_code,
          calc.taxable, calc.cgst, calc.sgst, calc.igst, rcm ? calc.taxable : calc.total, rcm])).rows[0];

      for (const l of calc.lines) {
        await client.query(
          `INSERT INTO purchase_lines (purchase_id,item_id,description,hsn,qty,rate,gst_pct,taxable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bill.id, l.item.id, l.item.name, l.item.hsn, l.qty, l.rate, l.gst_pct, l.taxable]);
        await client.query('UPDATE items SET stock = stock + $1 WHERE id=$2', [l.qty, l.item.id]);
      }
      await post(client, {
        companyId: cid, date: b.date, sourceType: 'purchase', sourceId: bill.id,
        narration: `Purchase ${number} (vendor bill ${b.supplierBillNo})`,
        // Reverse charge: the vendor is owed only the taxable value; the tax is booked as both a liability and a credit (assessed and claimed by the buyer).
        lines: [
          { code: A.PURCHASES, debit: calc.taxable },
          ...taxLines(calc, 'in', 'debit'),
          { code: A.CREDITORS, credit: rcm ? calc.taxable : calc.total, partyId: vendor.id },
          ...(rcm ? taxLines(calc, 'out', 'credit') : []),
        ],
      });
      await client.query('COMMIT');
      res.status(201).json(bill);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  r.post('/purchases/:id/payments', h(async (req, res) => res.json(await recordPayment(pool, 'purchases', req))));

  return r;
}
