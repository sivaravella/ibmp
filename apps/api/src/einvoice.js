// E-invoice (NIC INV-01, version 1.1) and e-way bill payload builders, with the checks the IRP and the e-way bill portal
// apply to the data. Pure functions.
//
// Written from the published NIC schemas without access to the IRP, the e-way bill portal or their validators. The output is
// meant to be reviewed and sent through a GSP; the IRP / portal is the final judge, and `warnings` list known gaps.
import { gstinValid, uqcFor } from './gstin.js';

const P = (n) => Math.round(Number(n) * 100);
const R = (p) => p / 100;
const n2 = (x) => Number(Number(x ?? 0).toFixed(2));
const dmy = (d) => String(d).slice(0, 10).split('-').reverse().join('/');   // IRP and e-way bill date format: dd/mm/yyyy

export const IRP_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
export const EWB_MAX_KM = 4000;
export const VEHICLE_RE = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/;      // e.g. KA01AB1234, TS09EZ0001
export const PIN_RE = /^[1-9]\d{5}$/;
export const DOC_NO_RE = /^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/;
const HSN_RE = /^\d{4,8}$/;
// The September 2025 rate rationalisation retired the 12% and 28% slabs for most goods.
const RETIRED_FROM = '2025-09-22';

/** Per-line tax in paise, split like the rest of the application (an odd paisa goes to SGST). */
function lineAmounts(l, intra) {
  const taxable = P(l.taxable);
  const tax = Math.round((taxable * Number(l.gst_pct)) / 100);
  const cgst = intra ? Math.floor(tax / 2) : 0;
  return { taxable, igst: intra ? 0 : tax, cgst, sgst: intra ? tax - cgst : 0 };
}

function partyChecks(label, p, errors, { requireGstin }) {
  const miss = (what) => errors.push(`${label}: ${what} is required for an e-invoice. ${label === 'Your business' ? 'Add it under Business details.' : 'Add it to the party record.'}`);
  if (!p.addr1 || p.addr1.trim().length < 3) miss('address line 1');
  if (!p.loc || p.loc.trim().length < 3) miss('town / city');
  if (!p.pin) miss('PIN code');
  else if (!PIN_RE.test(p.pin)) errors.push(`${label}: PIN code "${p.pin}" is not a valid 6-digit PIN.`);
  if (requireGstin && !p.gstin) errors.push(`${label}: GSTIN is required.`);
}

/**
 * Build an e-invoice for a sales invoice or a credit note.
 * doc: the invoice / note row (number, date, total, place_of_supply or doc_pos); lines: invoice_lines or note_lines;
 * against: for a credit note, { number, date } of the invoice it refers to; units: Map(item_id -> unit text).
 */
