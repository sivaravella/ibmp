// GST maths in integer paise to avoid float drift.
const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;

export const stateFromGstin = (g) => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** lines: [{qty, rate, gst_pct}] -> totals. Intra-state splits GST into CGST+SGST, inter-state is IGST. */
export function computeInvoice(lines, sellerState, placeOfSupply) {
  let taxable = 0, tax = 0;
  const out = lines.map((l) => {
    const t = Math.round(Number(l.qty) * paise(l.rate));
    taxable += t;
    tax += Math.round((t * Number(l.gst_pct)) / 100);
    return { ...l, taxable: rupees(t) };
  });
  const intra = sellerState === placeOfSupply;
  const half = Math.floor(tax / 2);
  const cgst = intra ? half : 0;
  const sgst = intra ? tax - half : 0;
  const igst = intra ? 0 : tax;
  return {
    lines: out,
    taxable: rupees(taxable),
    cgst: rupees(cgst),
    sgst: rupees(sgst),
    igst: rupees(igst),
    total: rupees(taxable + tax),
  };
}
