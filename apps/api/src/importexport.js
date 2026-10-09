// Excel and CSV import of sales invoices and purchase bills: the column layout, reading a sheet into documents, and checking every document.
// Pure logic (no database, no HTTP): the route hands in what the books already hold (ctx) and gets back documents with errors and warnings.
// One row in the file is one line item; rows with the same document number form one document (as in the v6.3 prototype).
import { computeInvoice } from './gst.js';
import { gstinValid, gstinCheckChar } from './gstin.js';
import { STATES } from './states.js';

export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
export const UNITS = ['Nos', 'Pcs', 'Sets', 'Kg', 'Gms', 'Ltr', 'Mtr', 'Box', 'Pkt', 'Bag', 'Ton', 'Hr', 'Day', 'Job'];
export const MAX_ROWS = 5000;

const gstin = (p14) => p14 + gstinCheckChar(p14);

/** The 13 columns, in file order. k = key, h = heading, req = required, al = other headings we accept, d = what the Instructions sheet says. */
export function columnsFor(type) {
  const S = type === 'sales';
  return [
    { k: 'docNo', h: S ? 'Invoice No' : 'Bill No', req: true, width: 16, d: S ? 'Your invoice number. The same number on every line of one invoice. It is used as it is (the invoice series is not used up).' : "The vendor's own bill number. The same number on every line of one bill. Our BILL-number is added automatically.",
      al: S ? ['invoice number', 'inv no', 'invoice', 'voucher no', 'bill no'] : ['bill number', 'supplier invoice no', 'supplier bill no', 'invoice no', 'invoice number', 'voucher no'] },
    { k: 'date', h: S ? 'Invoice Date' : 'Bill Date', req: true, width: 14, d: 'DD-MM-YYYY (an Excel date cell, YYYY-MM-DD and 5-Dec-2025 also work). Past dates are allowed; a month whose GST return is already filed is not.',
      al: ['date', 'voucher date', 'document date', 'invoice date', 'bill date'] },
    { k: 'party', h: S ? 'Customer Name' : 'Vendor Name', req: true, width: 26, d: `Matched to your ${S ? 'customers' : 'vendors'} by name. A new name is added as a new ${S ? 'customer' : 'vendor'}.`,
      al: S ? ['customer', 'party name', 'party', 'buyer', 'buyer name'] : ['vendor', 'supplier', 'supplier name', 'party name', 'party'] },
    { k: 'gstin', h: S ? 'Customer GSTIN' : 'Vendor GSTIN', width: 18, d: '15 characters, checked for format and check digit. Leave blank for an unregistered party.', al: ['gstin', 'gst no', 'gstin/uin', 'gst number'] },
    { k: 'pos', h: 'Place of Supply (State Code)', width: 14, d: S ? '2-digit state code, for example 37 = Andhra Pradesh. Blank: the customer\'s state, else the state in the GSTIN, else your own state. Your own state gives CGST + SGST; any other gives IGST.' : "2-digit state code of the vendor. Blank: the vendor's state, else the state in the GSTIN, else your own state.",
      al: ['place of supply', 'pos', 'state code'] },
    { k: 'item', h: 'Item Name', req: true, width: 28, d: 'Matched to your items by name. A new name is added as a new item.', al: ['item', 'item description', 'description', 'product', 'product name', 'particulars'] },
    { k: 'hsn', h: 'HSN/SAC', width: 12, d: 'Optional, 4 to 8 digits. Taken from the item if blank.', al: ['hsn', 'sac', 'hsn code', 'hsn/sac code'] },
    { k: 'qty', h: 'Quantity', req: true, width: 11, d: 'Greater than 0.', al: ['qty', 'quantity'] },
    { k: 'unit', h: 'Unit', width: 9, d: 'Optional, for example Nos, Kg, Ltr. Used only for a new item.', al: ['uom', 'unit of measure', 'units'] },
    { k: 'rate', h: 'Rate (excl. GST)', req: true, width: 14, d: 'Per unit, before GST. 0 or more.', al: ['rate', 'unit price', 'price', 'rate per unit', 'rate excl gst'] },
    { k: 'disc', h: 'Discount %', width: 11, d: 'Optional, 0 to 100. Taken off before GST.', al: ['discount', 'disc', 'disc %', 'discount percent'] },
    { k: 'gst', h: 'GST Rate %', req: true, width: 11, d: `One of ${GST_RATES.join(', ')}.`, al: ['gst', 'gst %', 'gst rate', 'tax rate', 'tax %', 'rate of tax'] },
    { k: 'narration', h: 'Narration', width: 28, d: S ? 'Optional. Saved as the invoice notes.' : 'Optional. Not saved on a purchase bill.', al: ['remarks', 'notes', 'narration', 'description of supply'] },
  ];
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
const cellText = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** A date as YYYY-MM-DD, or null. Takes a Date, an Excel serial number, DD-MM-YYYY, YYYY-MM-DD, DD/MM/YY, 5-Dec-2025 and 5 December 2025. */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10) : null;
  const s = String(v).trim();
  const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const ok = (y, mo, d) => {
    y = +y; mo = +mo; d = +d; if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) return ok(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) return ok(m[3], m[2], m[1]);
  if ((m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2,4})$/)) && mon[m[2].toLowerCase()]) return ok(m[3], mon[m[2].toLowerCase()], m[1]);
  if (/^\d{5}$/.test(s)) return parseDate(Number(s));
  return null;
}

