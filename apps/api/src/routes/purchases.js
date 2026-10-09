import { Router } from 'express';
import { z } from 'zod';
import { h, httpError } from '../util.js';
import { computeInvoice } from '../gst.js';
import { recordPayment } from '../payments.js';
import { assertPeriodOpen } from '../filing-lock.js';
import { A, post, taxLines } from '../ledger.js';
import { createPurchase } from '../docs.js';

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
      const bill = await createPurchase(client, cid, b);
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
