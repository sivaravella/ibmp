// GSTN return JSON builders. They turn the report data (gstreports.js) into the structure of the GST portal's offline
// utility / GSP "save" payloads for GSTR-1 and GSTR-3B.
//
// Written from the published GSTN return schema without access to a live GSP or the portal's validator. Treat the output as
// ready for review and upload to the offline tool, and expect the portal or GSP to be the final judge. Known gaps are listed
// in `warnings` on every build rather than hidden.
import { gstinValid, uqcFor } from './gstin.js';

const n2 = (x) => Number(Number(x ?? 0).toFixed(2));
export const fp = (period) => `${period.slice(5, 7)}${period.slice(0, 4)}`;           // 2026-09 -> 092026
const dmy = (d) => String(d).slice(0, 10).split('-').reverse().join('-');             // 2026-09-10 -> 10-09-2026

const group = (rows, key) => rows.reduce((m, r) => (m.has(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());

/** Rate-wise item rows for a document; zero-rated lines go to the nil table, not here. */
const items = (rates, shape) => rates.filter((r) => r.rate > 0)
  .map((r, i) => ({ num: i + 1, itm_det: shape(r) }));
const itemFull = (r) => ({ rt: r.rate, txval: n2(r.taxable), iamt: n2(r.igst), camt: n2(r.cgst), samt: n2(r.sgst), csamt: 0 });
const itemInter = (r) => ({ rt: r.rate, txval: n2(r.taxable), iamt: n2(r.igst), csamt: 0 });

/**
 * GSTR-1. g1 = buildGstr1() output; turnover = { prior, current } aggregate turnover (rupees) from IBMP's own records.
 * Returns { payload, warnings }.
 */
export function buildGstr1Json(g1, { gstin, period, turnover }) {
  const warnings = [];
  const home = g1.company.state_code;

  // 4A/4B: B2B invoices, grouped by recipient. Invoices with only nil-rated lines are reported in the nil table instead.
  const b2b = [...group(g1.b2b, 'ctin')].map(([ctin, invs]) => ({
    ctin,
    inv: invs.map((i) => ({ inum: i.number, idt: dmy(i.date), val: n2(i.value), pos: i.pos, rchrg: 'N', inv_typ: 'R', itms: items(i.rates, itemFull) }))
      .filter((i) => i.itms.length),
  })).filter((g) => g.inv.length);

  // 5: B2C large, grouped by place of supply.
  const b2cl = [...group(g1.b2cl, 'pos')].map(([pos, invs]) => ({
    pos,
    inv: invs.map((i) => ({ inum: i.number, idt: dmy(i.date), val: n2(i.value), itms: items(i.rates, itemInter) })).filter((i) => i.itms.length),
  })).filter((g) => g.inv.length);

  // 7: B2C small: consolidated; intra-state rows carry CGST+SGST, inter-state rows IGST.
  const b2cs = g1.b2cs.filter((r) => r.rate > 0 && (r.taxable || r.igst || r.cgst || r.sgst)).map((r) => ({
    sply_ty: r.type, pos: r.pos, typ: 'OE', rt: r.rate, txval: n2(r.taxable),
    ...(r.type === 'INTER' ? { iamt: n2(r.igst) } : { camt: n2(r.cgst), samt: n2(r.sgst) }), csamt: 0,
  }));

  // 9B: credit notes to registered recipients, and to unregistered recipients of B2C-large invoices.
  const cdnr = [...group(g1.cdnr, 'ctin')].map(([ctin, notes]) => ({
    ctin,
    nt: notes.map((x) => ({ ntty: 'C', nt_num: x.number, nt_dt: dmy(x.date), val: n2(x.value), pos: x.pos, rchrg: 'N', inv_typ: 'R', itms: items(x.rates, itemFull) })).filter((x) => x.itms.length),
  })).filter((g) => g.nt.length);
  const cdnur = g1.cdnur.map((x) => ({ typ: 'B2CL', ntty: 'C', nt_num: x.number, nt_dt: dmy(x.date), val: n2(x.value), pos: x.pos, itms: items(x.rates, itemInter) })).filter((x) => x.itms.length);

  // 8: nil-rated supplies, by whether the recipient is registered and whether the supply crosses a state border.
  const nilTotals = { INTRB2B: 0, INTRB2C: 0, INTRAB2B: 0, INTRAB2C: 0 };
  const nilOf = (rates) => rates.filter((r) => r.rate === 0).reduce((s, r) => s + r.taxable, 0);
  for (const i of g1.b2b) nilTotals[i.pos === home ? 'INTRAB2B' : 'INTRB2B'] += nilOf(i.rates);
  for (const i of g1.b2cl) nilTotals.INTRB2C += nilOf(i.rates);
  for (const r of g1.b2cs.filter((x) => x.rate === 0)) nilTotals[r.type === 'INTRA' ? 'INTRAB2C' : 'INTRB2C'] += r.taxable;
  const nilRows = Object.entries(nilTotals).filter(([, v]) => v).map(([sply_ty, v]) => ({ sply_ty, expt_amt: 0, nil_amt: n2(v), ngsup_amt: 0 }));
  if (nilRows.length) warnings.push('Zero-rated lines are reported as nil-rated. Exempt and non-GST supplies are not told apart from nil-rated ones: review table 8 before filing.');

  // 12: HSN summary.
  const hsn = g1.hsn.filter((h) => h.qty || h.taxable).map((h, i) => {
    const u = uqcFor(h.unit);
    if (!u.exact) warnings.push(`Unit "${h.unit}" for HSN ${h.hsn} is not a GST unit code and was reported as OTH.`);
    return { num: i + 1, hsn_sc: h.hsn, uqc: u.code, qty: n2(h.qty), val: n2(h.taxable + h.igst + h.cgst + h.sgst), txval: n2(h.taxable), iamt: n2(h.igst), camt: n2(h.cgst), samt: n2(h.sgst), csamt: 0 };
  });
  if (g1.hsn.some((h) => h.hsn === 'NA')) warnings.push('Some supplies have no HSN/SAC code (shown as NA). The portal will reject an invalid HSN.');

  // 13: documents issued.
  const docs = [];
  if (g1.docs.invoices.count) docs.push({ doc_num: 1, docs: [{ num: 1, from: g1.docs.invoices.from, to: g1.docs.invoices.to, totnum: g1.docs.invoices.count, cancel: 0, net_issue: g1.docs.invoices.count }] });
  if (g1.docs.credit_notes.count) docs.push({ doc_num: 5, docs: [{ num: 1, from: g1.docs.credit_notes.from, to: g1.docs.credit_notes.to, totnum: g1.docs.credit_notes.count, cancel: 0, net_issue: g1.docs.credit_notes.count }] });

  const payload = {
    gstin, fp: fp(period), gt: n2(turnover.prior), cur_gt: n2(turnover.current),
    ...(b2b.length && { b2b }), ...(b2cl.length && { b2cl }), ...(b2cs.length && { b2cs }),
    ...(cdnr.length && { cdnr }), ...(cdnur.length && { cdnur }),
    ...(nilRows.length && { nil: { inv: nilRows } }),
    ...(hsn.length && { hsn: { data: hsn } }),
    ...(docs.length && { doc_issue: { doc_det: docs } }),
  };
  warnings.push('Aggregate turnover (gt, cur_gt) is computed from invoices recorded in IBMP only. Check it against your filed returns.');
  return { payload, warnings };
}

/** GSTR-3B. g3 = buildGstr3b() output. Returns { payload, warnings }. */
export function buildGstr3bJson(g3, { gstin, period }) {
  const warnings = [];
  const o = g3.outward, i = g3.itc;
  const z = { iamt: 0, camt: 0, samt: 0, csamt: 0 };
  const tax = (x) => ({ iamt: n2(x.igst), camt: n2(x.cgst), samt: n2(x.sgst), csamt: 0 });
  const itc = (ty, x) => ({ ty, ...(x ? tax(x) : z) });
  const types = (target, ty) => ['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH'].map((t) => (t === ty ? itc(t, target) : itc(t)));

  const payload = {
    gstin, ret_period: fp(period),
    sup_details: {
      osup_det: { txval: n2(o.taxable.taxable), iamt: n2(o.taxable.igst), camt: n2(o.taxable.cgst), samt: n2(o.taxable.sgst), csamt: 0 },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: n2(o.nil_rated.taxable) },
      isup_rev: { txval: 0, ...z },
      osup_nongst: { txval: 0 },
    },
    inter_sup: {
      unreg_details: o.unregistered_interstate.filter((r) => r.taxable || r.igst).map((r) => ({ pos: r.pos, txval: n2(r.taxable), iamt: n2(r.igst) })),
      comp_details: [], uin_details: [],
    },
    itc_elg: {
      itc_avl: types(i.available, 'OTH'),
      itc_rev: [itc('RUL'), itc('OTH', i.reversed)],
      itc_net: tax(i.net),
      itc_inelg: [itc('RUL'), itc('OTH', i.ineligible)],
    },
    inward_sup: { isup_details: [{ ty: 'GST', inter: 0, intra: 0 }, { ty: 'NONGST', inter: 0, intra: 0 }] },
    intr_ltfee: { intr_details: { ...z } },
  };
  warnings.push('Table 5 (exempt, nil-rated and non-GST inward supplies) and interest or late fee are not populated.');
  warnings.push('ITC is reported under "all other ITC" only: imports, reverse charge and ISD credit are not tracked.');
  return { payload, warnings };
}

/** GSTIN check-digit problems among the recipients in a GSTR-1 payload (the portal rejects these). */
export function badRecipientGstins(g1) {
  const seen = new Set();
  for (const r of [...g1.b2b, ...g1.cdnr]) if (r.ctin && !gstinValid(r.ctin)) seen.add(r.ctin);
  return [...seen];
}