/** A number from a cell: 1,200 or Rs 1200 or 18% all work; anything else is NaN. */
export function num(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹,\s]|rs\.?/gi, '').replace(/%$/, '');
  return s === '' ? NaN : Number(s);
}

/** Find the heading row (within the first 15 rows, so a title above it is fine) and which column holds what. */
export function detectHeader(type, rows) {
  const C = columnsFor(type);
  let hr = -1, map = null, best = 0;
  for (let i = 0; i < Math.min(15, rows.length); i += 1) {
    const m = {}; let hit = 0;
    (rows[i] ?? []).forEach((cell, j) => {
      const n = norm(cellText(cell).replace(/\*/g, ''));
      if (!n) return;
      const c = C.find((x) => norm(x.h) === n) ?? C.find((x) => x.al.some((a) => norm(a) === n));
      if (c && m[c.k] === undefined) { m[c.k] = j; hit += 1; }
    });
    if (hit > best) { best = hit; hr = i; map = m; }
  }
  return { hr, map, missing: C.filter((c) => c.req && (!map || map[c.k] === undefined)).map((c) => c.h) };
}

/** A state code from a cell: "36", 36, "6" (padded), "36 - Telangana" or a state name. null when it is nothing we know. */
function stateCode(raw) {
  let v = cellText(raw).replace(/\.0+$/, '');
  if (!v) return '';
  const lead = v.match(/^(\d{1,2})(?:\s*[-:]|\s|$)/);
  if (lead) { const c = lead[1].padStart(2, '0'); return c in STATES ? c : null; }
  const low = v.toLowerCase().replace(/&/g, 'and');
  const hit = Object.entries(STATES).find(([, n]) => n.toLowerCase() === low);
  return hit ? hit[0] : null;
}

