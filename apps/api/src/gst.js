// GST maths in integer paise to avoid float drift.
const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;

export const stateFromGstin = (g) => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Share an invoice's CGST between its lines so the lines add up to the invoice exactly. The invoice splits its total tax in half
 * (an odd paisa goes to SGST); each line gets half its own tax, and the paise that rounding leaves over go to lines with an odd tax.
 * taxes: tax of each line in paise. Returns [{ cgst, sgst }] in paise.
 */
export function splitLineTax(taxes) {
  const total = taxes.reduce((s, t) => s + t, 0);
  const cgstTotal = Math.floor(total / 2);
  const out = taxes.map((t) => ({ cgst: Math.floor(t / 2), sgst: 0 }));
  let left = cgstTotal - out.reduce((s, x) => s + x.cgst, 0);
  for (let i = 0; i < taxes.length && left > 0; i++) if (taxes[i] % 2 === 1) { out[i].cgst += 1; left -= 1; }
  out.forEach((x, i) => { x.sgst = taxes[i] - x.cgst; });
  return out;
}

/**
 * lines: [{qty, rate, gst_pct, discount_pct?}] -> totals. Intra-state splits GST into CGST+SGST, inter-state is IGST.
 * A line's discount is taken off qty x rate and the tax is charged on what is left. Each returned line carries its discount,
 * taxable value and tax split (lines add up to the invoice totals exactly).
 */
export function computeInvoice(lines, sellerState, placeOfSupply) {
  const intra = sellerState === placeOfSupply;
  let taxable = 0, tax = 0, discount = 0;
  const parts = lines.map((l) => {
    const gross = Math.round(Number(l.qty) * paise(l.rate));
    const disc = Math.min(gross, Math.round((gross * Number(l.discount_pct ?? 0)) / 100));
    const t = gross - disc;
    const lineTax = Math.round((t * Number(l.gst_pct)) / 100);
    taxable += t; tax += lineTax; discount += disc;
    return { l, t, disc, lineTax };
  });
  const split = splitLineTax(parts.map((p) => p.lineTax));
  const out = parts.map((p, i) => ({
    ...p.l, taxable: rupees(p.t), discount: rupees(p.disc),
    cgst: intra ? rupees(split[i].cgst) : 0, sgst: intra ? rupees(split[i].sgst) : 0, igst: intra ? 0 : rupees(p.lineTax),
  }));
  const half = Math.floor(tax / 2);
  const cgst = intra ? half : 0;
  const sgst = intra ? tax - half : 0;
  const igst = intra ? 0 : tax;
  return {
    lines: out,
    taxable: rupees(taxable),
    discount: rupees(discount),
    cgst: rupees(cgst),
    sgst: rupees(sgst),
    igst: rupees(igst),
    total: rupees(taxable + tax),
  };
}
