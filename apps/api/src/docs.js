// Creating a sales invoice or a purchase bill, shared by the screens (routes/invoices.js, routes/purchases.js) and the Excel import.
// Both run inside the caller's transaction: the caller opens it, commits it and rolls it back.
import { httpError } from './util.js';
import { computeInvoice } from './gst.js';
import { assertPeriodOpen } from './filing-lock.js';
import { A, post, taxLines } from './ledger.js';
import { fyOf, parseFy } from './compliance.js';

/**
 * b: { partyId, date, dueDate?, reference?, notes?, shipTo?, charges?, discountPct?, dispatchedThrough?, destination?, paymentTerms?, otherRefs?, placeOfSupply?,
 *      lines: [{ itemId, qty, rate?, discountPct?, description?, gstPct?, hsn?, unit? }] }
 * opts (imports only): number = the invoice number to use instead of the next one in the series (the series is not touched);
 *   allowShortStock = do not refuse a sale that takes stock below zero; the shortfalls are pushed to opts.warnings.
 */
export async function createInvoice(client, cid, b, opts = {}) {
  await assertPeriodOpen(client, cid, ['GSTR1', 'GSTR3B'], b.date, 'sales invoice');
  const company = (await client.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
  const party = (await client.query(
    "SELECT * FROM parties WHERE id=$1 AND company_id=$2 AND type='customer'", [b.partyId, cid])).rows[0];
  if (!party) throw httpError(400, 'Unknown customer');

  const lines = [];
  for (const l of b.lines) {
    const it = (await client.query('SELECT * FROM items WHERE id=$1 AND company_id=$2', [l.itemId, cid])).rows[0];
    if (!it) throw httpError(400, `Unknown item ${l.itemId}`);
    if (Number(it.stock) < l.qty) {
      if (!opts.allowShortStock) throw httpError(400, `Insufficient stock for ${it.name}`);
      opts.warnings?.push(`Stock of ${it.name} is below the quantity sold`);
    }
    lines.push({ item: it, qty: l.qty, rate: l.rate ?? Number(it.rate), gst_pct: l.gstPct ?? Number(it.gst_pct), discount_pct: l.discountPct ?? 0, description: l.description ?? it.name, hsn: l.hsn || it.hsn, unit: l.unit || it.unit });
  }
  // Freight, packing and the like: extra lines without an item, taxed at the highest rate of the goods (see computeInvoice).
  for (const c of b.charges ?? []) lines.push({ item: null, charge: true, hsn: c.hsn ?? '9965', qty: 1, rate: c.amount, gst_pct: 0, discount_pct: 0, description: c.label });
  if (b.dueDate && b.dueDate < b.date) throw httpError(400, 'The due date cannot be before the invoice date.');
  const pos = b.placeOfSupply ?? party.state_code;       // the state the supply is made in decides CGST+SGST or IGST
  const dueDate = b.dueDate === undefined ? (Number(company.payment_days) > 0 ? new Date(Date.parse(b.date) + Number(company.payment_days) * 86400000).toISOString().slice(0, 10) : null) : b.dueDate;
  const calc = computeInvoice(lines, company.state_code, pos, b.discountPct ?? 0);

  let number;
  if (opts.number) {
    if ((await client.query('SELECT 1 FROM invoices WHERE company_id=$1 AND number=$2', [cid, opts.number])).rowCount) throw httpError(409, `Invoice number ${opts.number} already exists`);
    number = opts.number;
  } else {
    const prefix = company.invoice_prefix || 'INV';
    if (company.invoice_numbering === 'financial_year') {
      // One counter per financial year, started from the invoices already issued in that year so a company that switches mid-year carries on.
      const fy = fyOf(b.date), s0 = parseFy(fy);
      const seq = (await client.query(
        `INSERT INTO invoice_sequences (company_id, fy, seq)
         VALUES ($1, $2, (SELECT count(*) FROM invoices WHERE company_id=$1 AND date >= $3 AND date <= $4) + 1)
         ON CONFLICT (company_id, fy) DO UPDATE SET seq = invoice_sequences.seq + 1 RETURNING seq`, [cid, fy, `${s0}-04-01`, `${s0 + 1}-03-31`])).rows[0].seq;
      number = `${prefix}/${fy.slice(2)}/${String(seq).padStart(4, '0')}`;
    } else {
      const seq = (await client.query('UPDATE companies SET invoice_seq = invoice_seq + 1 WHERE id=$1 RETURNING invoice_seq', [cid])).rows[0].invoice_seq;
      number = `${prefix}-${String(seq).padStart(4, '0')}`;
    }
  }
  const inv = (await client.query(
    `INSERT INTO invoices (company_id,party_id,number,date,place_of_supply,taxable,cgst,sgst,igst,total,due_date,reference,notes,ship_to,discount,dispatched_through,destination,payment_terms,other_refs,discount_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [cid, party.id, number, b.date, pos, calc.taxable, calc.cgst, calc.sgst, calc.igst, calc.total, dueDate, b.reference || null, b.notes || null, b.shipTo || null, calc.discount, b.dispatchedThrough || null, b.destination || null, b.paymentTerms || null, b.otherRefs || null, b.discountPct ?? 0])).rows[0];

  for (const l of calc.lines) {
    await client.query(
      `INSERT INTO invoice_lines (invoice_id,item_id,description,hsn,qty,rate,gst_pct,taxable,discount_pct,discount,cgst,sgst,igst,unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [inv.id, l.item?.id ?? null, l.description, l.hsn, l.qty, l.rate, l.gst_pct, l.taxable, l.discount_pct, l.discount, l.cgst, l.sgst, l.igst, l.item ? l.unit : 'OTH']);
    if (l.item) await client.query('UPDATE items SET stock = stock - $1 WHERE id=$2', [l.qty, l.item.id]);
  }
  await post(client, {
    companyId: cid, date: b.date, sourceType: 'invoice', sourceId: inv.id, narration: `Sales invoice ${number}`,
    lines: [
      { code: A.DEBTORS, debit: calc.total, partyId: party.id },
      { code: A.SALES, credit: calc.taxable },
      ...taxLines(calc, 'out', 'credit'),
    ],
  });
  return inv;
}

/**
 * b: { partyId, supplierBillNo, date, reverseCharge?, lines: [{ itemId, qty, rate, gstPct?, discountPct?, hsn? }] }
 * A line's discount (imports only) comes off before tax, as on a sales invoice; the line keeps the gross rate.
 */
export async function createPurchase(client, cid, b) {
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
    lines.push({ item: it, qty: l.qty, rate: l.rate, gst_pct: l.gstPct ?? Number(it.gst_pct), discount_pct: l.discountPct ?? 0, hsn: l.hsn || it.hsn });
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
      [bill.id, l.item.id, l.item.name, l.hsn, l.qty, l.rate, l.gst_pct, l.taxable]);
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
  return bill;
}