const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * rows: array of arrays (rows.rowNumbers gives each row's number in the file). ctx:
 *   companyState, today (YYYY-MM-DD),
 *   parties: [{ id, name, gstin, stateCode }]  (customers for sales, vendors for purchases),
 *   items: [{ id, name, gstPct, stock, hsn, unit }],
 *   existing: Set of document keys already in the books (sales: upper-case invoice number; purchases: `${partyId}|${UPPER bill no}`),
 *   locked: (YYYY-MM-DD) => message | null  (a month whose return is filed)
 * Returns { headerRow, documents } where each document has what the commit needs (partyId or newParty, line item ids) and what the preview shows.
 */
export function analyse(type, rows, ctx) {
  const S = type === 'sales';
  const { hr, map, missing } = detectHeader(type, rows);
  if (hr < 0 || missing.length) {
    const e = new Error(`Required column(s) not found: ${(missing.length ? missing : columnsFor(type).filter((c) => c.req).map((c) => c.h)).join(', ')}. Use the headings in the template.`);
    e.status = 400; e.code = 'NO_COLUMNS';
    throw e;
  }
  const rowNo = (i) => rows.rowNumbers?.[i] ?? i + 1;
  const get = (r, k) => (map[k] === undefined ? '' : r[map[k]] ?? '');
  const noun = S ? 'invoice' : 'bill', partyNoun = S ? 'Customer' : 'Vendor';
  const label = (k) => columnsFor(type).find((c) => c.k === k).h;

  // Group the rows into documents.
  const groups = new Map();
  let used = 0;
  for (let i = hr + 1; i < rows.length; i += 1) {
    const r = rows[i] ?? [];
    if (r.every((c) => cellText(c) === '')) continue;
    used += 1;
    if (used > MAX_ROWS) { const e = new Error(`The file has more than ${MAX_ROWS} rows. Split it and import it in parts.`); e.status = 400; throw e; }
    const no = cellText(get(r, 'docNo'));
    // Two vendors can both have a bill number 1, so a bill is told apart by vendor as well.
    const k = no ? (S ? no.toUpperCase() : `${no.toUpperCase()}|${key(get(r, 'party'))}`) : `__blank_${rowNo(i)}`;
    if (!groups.has(k)) groups.set(k, { no, rows: [] });
    groups.get(k).rows.push({ n: rowNo(i), u: used, r });
  }

  const byName = new Map(ctx.parties.map((p) => [key(p.name), p]));
  const byGstin = new Map(ctx.parties.filter((p) => p.gstin).map((p) => [String(p.gstin).toUpperCase(), p]));
  const itemByName = new Map(ctx.items.map((i) => [key(i.name), i]));
  const documents = [];

  for (const g of groups.values()) {
    const D = { no: g.no, date: null, party: '', gstin: '', pos: '', partyId: null, newParty: false, narration: '', lines: [], errors: [], warnings: [], rows: g.rows.map((x) => x.n) };
    const first = g.rows[0], at = (x) => `Row ${x.n}: `;
    if (!g.no) D.errors.push(`${at(first)}${label('docNo')} is blank`);

    // The document-level fields are read from the first line; every other line must agree.
    D.party = cellText(get(first.r, 'party'));
    D.gstin = cellText(get(first.r, 'gstin')).toUpperCase().replace(/\s+/g, '');
    const posRaw = cellText(get(first.r, 'pos'));
    D.narration = cellText(get(first.r, 'narration'));
    const firstDate = parseDate(get(first.r, 'date'));
    for (const x of g.rows.slice(1)) {
      if (key(get(x.r, 'party')) && key(get(x.r, 'party')) !== key(D.party)) D.errors.push(`${at(x)}${label('party')} differs from the first line of this ${noun}`);
      const gv = cellText(get(x.r, 'gstin')).toUpperCase().replace(/\s+/g, '');
      if (gv && gv !== D.gstin) D.errors.push(`${at(x)}${label('gstin')} differs from the first line of this ${noun}`);
      const pv = cellText(get(x.r, 'pos'));
      if (pv && stateCode(pv) !== stateCode(posRaw)) D.errors.push(`${at(x)}Place of Supply differs from the first line of this ${noun}`);
      if (cellText(get(x.r, 'date')) !== '' && parseDate(get(x.r, 'date')) !== firstDate) D.errors.push(`${at(x)}date differs from the first line of this ${noun}`);
    }
    // Lines of one document that are not together usually mean the document was pasted twice.
    const spanned = g.rows[g.rows.length - 1].u - g.rows[0].u + 1;
    if (spanned > g.rows.length) D.warnings.push(`The rows of this ${noun} are not together (rows ${g.rows.map((x) => x.n).join(', ')}). Check that it was not pasted twice.`);

    D.date = firstDate;
    if (!D.date) D.errors.push(`${at(first)}${cellText(get(first.r, 'date')) === '' ? label('date') + ' is blank' : `invalid date "${cellText(get(first.r, 'date'))}" (use DD-MM-YYYY)`}`);
    else {
      if (D.date > ctx.today) D.warnings.push(`Date ${D.date} is in the future`);
      const lock = ctx.locked?.(D.date);
      if (lock) D.errors.push(lock);
    }
    if (!D.party) D.errors.push(`${at(first)}${label('party')} is blank`);

    let gstinOk = false;
    if (D.gstin) {
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(D.gstin)) D.errors.push(`${at(first)}GSTIN "${D.gstin}" is not a valid 15-character GSTIN`);
      else if (!gstinValid(D.gstin)) D.errors.push(`${at(first)}GSTIN "${D.gstin}" fails the GSTIN check digit. Check it for a typing mistake`);
      else gstinOk = true;
    }

    // Who is the party?
    let party = D.party ? byName.get(key(D.party)) : null;
    if (!party && gstinOk) {
      party = byGstin.get(D.gstin) ?? null;
      if (party) D.warnings.push(`GSTIN ${D.gstin} belongs to "${party.name}" in your ${S ? 'customers' : 'vendors'}, so that ${partyNoun.toLowerCase()} is used`);
    }
    if (party) {
      D.partyId = party.id; D.partyName = party.name;
      if (D.gstin && party.gstin && String(party.gstin).toUpperCase() !== D.gstin) D.warnings.push(`GSTIN differs from the one on file for ${party.name} (${party.gstin})`);
    }

    // Place of supply.
    let pos = stateCode(posRaw);
    if (pos === null) { D.errors.push(`${at(first)}Place of Supply "${posRaw}" is not a valid state code`); pos = ''; }
    const gstinState = gstinOk ? D.gstin.slice(0, 2) : '';
    if (!S && party) {
      // A purchase is booked in the vendor's state, so a different state in the file cannot be honoured.
      if (pos && pos !== party.stateCode) D.warnings.push(`Place of Supply ${pos} is ignored: ${party.name} is recorded in state ${party.stateCode}`);
      pos = party.stateCode;
    } else if (!pos) pos = party?.stateCode || gstinState || ctx.companyState;
    D.pos = pos;
    if (gstinState && pos && gstinState !== pos && S) D.warnings.push(`Place of supply ${pos} differs from the GSTIN state ${gstinState}`);
    if (!party && D.party && !D.errors.some((e) => /GSTIN|Place of Supply/.test(e))) {
      D.newParty = true;
      D.partyState = gstinState || pos || ctx.companyState;
      D.warnings.push(`New ${partyNoun.toLowerCase()} "${D.party}" will be created`);
    } else if (!party && D.party) D.newParty = true;      // an error is already recorded; the document will not be imported
    if (D.newParty && !D.partyState) D.partyState = gstinState || pos || ctx.companyState;

    // A document that is already in the books.
    if (g.no) {
      const dupKey = S ? g.no.toUpperCase() : (D.partyId ? `${D.partyId}|${g.no.toUpperCase()}` : null);
      if (dupKey && ctx.existing.has(dupKey)) D.errors.push(S ? `Invoice No ${g.no} already exists in your books` : `Bill No ${g.no} from ${D.partyName} is already recorded`);
    }

    // Lines.
    const calcLines = [], newItemsHere = new Set();
    for (const x of g.rows) {
      const r = x.r;
      const L = { row: x.n, itemId: null, newItem: false };
      L.name = cellText(get(r, 'item')).replace(/\s+/g, ' ');
      L.hsn = cellText(get(r, 'hsn')).replace(/\.0+$/, '');
      L.unit = cellText(get(r, 'unit'));
      L.qty = num(get(r, 'qty')); L.rate = num(get(r, 'rate'));
      L.disc = cellText(get(r, 'disc')) === '' ? 0 : num(get(r, 'disc')); L.gstPct = num(get(r, 'gst'));
      if (!L.name) D.errors.push(`${at(x)}${label('item')} is blank`);
      if (!(L.qty > 0)) D.errors.push(`${at(x)}Quantity must be greater than 0`);
      if (!(L.rate >= 0)) D.errors.push(`${at(x)}Rate must be a number, 0 or more`);
      if (!(L.disc >= 0 && L.disc <= 100)) D.errors.push(`${at(x)}Discount % must be between 0 and 100`);
      if (!GST_RATES.includes(L.gstPct)) D.errors.push(`${at(x)}GST Rate "${cellText(get(r, 'gst'))}" is not a valid GST rate (use ${GST_RATES.join(', ')})`);
      if (L.rate >= 0 && Math.abs(L.rate * 100 - Math.round(L.rate * 100)) > 1e-6) { L.rate = r2(L.rate); D.warnings.push(`${at(x)}Rate was rounded to 2 decimals`); }
      const it = L.name ? itemByName.get(key(L.name)) : null;
      if (it) {
        L.itemId = it.id; L.name = it.name; L.itemRef = it;
        if (!L.hsn) L.hsn = it.hsn ?? '';
        if (GST_RATES.includes(L.gstPct) && it.gstPct !== null && it.gstPct !== undefined && Number(it.gstPct) !== L.gstPct) D.warnings.push(`${at(x)}GST ${L.gstPct}% differs from the item "${it.name}" (${Number(it.gstPct)}%). The rate in your file is used`);
      } else if (L.name) {
        L.newItem = true; L.unit = L.unit || 'Nos';
        if (!newItemsHere.has(key(L.name))) { newItemsHere.add(key(L.name)); D.warnings.push(`New item "${L.name}" will be created${S ? ' (its stock will show below zero until you record a purchase)' : ''}`); }
      }
      if (L.hsn && !/^\d{4,8}$/.test(L.hsn)) D.warnings.push(`${at(x)}HSN/SAC "${L.hsn}" should be 4 to 8 digits`);
      D.lines.push(L);
      if (L.qty > 0 && L.rate >= 0 && GST_RATES.includes(L.gstPct) && L.disc >= 0 && L.disc <= 100) calcLines.push({ qty: L.qty, rate: L.rate, gst_pct: L.gstPct, discount_pct: L.disc });
    }

    // The amounts are worked out exactly as the screens and the API do it.
    const stateFrom = ctx.companyState, stateTo = pos || ctx.companyState;
    const calc = computeInvoice(calcLines, stateFrom, stateTo);
    Object.assign(D, { taxable: calc.taxable, cgst: calc.cgst, sgst: calc.sgst, igst: calc.igst, gst: r2(calc.cgst + calc.sgst + calc.igst), total: calc.total });
    D.status = D.errors.length ? 'error' : 'ok';
    documents.push(D);
  }

  // Selling more than the stock the books hold (counting everything else in this file) is allowed, with a warning.
  if (S) {
    const need = new Map();
    for (const d of documents) if (d.status === 'ok') for (const l of d.lines) if (l.itemRef) need.set(l.itemRef.id, (need.get(l.itemRef.id) ?? 0) + l.qty);
    const warned = new Set();
    for (const d of documents) if (d.status === 'ok') for (const l of d.lines) {
      if (l.itemRef && !warned.has(l.itemRef.id) && need.get(l.itemRef.id) > Number(l.itemRef.stock ?? 0)) {
        warned.add(l.itemRef.id);
        d.warnings.push(`Stock of "${l.itemRef.name}" is ${Number(l.itemRef.stock ?? 0)}, less than the ${need.get(l.itemRef.id)} sold in this file. Stock will go below zero`);
      }
    }
  }
  for (const d of documents) if (d.status === 'ok' && d.warnings.length) d.status = 'warning';
  return { headerRow: rowNo(hr), documents };
}