export function buildEinvoice({ type, company, party, doc, lines, against, units, today }) {
  const errors = [], warnings = [];
  const pos = type === 'CRN' ? doc.doc_pos : doc.place_of_supply;
  const intra = pos === company.state_code;

  if (!party.gstin) errors.push('Only B2B documents (the buyer has a GSTIN) can be e-invoiced.');
  else if (!gstinValid(party.gstin)) warnings.push(`The buyer GSTIN ${party.gstin} fails the check-digit test: the IRP will reject it.`);
  if (!company.gstin) errors.push('Your business has no GSTIN.');
  else if (!gstinValid(company.gstin)) warnings.push('Your GSTIN fails the check-digit test: the IRP will reject it.');
  partyChecks('Your business', company, errors, { requireGstin: false });
  partyChecks('The buyer', party, errors, { requireGstin: false });
  if (!DOC_NO_RE.test(doc.number)) errors.push(`Document number "${doc.number}" is not acceptable to the IRP (up to 16 letters, digits, / or -).`);
  if (type === 'CRN' && !against) errors.push('A credit note must refer to the invoice it corrects.');

  const items = lines.map((l, i) => {
    const hsn = String(l.hsn ?? '');
    if (!HSN_RE.test(hsn)) errors.push(`Line ${i + 1} (${l.description}): the HSN/SAC code is missing or invalid.`);
    const rate = Number(l.gst_pct);
    if (!IRP_RATES.includes(rate)) errors.push(`Line ${i + 1} (${l.description}): ${rate}% is not a GST rate the IRP accepts.`);
    if ((rate === 12 || rate === 28) && String(doc.date).slice(0, 10) >= RETIRED_FROM)
      warnings.push(`Line ${i + 1} (${l.description}): the 12% and 28% slabs were retired for most goods from 22 Sep 2025. Check the rate before reporting.`);
    const a = lineAmounts(l, intra);
    const valueOnly = l.qty === null || l.qty === undefined;
    if (valueOnly) warnings.push(`Line ${i + 1} (${l.description}) is a value-only adjustment: it is sent with quantity 1.`);
    const qty = valueOnly ? 1 : Number(l.qty);
    const u = uqcFor(valueOnly || l.item_id == null ? 'NOS' : units.get(l.item_id));      // a charge (freight and so on) has no item
    if (!u.exact) warnings.push(`Unit "${units.get(l.item_id)}" for ${l.description} is not a GST unit code and was sent as OTH.`);
    const sac = hsn.startsWith('99');
    return {
      SlNo: String(i + 1), PrdDesc: l.description, IsServc: sac ? 'Y' : 'N', HsnCd: hsn, Qty: qty, Unit: u.code,
      UnitPrice: valueOnly ? n2(R(a.taxable)) : n2(l.rate), TotAmt: n2(R(valueOnly ? a.taxable : Math.max(a.taxable, Math.round(qty * P(l.rate))))), Discount: n2(R(valueOnly ? 0 : Math.max(0, Math.round(qty * P(l.rate)) - a.taxable))), PreTaxVal: n2(R(a.taxable)), AssAmt: n2(R(a.taxable)),
      GstRt: rate, IgstAmt: n2(R(a.igst)), CgstAmt: n2(R(a.cgst)), SgstAmt: n2(R(a.sgst)), CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0,
      TotItemVal: n2(R(a.taxable + a.igst + a.cgst + a.sgst)), _a: a,
    };
  });
  if (!items.length) errors.push('The document has no lines.');

  const sum = (k) => items.reduce((s, it) => s + it._a[k], 0);
  const ass = sum('taxable'), ig = sum('igst'), cg = sum('cgst'), sg = sum('sgst');
  const computed = ass + ig + cg + sg, total = P(doc.total);
  const round = total - computed;
  if (Math.abs(round) > 100) errors.push(`The document total (₹${R(total)}) differs from its lines by more than ₹1: it cannot be reported as it stands.`);
  for (const it of items) delete it._a;

  const addr = (p) => ({ Addr1: p.addr1 ?? '', ...(p.addr2 ? { Addr2: p.addr2 } : {}), Loc: p.loc ?? '', Pin: Number(p.pin) || 0, Stcd: p.state_code });
  const payload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: type, No: doc.number, Dt: dmy(doc.date) },
    SellerDtls: { Gstin: company.gstin ?? '', LglNm: company.legal_name || company.name, TrdNm: company.trade_name || company.name, ...addr(company), ...(company.phone ? { Ph: company.phone } : {}), ...(company.email ? { Em: company.email } : {}) },
    BuyerDtls: { Gstin: party.gstin ?? '', LglNm: party.name, TrdNm: party.name, Pos: pos, ...addr(party), ...(party.phone ? { Ph: party.phone } : {}), ...(party.email ? { Em: party.email } : {}) },
    ItemList: items,
    ValDtls: { AssVal: n2(R(ass)), CgstVal: n2(R(cg)), SgstVal: n2(R(sg)), IgstVal: n2(R(ig)), CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: n2(R(round)), TotInvVal: n2(R(total)) },
    ...(type === 'CRN' && against ? { RefDtls: { PrecDocDtls: [{ InvNo: against.number, InvDt: dmy(against.date) }] } } : {}),
  };
  if (today && (Date.parse(today) - Date.parse(String(doc.date).slice(0, 10))) / 86400000 > 30)
    warnings.push('This document is more than 30 days old. The IRP can refuse to accept late reporting for larger taxpayers.');
  return { payload, errors, warnings };
}

/** Days an e-way bill stays valid: one per 200 km (20 km for over-dimensional cargo), at least one. */
export const ewbDays = (km, odc = false) => Math.max(1, Math.ceil(km / (odc ? 20 : 200)));

/**
 * Build an e-way bill for a sales invoice of goods.
 * invoice: invoice row; lines: invoice_lines; transport: { mode 1-4, distance, transporterId, transporterName, docNo, docDate, vehicleNo, vehicleType }.
 */
