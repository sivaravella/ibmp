import { z } from 'zod';
import { httpError, today, ymd } from './util.js';
import { A, post } from './ledger.js';

/** Document status from totals. `returned` is the value credited/debited by notes. */
export function settle(total, paid, returned) {
  const net = Number(total) - Number(returned);
  if (net < 0.005) return 'returned';
  if (Number(paid) >= net - 0.005) return 'paid';
  return Number(paid) > 0 ? 'partial' : 'unpaid';
}

const bodySchema = z.object({
  amount: z.number().positive(),
  mode: z.enum(['cash', 'bank']).default('cash'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Record a receipt (invoices) or payment (purchases): updates the document, stores the payment and posts
 * Dr Cash/Bank Cr Debtors (receipt) or Dr Creditors Cr Cash/Bank (payment). `table` is a trusted literal.
 */
export async function recordPayment(pool, table, req) {
  const b = bodySchema.parse(req.body);
  const receipt = table === 'invoices';
  const cid = req.user.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const doc = (await client.query(`SELECT * FROM ${table} WHERE id=$1 AND company_id=$2`, [req.params.id, cid])).rows[0];
    if (!doc) throw httpError(404, 'Not found');
    const docDate = ymd(doc.date);
    const date = b.date ?? (today() < docDate ? docDate : today());
    if (date < docDate) throw httpError(400, 'Payment date cannot be before the document date');
    const held = Number(doc.returned) + Number(doc.tds || 0);   // credited by notes, or deducted as TDS and owed to the government instead
    const paid = Number(doc.paid) + b.amount;
    if (paid > Number(doc.total) - held + 0.001) throw httpError(400, 'Payment exceeds amount due');

    const updated = (await client.query(`UPDATE ${table} SET paid=$1, status=$2 WHERE id=$3 RETURNING *`,
      [paid, settle(doc.total, paid, held), doc.id])).rows[0];
    const p = (await client.query(
      `INSERT INTO payments (company_id,kind,${receipt ? 'invoice_id' : 'purchase_id'},party_id,date,amount,mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cid, receipt ? 'receipt' : 'payment', doc.id, doc.party_id, date, b.amount, b.mode])).rows[0];

    const money = b.mode === 'bank' ? A.BANK : A.CASH;
    await post(client, {
      companyId: cid, date, sourceType: receipt ? 'receipt' : 'payment', sourceId: p.id,
      narration: `${receipt ? 'Receipt against' : 'Payment against'} ${doc.number}`,
      lines: receipt
        ? [{ code: money, debit: b.amount }, { code: A.DEBTORS, credit: b.amount, partyId: doc.party_id }]
        : [{ code: A.CREDITORS, debit: b.amount, partyId: doc.party_id }, { code: money, credit: b.amount }],
    });
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