/** What the preview shows for one document (no line ids or internals). */
export const publicDoc = (d) => ({
  no: d.no, date: d.date, party: d.partyName || d.party, gstin: d.gstin, placeOfSupply: d.pos, lines: d.lines.length,
  taxable: d.taxable, cgst: d.cgst, sgst: d.sgst, igst: d.igst, gst: d.gst, total: d.total,
  status: d.status, errors: d.errors, warnings: d.warnings, rows: d.rows, newParty: d.newParty,
});

export const summarise = (docs) => ({
  documents: docs.length,
  ok: docs.filter((d) => d.status === 'ok').length,
  warnings: docs.filter((d) => d.status === 'warning').length,
  errors: docs.filter((d) => d.status === 'error').length,
  lines: docs.filter((d) => d.status !== 'error').reduce((s, d) => s + d.lines.length, 0),
  taxable: r2(docs.filter((d) => d.status !== 'error').reduce((s, d) => s + d.taxable, 0)),
  gst: r2(docs.filter((d) => d.status !== 'error').reduce((s, d) => s + d.gst, 0)),
  total: r2(docs.filter((d) => d.status !== 'error').reduce((s, d) => s + d.total, 0)),
});

/** The rows of the error report: one per message, errors first for each document. */
export function errorReportRows(docs) {
  const out = [['Document No', 'Excel Row(s)', 'Status', 'Message']];
  for (const d of docs) {
    for (const e of d.errors) out.push([d.no, d.rows.join(' '), 'Error', e]);
    for (const w of d.warnings) out.push([d.no, d.rows.join(' '), 'Warning', w]);
  }
  return out;
}

