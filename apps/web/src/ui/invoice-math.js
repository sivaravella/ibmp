// The invoice maths used for the live preview. It mirrors the server's computeInvoice (apps/api/src/gst.js) step for step, in integer
// paise, so the preview shows exactly what will be saved. A test in the API suite compares the two on random invoices.
const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;

/** Share the invoice's CGST between its lines so they add up exactly (an odd paisa goes to SGST). taxes: per-line tax in paise. */
export function splitLineTax(taxes) {
  const total = taxes.reduce((s, t) => s + t, 0);
  const cgstTotal = Math.floor(total / 2);
  const out = taxes.map((t) => ({ cgst: Math.floor(t / 2), sgst: 0 }));
  let left = cgstTotal - out.reduce((s, x) => s + x.cgst, 0);
  for (let i = 0; i < taxes.length && left > 0; i++) if (taxes[i] % 2 === 1) { out[i].cgst += 1; left -= 1; }
  out.forEach((x, i) => { x.sgst = taxes[i] - x.cgst; });
  return out;
}

/** lines: [{ qty, rate, gstPct, discountPct }]. Returns the totals and each line with its discount, taxable value and tax split. */
export function computeDraft(lines, sellerState, placeOfSupply, totalDiscountPct = 0) {
  const intra = !!sellerState && sellerState === placeOfSupply;
  let taxable = 0, tax = 0, discount = 0;
  const parts = lines.map((l) => {
    const gross = Math.round(Number(l.qty || 0) * paise(l.rate || 0));
    const own = Math.min(gross, Math.round((gross * Number(l.discountPct || 0)) / 100));
    const disc = Math.min(gross, own + Math.round(((gross - own) * Number(totalDiscountPct || 0)) / 100));
    const t = gross - disc;
    const lineTax = Math.round((t * Number(l.gstPct || 0)) / 100);
    taxable += t; tax += lineTax; discount += disc;
    return { l, gross, t, disc, lineTax };
  });
  const split = splitLineTax(parts.map((p) => p.lineTax));
  const half = Math.floor(tax / 2);
  return {
    intra,
    lines: parts.map((p, i) => ({
      ...p.l, gross: rupees(p.gross), discount: rupees(p.disc),
      ...(Number(totalDiscountPct) > 0 ? { discountPct: p.gross > 0 ? Math.round((p.disc / p.gross) * 100000) / 1000 : 0 } : {}), taxable: rupees(p.t),
      cgst: intra ? rupees(split[i].cgst) : 0, sgst: intra ? rupees(split[i].sgst) : 0, igst: intra ? 0 : rupees(p.lineTax),
    })),
    taxable: rupees(taxable), discount: rupees(discount), cgst: intra ? rupees(half) : 0, sgst: intra ? rupees(tax - half) : 0, igst: intra ? 0 : rupees(tax), total: rupees(taxable + tax),
  };
}

/** The tax summary by HSN/SAC and rate, as printed under the lines. */
export function taxSummary(lines) {
  const m = new Map();
  for (const l of lines) {
    const k = `${l.hsn ?? ''}|${Number(l.gstPct)}`;
    const x = m.get(k) ?? { hsn: l.hsn ?? '', rate: Number(l.gstPct), taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    x.taxable += paise(l.taxable); x.cgst += paise(l.cgst); x.sgst += paise(l.sgst); x.igst += paise(l.igst);
    m.set(k, x);
  }
  return [...m.values()].map((x) => ({ hsn: x.hsn, rate: x.rate, taxable: rupees(x.taxable), cgst: rupees(x.cgst), sgst: rupees(x.sgst), igst: rupees(x.igst), tax: rupees(x.cgst + x.sgst + x.igst) }));
}

/** A Bill of Supply replaces the tax invoice when nothing on it carries tax (all lines exempt or nil-rated). */
export const isBillOfSupply = (lines) => lines.length > 0 && lines.every((l) => Number(l.gstPct) === 0);

export const addDaysIso = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
