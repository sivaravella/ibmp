import { Router } from 'express';
import { z } from 'zod';
import { h, httpError, ymd } from '../util.js';
import { settle } from '../payments.js';
import { assertPeriodOpen } from '../filing-lock.js';
import { A, post, taxLines } from '../ledger.js';

const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;
const rupeesOf = (t) => ({ cgst: rupees(t.cgst), sgst: rupees(t.sgst), igst: rupees(t.igst) });

// Everything that differs between a credit note (sales) and a debit note (purchase).
const KINDS = {
  credit: { doc: 'invoices', lines: 'invoice_lines', fk: 'invoice_id', seq: 'cn_seq', prefix: 'CN', party: 'customer', stockSign: +1 },
  debit: { doc: 'purchases', lines: 'purchase_lines', fk: 'purchase_id', seq: 'dn_seq', prefix: 'DN', party: 'vendor', stockSign: -1 },
};

const bodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(200).optional(),
  type: z.enum(['goods', 'value']).default('goods'),
  full: z.boolean().optional(),                       // goods only: return everything still returnable
  lines: z.array(z.object({
    lineId: z.number().int(),
    qty: z.number().positive().optional(),            // goods
    amount: z.number().positive().optional(),         // value-only: taxable amount to credit/debit
  })).default([]),
});

/** Remaining qty / taxable per source line, net of earlier notes. */
async function returnable(q, K, docId) {
  const lines = (await q.query(`SELECT * FROM ${K.lines} WHERE ${K.fk}=$1 ORDER BY id`, [docId])).rows;
  const prior = (await q.query(
    `SELECT nl.source_line_id, COALESCE(SUM(nl.qty),0) AS qty, COALESCE(SUM(nl.taxable),0) AS taxable
     FROM note_lines nl JOIN notes n ON n.id=nl.note_id
     WHERE n.${K.fk}=$1 GROUP BY nl.source_line_id`, [docId])).rows;
  const byLine = new Map(prior.map((p) => [p.source_line_id, p]));
  return lines.map((l) => {
    const p = byLine.get(l.id);
    return {
      ...l,
      returned_qty: Number(p?.qty ?? 0),
      remaining_qty: Number(l.qty) - Number(p?.qty ?? 0),
      remaining_taxable: rupees(paise(l.taxable) - paise(p?.taxable ?? 0)),
    };
  });
}
/** What one unit actually cost the buyer, in paise: the rate, or the rate less the line's discount. */
const netUnit = (l) => (Number(l.discount) > 0 ? (Math.round(Number(l.taxable) * 100)) / Number(l.qty) : Math.round(Number(l.rate) * 100));