export function buildEwb({ company, party, invoice, lines, units, transport, threshold = 50000 }) {
  const errors = [], warnings = [];
  const t = transport ?? {};
  const intra = invoice.place_of_supply === company.state_code;

  if (!company.gstin) errors.push('Your business has no GSTIN.');
  partyChecks('Your business', company, errors, { requireGstin: false });
  partyChecks('The buyer', party, errors, { requireGstin: false });
  if (party.gstin && !gstinValid(party.gstin)) warnings.push(`The buyer GSTIN ${party.gstin} fails the check-digit test.`);

  const goods = lines.filter((l) => !String(l.hsn ?? '').startsWith('99'));
  if (!goods.length) errors.push('E-way bills are for goods: every line on this invoice is a service.');
  if (R(P(invoice.total)) <= Number(threshold)) warnings.push(`The invoice value (₹${Number(invoice.total)}) is within ₹${Number(threshold)}: an e-way bill is not mandatory (some states set a different limit).`);

  if (![1, 2, 3, 4].includes(t.mode)) errors.push('Choose the mode of transport.');
  const km = Number(t.distance ?? 0);
  if (!Number.isInteger(km) || km < 0 || km > EWB_MAX_KM) errors.push(`Distance must be between 0 and ${EWB_MAX_KM} km (0 lets the portal work it out from the PIN codes).`);
  if (t.vehicleNo && !VEHICLE_RE.test(t.vehicleNo)) errors.push(`Vehicle number "${t.vehicleNo}" is not in the usual format (for example KA01AB1234).`);
  if (t.transporterId && !gstinValid(t.transporterId)) warnings.push(`The transporter ID ${t.transporterId} fails the GSTIN check-digit test.`);
  if (t.mode === 1 && !t.vehicleNo && !t.transporterId) errors.push('For road transport give a vehicle number, or a transporter ID who will add it.');
  if (t.mode && t.mode !== 1 && (!t.docNo || !t.docDate)) errors.push('For rail, air or ship give the transport document number and date.');
  if (!t.vehicleNo && t.transporterId) warnings.push('No vehicle yet: the transporter must add it (Part B) before the goods move.');

  const items = goods.map((l) => {
    const rate = Number(l.gst_pct);
    const u = uqcFor(units.get(l.item_id));
    if (!u.exact) warnings.push(`Unit "${units.get(l.item_id)}" for ${l.description} is not a GST unit code and was sent as OTH.`);
    if (!HSN_RE.test(String(l.hsn ?? ''))) errors.push(`${l.description}: the HSN code is missing or invalid.`);
    return {
      productName: l.description, productDesc: l.description, hsnCode: Number(l.hsn) || 0, quantity: Number(l.qty), qtyUnit: u.code, taxableAmount: n2(l.taxable),
      sgstRate: intra ? rate / 2 : 0, cgstRate: intra ? rate / 2 : 0, igstRate: intra ? 0 : rate, cessRate: 0,
    };
  });

  const gSum = (k) => goods.reduce((s, l) => s + lineAmounts(l, intra)[k], 0);
  const payload = {
    supplyType: 'O', subSupplyType: 1, subSupplyDesc: '', docType: 'INV', docNo: invoice.number, docDate: dmy(invoice.date),
    fromGstin: company.gstin ?? '', fromTrdName: company.trade_name || company.name, fromAddr1: company.addr1 ?? '', fromAddr2: company.addr2 ?? '', fromPlace: company.loc ?? '',
    fromPincode: Number(company.pin) || 0, fromStateCode: Number(company.state_code), actFromStateCode: Number(company.state_code),
    toGstin: party.gstin ?? 'URP', toTrdName: party.name, toAddr1: party.addr1 ?? '', toAddr2: party.addr2 ?? '', toPlace: party.loc ?? '',
    toPincode: Number(party.pin) || 0, toStateCode: Number(party.state_code), actToStateCode: Number(party.state_code),
    transactionType: 1,
    totalValue: n2(R(gSum('taxable'))), cgstValue: n2(R(gSum('cgst'))), sgstValue: n2(R(gSum('sgst'))), igstValue: n2(R(gSum('igst'))), cessValue: 0, totInvValue: n2(invoice.total),
    transMode: t.mode ?? 1, transDistance: km,
    ...(t.transporterId ? { transporterId: t.transporterId, transporterName: t.transporterName ?? '' } : {}),
    ...(t.docNo ? { transDocNo: t.docNo, transDocDate: dmy(t.docDate) } : {}),
    ...(t.vehicleNo ? { vehicleNo: t.vehicleNo, vehicleType: t.vehicleType === 'O' ? 'O' : 'R' } : {}),
    itemList: items,
  };
  if (goods.length !== lines.length) warnings.push('Service lines on this invoice are left out of the e-way bill, which covers goods only. Its value is the goods part.');
  return { payload, errors, warnings };
}
