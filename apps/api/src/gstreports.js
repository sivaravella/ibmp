// GSTR-1 and GSTR-3B summaries. Pure functions over pre-fetched rows; money handled in integer paise.
// Scope: monthly filers, domestic supplies. No exports/SEZ, reverse charge, e-commerce or amendments.

const P = (n) => Math.round(Number(n) * 100);
const R = (p) => p / 100;
const B2CL_LIMIT = P(250000); // inter-state supply to an unregistered person, invoice value above this

const splitTax = (tax, intra) => {
  if (!intra) return { igst: tax, cgst: 0, sgst: 0 };
  const c = Math.floor(tax / 2);
  return { igst: 0, cgst: c, sgst: tax - c };
};
const lineAmt = (l, intra) => {
  const taxable = P(l.taxable);
  const tax = Math.round((taxable * Number(l.gst_pct)) / 100);
  return { taxable, tax, ...splitTax(tax, intra) };
};
const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
const add = (a, b, sign = 1) => {
  a.taxable += sign * b.taxable; a.igst += sign * b.igst; a.cgst += sign * b.cgst; a.sgst += sign * b.sgst;
  return a;
};
const NOT_MONEY = new Set(['rate', 'qty']);
const rup = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && !NOT_MONEY.has(k) ? R(v) : v]));
const hdr = (d) => ({ taxable: P(d.taxable), igst: P(d.igst), cgst: P(d.cgst), sgst: P(d.sgst) });
const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());
const range = (docs) => (docs.length ? { count: docs.length, from: docs[0].number, to: docs[docs.length - 1].number } : { count: 0, from: null, to: null });

/** Which GSTR-1 table a credit note belongs to, decided by the invoice it refers to. */
export function noteTable(n) {
  if (n.party_gstin) return 'cdnr';
  const inter = n.doc_pos !== n.company_state;
  return inter && P(n.doc_total) > B2CL_LIMIT ? 'cdnur' : 'b2cs';
}

export function buildGstr1({ company, period, invoices, invLines, notes, noteLines, items }) {
  const warnings = [];
  if (!company.gstin) warnings.push('Company has no GSTIN on file: GSTR-1 cannot be filed until it is added.');
  const unit = new Map(items.map((i) => [i.id, i.unit]));
  const linesOf = groupBy(invLines, 'invoice_id');
  const nlinesOf = groupBy(noteLines, 'note_id');
  const intraOf = (pos) => pos === company.state_code;

  const b2b = [], b2cl = [];
  const b2cs = new Map();
  const hsn = new Map();
  let missingHsn = 0;

  const bumpHsn = (l, intra, sign) => {
    const a = lineAmt(l, intra);
    const key = l.hsn || 'NA';
    if (!l.hsn) missingHsn++;
    const row = hsn.get(key) ?? { hsn: key, unit: unit.get(l.item_id) ?? 'Nos', qty: 0, ...zero() };
    row.qty += sign * Number(l.qty ?? 0);
    add(row, a, sign);
    hsn.set(key, row);
  };
  const bumpB2cs = (l, pos, sign) => {
    const intra = intraOf(pos);
    const key = `${intra ? 'INTRA' : 'INTER'}|${pos}|${Number(l.gst_pct)}`;
    const row = b2cs.get(key) ?? { type: intra ? 'INTRA' : 'INTER', pos, rate: Number(l.gst_pct), ...zero() };
    add(row, lineAmt(l, intra), sign);
    b2cs.set(key, row);
  };

  for (const inv of invoices) {
    const intra = intraOf(inv.place_of_supply);
    const lines = linesOf.get(inv.id) ?? [];
    const byRate = new Map();
    for (const l of lines) {
      const a = lineAmt(l, intra);
      const r = byRate.get(Number(l.gst_pct)) ?? { rate: Number(l.gst_pct), ...zero() };
      add(r, a);
      byRate.set(r.rate, r);
      bumpHsn(l, intra, 1);
    }
    const row = rup({
      number: inv.number, date: inv.date, party: inv.party_name, ctin: inv.party_gstin, pos: inv.place_of_supply,
      value: P(inv.total), ...hdr(inv),
    });
    row.rates = [...byRate.values()].map(rup);
    if (inv.party_gstin) b2b.push(row);
    else if (!intra && P(inv.total) > B2CL_LIMIT) b2cl.push(row);
    else for (const l of lines) bumpB2cs(l, inv.place_of_supply, 1);
  }

  const cdnr = [], cdnur = [];
  for (const n of notes) {
    const intra = intraOf(n.doc_pos);
    const table = noteTable({ ...n, company_state: company.state_code });
    const lines = nlinesOf.get(n.id) ?? [];
    const byRate = new Map();
    for (const l of lines) {
      bumpHsn(l, intra, -1);
      const x = byRate.get(Number(l.gst_pct)) ?? { rate: Number(l.gst_pct), ...zero() };
      add(x, lineAmt(l, intra));
      byRate.set(x.rate, x);
    }
    const row = rup({
      number: n.number, date: n.date, party: n.party_name, ctin: n.party_gstin, against: n.doc_number, pos: n.doc_pos,
      value: P(n.total), ...hdr(n),
    });
    row.rates = [...byRate.values()].map(rup);
    if (table === 'cdnr') cdnr.push(row);
    else if (table === 'cdnur') cdnur.push(row);
    else for (const l of lines) bumpB2cs(l, n.doc_pos, -1);
  }

  if (missingHsn) warnings.push(`${missingHsn} line(s) have no HSN/SAC code and are grouped under "NA". HSN is mandatory in GSTR-1.`);
  if (!invoices.length && !notes.length) warnings.push('No invoices or credit notes in this period.');

  const totals = zero();
  for (const i of invoices) add(totals, hdr(i));
  for (const n of notes) add(totals, hdr(n), -1);

  return {
    period, company: { name: company.name, gstin: company.gstin, state_code: company.state_code }, warnings,
    b2b, b2cl,
    b2cs: [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate).map(rup),
    cdnr, cdnur,
    hsn: [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)).map((r) => ({ ...rup(r), qty: r.qty })),
    docs: { invoices: range(invoices), credit_notes: range(notes) },
    totals: rup(totals),
  };
}