export function returnRoutes(pool) {
  const r = Router();

  async function loadDoc(q, K, req) {
    const doc = (await q.query(`SELECT * FROM ${K.doc} WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.user.companyId])).rows[0];
    if (!doc) throw httpError(404, 'Not found');
    return doc;
  }

  const kindOf = (path) => (path.startsWith('/invoices') ? 'credit' : 'debit');

  // What can still be returned from a document (drives the return form).
  r.get(['/invoices/:id/returnable', '/purchases/:id/returnable'], h(async (req, res) => {
    const K = KINDS[kindOf(req.path)];
    const doc = await loadDoc(pool, K, req);
    res.json({ doc, lines: await returnable(pool, K, doc.id) });
  }));

  r.post(['/invoices/:id/returns', '/purchases/:id/returns'], h(async (req, res) => {
    const kind = kindOf(req.path);
    const K = KINDS[kind];
    const b = bodySchema.parse(req.body);
    const cid = req.user.companyId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertPeriodOpen(client, cid, kind === 'credit' ? ['GSTR1', 'GSTR3B'] : ['GSTR3B'], b.date, kind === 'credit' ? 'credit note' : 'debit note');
      const doc = await loadDoc(client, K, req);
      if (b.date < ymd(doc.date)) throw httpError(400, 'Note date cannot be before the document date');
      const company = (await client.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
      const lines = await returnable(client, K, doc.id);

      // Resolve what the user asked for into per-line {qty, taxable}.
      const picks = b.full && b.type === 'goods'
        ? lines.filter((l) => l.remaining_qty > 0).map((l) => ({ lineId: l.id, qty: l.remaining_qty }))
        : b.lines;
      if (!picks.length) throw httpError(400, 'Nothing to return — document is fully returned or no lines selected');

      const seen = new Set();
      const out = [];
      for (const p of picks) {
        if (seen.has(p.lineId)) throw httpError(400, 'Duplicate line in request');
        seen.add(p.lineId);
        const l = lines.find((x) => x.id === p.lineId);
        if (!l) throw httpError(400, `Line ${p.lineId} does not belong to this document`);
        const remTax = paise(l.remaining_taxable);
        let qty = null, taxable;
        if (b.type === 'goods') {
          if (!p.qty) throw httpError(400, 'qty is required for goods returns');
          if (p.qty > l.remaining_qty + 1e-9) throw httpError(400, `Return qty for ${l.description} exceeds balance (${l.remaining_qty})`);
          qty = p.qty;
          taxable = Math.abs(p.qty - l.remaining_qty) < 1e-9 ? remTax : Math.min(Math.round(p.qty * netUnit(l)), remTax);
        } else {
          if (!p.amount) throw httpError(400, 'amount is required for value-only notes');
          taxable = paise(p.amount);
          if (taxable > remTax) throw httpError(400, `Amount for ${l.description} exceeds returnable value (${rupees(remTax)})`);
        }
        out.push({ l, qty, taxable });
      }

      // GST on the note mirrors the document: same slab per line, same intra/inter-state split.
      let taxSum = 0, taxableSum = 0;
      for (const o of out) {
        o.tax = Math.round((o.taxable * Number(o.l.gst_pct)) / 100);
        taxSum += o.tax; taxableSum += o.taxable;
      }
      const intra = company.state_code === doc.place_of_supply;
      const half = Math.floor(taxSum / 2);
      const cgst = intra ? half : 0, sgst = intra ? taxSum - half : 0, igst = intra ? 0 : taxSum;
      const total = taxableSum + taxSum;

      // Purchase returns can't send back more goods than are in stock.
      if (b.type === 'goods' && K.stockSign < 0) {
        for (const o of out) {
          const it = (await client.query('SELECT * FROM items WHERE id=$1', [o.l.item_id])).rows[0];
          if (Number(it.stock) < o.qty) throw httpError(400, `Insufficient stock of ${it.name} to return`);
        }
      }

      const seq = (await client.query(`UPDATE companies SET ${K.seq} = ${K.seq} + 1 WHERE id=$1 RETURNING ${K.seq} AS n`, [cid])).rows[0].n;
      const number = `${K.prefix}-${String(seq).padStart(4, '0')}`;
      const note = (await client.query(
        `INSERT INTO notes (company_id,kind,number,${K.fk},party_id,date,reason,return_type,taxable,cgst,sgst,igst,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [cid, kind, number, doc.id, doc.party_id, b.date, b.reason || null, b.type,
          rupees(taxableSum), rupees(cgst), rupees(sgst), rupees(igst), rupees(total)])).rows[0];

      for (const o of out) {
        await client.query(
          `INSERT INTO note_lines (note_id,source_line_id,item_id,description,hsn,qty,rate,gst_pct,taxable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [note.id, o.l.id, o.l.item_id, o.l.description, o.l.hsn, o.qty, Number(o.l.discount) > 0 ? rupees(Math.round(netUnit(o.l))) : o.l.rate, o.l.gst_pct, rupees(o.taxable)]);
        if (b.type === 'goods')
          await client.query('UPDATE items SET stock = stock + $1 WHERE id=$2', [K.stockSign * o.qty, o.l.item_id]);
      }

      const returned = Number(doc.returned) + rupees(total);
      await client.query(`UPDATE ${K.doc} SET returned=$1, status=$2 WHERE id=$3`,
        [returned, settle(doc.total, doc.paid, returned + Number(doc.tds || 0)), doc.id]);
      // Credit note reverses a sale (Dr Sales Returns + Output GST, Cr Debtors); debit note reverses a purchase.
      const tax = { cgst, sgst, igst };
      await post(client, {
        companyId: cid, date: b.date, sourceType: kind === 'credit' ? 'credit_note' : 'debit_note', sourceId: note.id,
        narration: `${kind === 'credit' ? 'Credit' : 'Debit'} note ${number} against ${doc.number}`,
        lines: kind === 'credit'
          ? [{ code: A.SALES_RET, debit: rupees(taxableSum) }, ...taxLines(rupeesOf(tax), 'out', 'debit'),
            { code: A.DEBTORS, credit: rupees(total), partyId: doc.party_id }]
          : [{ code: A.CREDITORS, debit: rupees(total), partyId: doc.party_id }, { code: A.PURCH_RET, credit: rupees(taxableSum) },
            ...taxLines(rupeesOf(tax), 'in', 'credit')],
      });
      await client.query('COMMIT');
      res.status(201).json(note);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  r.get('/returns', h(async (req, res) => {
    const kind = req.query.kind;
    const { rows } = await pool.query(
      `SELECT n.*, p.name AS party_name,
              COALESCE(i.number, b.number) AS doc_number
       FROM notes n JOIN parties p ON p.id=n.party_id
       LEFT JOIN invoices i ON i.id=n.invoice_id LEFT JOIN purchases b ON b.id=n.purchase_id
       WHERE n.company_id=$1 ${kind ? 'AND n.kind=$2' : ''} ORDER BY n.id DESC`,
      kind ? [req.user.companyId, kind] : [req.user.companyId]);
    res.json(rows);
  }));

  r.get('/returns/:id', h(async (req, res) => {
    const n = (await pool.query(
      `SELECT n.*, p.name AS party_name, p.gstin AS party_gstin FROM notes n JOIN parties p ON p.id=n.party_id
       WHERE n.id=$1 AND n.company_id=$2`, [req.params.id, req.user.companyId])).rows[0];
    if (!n) throw httpError(404, 'Not found');
    n.lines = (await pool.query('SELECT * FROM note_lines WHERE note_id=$1 ORDER BY id', [n.id])).rows;
    res.json(n);
  }));

  return r;
}