const SAMPLES = {
  sales: [
    ['INV-IMP-001', '05-12-2025', 'Ravi Auto Parts', gstin('36ABCDE1234F1Z'), '36', 'Cylinder Liner - 80mm', '84099100', 10, 'Nos', 1200, 0, 18, 'Sample: 2 lines, 1 invoice'],
    ['INV-IMP-001', '05-12-2025', 'Ravi Auto Parts', gstin('36ABCDE1234F1Z'), '36', 'Piston Ring Set', '84099900', 4, 'Sets', 850, 5, 18, ''],
    ['INV-IMP-002', '06-12-2025', 'Sai Enterprises', gstin('29XYZPQ5678G1Z'), '29', 'Technical Consulting', '998313', 3, 'Hr', 5000, 0, 18, 'In another state, so IGST'],
  ],
  purchases: [
    ['SUP/2025/101', '03-12-2025', 'Steel India Pvt Ltd', gstin('36STEEF5432G1Z'), '36', 'Cylinder Liner - 90mm', '84099100', 50, 'Nos', 1100, 0, 18, 'Sample: 2 lines, 1 bill'],
    ['SUP/2025/101', '03-12-2025', 'Steel India Pvt Ltd', gstin('36STEEF5432G1Z'), '36', 'Piston Ring Set', '84099900', 100, 'Sets', 600, 2, 18, ''],
    ['NFC/7781', '04-12-2025', 'National Freight Corp', gstin('07NATFR3210H1Z'), '07', 'Freight Charges', '996511', 1, 'Job', 12500, 0, 12, 'In another state, so IGST'],
  ],
};
export const sampleRows = (type) => SAMPLES[type];