/** Section 49 set-off: IGST credit first (IGST, CGST, SGST); then CGST credit (CGST, IGST); then SGST credit (SGST, IGST). */
export function setOff(liab, credit) {
  const L = { igst: liab.igst, cgst: liab.cgst, sgst: liab.sgst };
  const C = { igst: credit.igst, cgst: credit.cgst, sgst: credit.sgst };
  const used = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { igst: 0, cgst: 0 }, sgst: { igst: 0, sgst: 0 } };
  const apply = (from, to) => {
    const x = Math.min(C[from], L[to]);
    C[from] -= x; L[to] -= x; used[from][to] += x;
  };
  apply('igst', 'igst'); apply('igst', 'cgst'); apply('igst', 'sgst');
  apply('cgst', 'cgst'); apply('cgst', 'igst');
  apply('sgst', 'sgst'); apply('sgst', 'igst');
  return { used, cash: L, carry_forward: C };
}

export function buildGstr3b({ company, period, invoices, invLines, notes, noteLines, purchases, debitNotes, ledger }) {
  const warnings = [];
  if (!company.gstin) warnings.push('Company has no GSTIN on file: GSTR-3B cannot be filed until it is added.');
  const linesOf = groupBy(invLines, 'invoice_id');
  const nlinesOf = groupBy(noteLines, 'note_id');

  // 3.1(a) rated outward supplies and 3.1(c) nil-rated, net of credit notes. Tax comes from document headers (ties to the ledger).
  const rated = zero();
  let nil = 0;
  const unreg = new Map(); // 3.2: inter-state supplies to unregistered persons, by place of supply
  const bumpUnreg = (pos, taxable, igst, sign) => {
    const r = unreg.get(pos) ?? { pos, taxable: 0, igst: 0 };
    r.taxable += sign * taxable; r.igst += sign * igst;
    unreg.set(pos, r);
  };
  const ratedTaxable = (lines) => lines.filter((l) => Number(l.gst_pct) > 0).reduce((s, l) => s + P(l.taxable), 0);
  const nilTaxable = (lines) => lines.filter((l) => Number(l.gst_pct) === 0).reduce((s, l) => s + P(l.taxable), 0);

  for (const inv of invoices) {
    const lines = linesOf.get(inv.id) ?? [];
    const t = ratedTaxable(lines);
    add(rated, { taxable: t, igst: P(inv.igst), cgst: P(inv.cgst), sgst: P(inv.sgst) });
    nil += nilTaxable(lines);
    if (!inv.party_gstin && inv.place_of_supply !== company.state_code) bumpUnreg(inv.place_of_supply, t, P(inv.igst), 1);
  }
  for (const n of notes) {
    const lines = nlinesOf.get(n.id) ?? [];
    const t = ratedTaxable(lines);
    add(rated, { taxable: t, igst: P(n.igst), cgst: P(n.cgst), sgst: P(n.sgst) }, -1);
    nil -= nilTaxable(lines);
    if (!n.party_gstin && n.doc_pos !== company.state_code) bumpUnreg(n.doc_pos, t, P(n.igst), -1);
  }

  // 4: ITC. Only bills from GST-registered vendors qualify; debit notes against them are reversals.
  const eligible = { igst: 0, cgst: 0, sgst: 0 }, ineligible = { igst: 0, cgst: 0, sgst: 0 }, reversed = { igst: 0, cgst: 0, sgst: 0 };
  const taxOf = (d) => ({ igst: P(d.igst), cgst: P(d.cgst), sgst: P(d.sgst) });
  const sum = (a, b, s = 1) => { a.igst += s * b.igst; a.cgst += s * b.cgst; a.sgst += s * b.sgst; };
  // Bills under reverse charge (the buyer assesses the tax): 3.1(d) liability, claimed back as 4(A)(3) credit, and the tax is paid in cash.
  const rcm = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  for (const b of purchases) { if (b.reverse_charge) { rcm.taxable += P(b.taxable); sum(rcm, taxOf(b)); } else sum(b.party_gstin ? eligible : ineligible, taxOf(b)); }
  for (const d of debitNotes) sum(d.party_gstin ? reversed : ineligible, taxOf(d), d.party_gstin ? 1 : -1);
  const ineligibleBills = purchases.filter((b) => !b.party_gstin && !b.reverse_charge && P(b.cgst) + P(b.sgst) + P(b.igst) > 0).map((b) => b.number);
  if (ineligibleBills.length)
    warnings.push(`ITC not claimed on ${ineligibleBills.join(', ')}: vendor has no GSTIN, so GST charged is not eligible credit.`);

  const itc = { igst: eligible.igst - reversed.igst, cgst: eligible.cgst - reversed.cgst, sgst: eligible.sgst - reversed.sgst };
  const out = { igst: rated.igst, cgst: rated.cgst, sgst: rated.sgst };
  const negative = Object.values(out).some((v) => v < 0) || Object.values(itc).some((v) => v < 0);
  if (negative) warnings.push('A tax head is negative for this period (returns exceed supplies, or reversals exceed ITC). Review before filing; set-off treats negatives as nil.');
  const clamp = (o) => ({ igst: Math.max(o.igst, 0), cgst: Math.max(o.cgst, 0), sgst: Math.max(o.sgst, 0) });
  const itcAll = { igst: itc.igst + rcm.igst, cgst: itc.cgst + rcm.cgst, sgst: itc.sgst + rcm.sgst };       // including the credit on reverse-charge tax
  const so = setOff(clamp(out), clamp(itcAll));
  const cashAll = { igst: so.cash.igst + rcm.igst, cgst: so.cash.cgst + rcm.cgst, sgst: so.cash.sgst + rcm.sgst };       // reverse-charge tax cannot be paid from credit
  const outAll = { igst: out.igst + rcm.igst, cgst: out.cgst + rcm.cgst, sgst: out.sgst + rcm.sgst };

  // Reconcile against the ledger (journal postings dated in the period).
  const led = ledger ?? { output: { igst: 0, cgst: 0, sgst: 0 }, input: { igst: 0, cgst: 0, sgst: 0 } };
  const inRep = { igst: itcAll.igst + ineligible.igst, cgst: itcAll.cgst + ineligible.cgst, sgst: itcAll.sgst + ineligible.sgst };
  const diff = (a, b) => ({ igst: R(a.igst - b.igst), cgst: R(a.cgst - b.cgst), sgst: R(a.sgst - b.sgst) });
  const od = diff(led.output, outAll), id = diff(led.input, inRep);
  const ok = [...Object.values(od), ...Object.values(id)].every((v) => Math.abs(v) < 0.025);
  if (!ok) warnings.push('GST in the ledger does not match the documents for this period. Check manual journals posted to GST accounts.');

  const taxRup = (o) => ({ igst: R(o.igst), cgst: R(o.cgst), sgst: R(o.sgst) });
  const nested = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, taxRup({ igst: 0, cgst: 0, sgst: 0, ...v })]));
  return {
    period, company: { name: company.name, gstin: company.gstin, state_code: company.state_code }, warnings,
    outward: {
      taxable: rup(rated),                                  // 3.1(a)
      nil_rated: { taxable: R(nil) },                       // 3.1(c)
      inward_reverse_charge: rup(rcm),                      // 3.1(d)
      unregistered_interstate: [...unreg.values()].sort((a, b) => a.pos.localeCompare(b.pos)).map(rup), // 3.2
    },
    itc: { available: taxRup(eligible), reversed: taxRup(reversed), ineligible: taxRup(ineligible), reverse_charge: taxRup(rcm), net: taxRup(itcAll) },
    liability: {
      output: taxRup(outAll), reverse_charge: taxRup(rcm), itc_used: nested(so.used),
      cash_payable: taxRup(cashAll), cash_total: R(cashAll.igst + cashAll.cgst + cashAll.sgst),
      itc_carry_forward: taxRup(so.carry_forward),
    },
    reconciliation: { ok, output: { ledger: taxRup(led.output), report: taxRup(outAll), diff: od }, input: { ledger: taxRup(led.input), report: taxRup(inRep), diff: id } },
  };
}