/** The sheets of the template workbook: the data sheet first (it is the one that is read back), then the instructions and the lists. */
export function templateSheets(type, companyState) {
  const S = type === 'sales', C = columnsFor(type);
  const numFmt = { qty: '#,##0.###', rate: '#,##0.00', disc: '0.##', gst: '0.##' };
  const sheets = [{
    name: S ? 'Sales' : 'Purchases',
    columns: C.map((c) => ({ header: c.h + (c.req ? ' *' : ''), key: c.k, width: c.width, numFmt: numFmt[c.k] })),
    rows: sampleRows(type).map((r) => Object.fromEntries(C.map((c, i) => [c.k, r[i]]))),
  }, {
    name: 'Instructions',
    title: `${S ? 'Sales invoice' : 'Purchase bill'} import: field guide`,
    columns: [{ header: 'Column', key: 'c', width: 30 }, { header: 'Required', key: 'q', width: 11 }, { header: 'Format and rules', key: 'd', width: 100 }],
    rows: C.map((c) => ({ c: c.h, q: c.req ? 'Yes' : 'No', d: c.d })),
    notes: [
      'One row per item line. Rows with the same document number form one document.',
      'Date, party, GSTIN and place of supply must be the same on every line of a document.',
      `CGST + SGST apply when the place of supply is your own state${companyState ? ` (${companyState})` : ''}; any other state gives IGST. Taxable value, tax and totals are worked out for you.`,
      S ? 'An invoice number that already exists in your books is rejected (no duplicates).' : 'A bill number that is already recorded for the same vendor is rejected (no duplicates).',
      'Delete the sample rows before importing your own data.',
    ],
  }, {
    name: 'Lists',
    columns: [{ header: 'GST Rate %', key: 'g', width: 12 }, { header: 'State Code', key: 's', width: 12 }, { header: 'State', key: 'n', width: 38 }, { header: 'Unit', key: 'u', width: 10 }],
    rows: Array.from({ length: Math.max(GST_RATES.length, Object.keys(STATES).length, UNITS.length) }, (_, i) => {
      const code = Object.keys(STATES)[i];
      return { g: GST_RATES[i], s: code, n: code ? STATES[code] : undefined, u: UNITS[i] };
    }),
  }];
  return sheets;
}
