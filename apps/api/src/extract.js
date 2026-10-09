// Reads a registration document (text PDF) and returns the business details printed on it, for the sign-up wizard.
// Supported: GST registration certificate (REG-06), Certificate of Incorporation (company or LLP) and MCA master data.
// Photos and scans are not read (no OCR): the caller is told so and the person types the details instead.
// The files are parsed in memory only: nothing is stored and the text is never logged.
// The label-based parsing is ported from the reference prototype (IBMP_App_v6.3.html, _rcExtract) and made tolerant of the two layouts
// a PDF text layer produces: "Label : value" on one line, or the label on one line and the value on the next. Nothing is guessed:
// a value is returned only when it was read from the document and passes the same format rules the business profile applies.
import { parseGstin } from './gstin-lookup.js';
import { PIN_RE } from './einvoice.js';
import { PAN_RE } from './tds.js';
import { STATES } from './states.js';
import { httpError } from './util.js';

const MAX_PAGES = 15;
const MAX_CHARS = 300_000;
const PARSE_TIMEOUT_MS = 15_000;

export const KIND_LABELS = { gst: 'GST registration certificate', coi: 'Certificate of Incorporation', mca: 'MCA master data' };
export const UNSUPPORTED_MESSAGE = 'We can read text PDFs. For a photo or scan please type the details in the next steps.';

export const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 1024).includes('%PDF-');

// ---------------------------------------------------------------------------------------------------------------- PDF to text

let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

/** All the text of a PDF, one line per visual line (a new line starts when the vertical position changes). Throws a 400 for a PDF that cannot be read. */
export async function pdfToText(buffer, { timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: false });
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'ParseTimeout' })), timeoutMs); });
  const work = (async () => {
    const doc = await task.promise;
    let out = '';
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= pages && out.length < MAX_CHARS; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      let lastY = null, endX = null;
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        const x = it.transform[4], y = it.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { out += '\n'; endX = null; }
        else if (endX !== null && x - endX > 1 && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
        out += it.str;
        if (it.hasEOL) { out += '\n'; lastY = null; endX = null; continue; }
        lastY = y; endX = x + (it.width || 0);
      }
      out += '\n';
    }
    return out.slice(0, MAX_CHARS);
  })();
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    work.catch(() => {});
    if (e?.name === 'PasswordException') throw httpError(400, 'This PDF is password protected. Remove the password and upload it again, or type the details in the next steps.');
    if (e?.name === 'ParseTimeout') throw httpError(400, 'This PDF took too long to read. Please type the details in the next steps.');
    throw httpError(400, 'We could not read this PDF. It may be damaged. Please upload it again, or type the details in the next steps.');
  } finally {
    clearTimeout(timer);
    task.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------- helpers

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const NOTHING = /^(n\/?a|na|nil|none|not applicable|not available|-+|\.+)$/i;
const val = (s) => { const v = clean(s); return !v || NOTHING.test(v) ? '' : v; };

/** The text after a label, up to the next stopper (or `max` characters). */
function after(flat, labelRe, stopRe, max = 120) {
  const m = labelRe.exec(flat);
  if (!m) return '';
  let rest = flat.slice(m.index + m[0].length).replace(/^[\s:.\-]+/, '');
  const s = stopRe ? stopRe.exec(rest) : null;
  if (s) rest = rest.slice(0, s.index);
  return val(rest.slice(0, max));
}
const NEXT_ITEM = String.raw`\s+\d{1,2}\s*\.\s+[A-Z]`;           // "2. Trade Name": the next numbered item of a form

const GSTIN_FIND = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
const CIN_RE = /^[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{2,3}\d{6}$/;
const CIN_FIND = /\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{2,3}\d{6})\b/;
const LLPIN_RE = /^[A-Z]{2,4}-\d{3,6}$/;
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

const isoDate = (d, m, y) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1850 && y <= 2100 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
};
/** dd/mm/yyyy or dd-mm-yyyy to YYYY-MM-DD ('' when it is not a real date). */
const dmy = (s) => { const m = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/.exec(s ?? ''); return m ? isoDate(+m[1], +m[2], +m[3]) : ''; };

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty first', 'twenty second', 'twenty third', 'twenty fourth', 'twenty fifth', 'twenty sixth', 'twenty seventh', 'twenty eighth', 'twenty ninth', 'thirtieth', 'thirty first'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "Two thousand twenty-six" -> 2026, "Nineteen hundred and ninety-five" -> 1995 (null when it is not such a phrase). */
function yearFromWords(phrase) {
  const w = String(phrase).toLowerCase().replace(/-/g, ' ').split(/\s+/).filter((x) => x && x !== 'and');
  let base = 0, i = 0;
  if (w[0] === 'two' && w[1] === 'thousand') { base = 2000; i = 2; }
  else if (w[0] === 'nineteen' && w[1] === 'hundred') { base = 1900; i = 2; }
  else if (w[0] === 'one' && w[1] === 'thousand' && w[2] === 'nine' && w[3] === 'hundred') { base = 1900; i = 4; }
  else return null;
  let n = 0;
  for (; i < w.length; i++) {
    if (TENS[w[i]]) n += TENS[w[i]]; else if (UNITS[w[i]]) n += UNITS[w[i]]; else return null;
  }
  return n <= 99 ? base + n : null;
}
/** "Twelfth day of September Two thousand twenty-six" -> '2026-09-12'. */
function dateFromWords(dayWords, monthWord, yearWords) {
  const d = ORDINALS.indexOf(String(dayWords).toLowerCase().replace(/-/g, ' ').trim()) + 1;
  const m = MONTHS.indexOf(String(monthWord).toLowerCase()) + 1;
  const y = yearFromWords(yearWords);
  return d && m && y ? isoDate(d, m, y) : '';
}

// States, matched by name in running text.
const norm = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/\([^)]*\)/g, ' ').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STATE_NAMES = [
  ...Object.entries(STATES).filter(([c]) => !['28', '97', '99'].includes(c)).map(([c, n]) => [norm(n), c]),
  ['orissa', '21'], ['pondicherry', '34'], ['new delhi', '07'], ['nct of delhi', '07'], ['dadra and nagar haveli', '26'], ['daman and diu', '26'], ['andaman and nicobar', '35'],
].sort((a, b) => b[0].length - a[0].length);
/** The state code for the first state name found in the text, or null. */
export function stateCodeFromText(text) {
  const n = ` ${norm(text)} `;
  for (const [name, code] of STATE_NAMES) if (n.includes(` ${name} `)) return { code, name };
  return null;
}

/** Fit address parts into the two address lines of the profile (100 characters each). */
function packAddress(parts) {
  const out = ['', ''];
  let i = 0;
  for (const p of parts.map(clean).filter(Boolean)) {
    const cand = out[i] ? `${out[i]}, ${p}` : p;
    if (cand.length <= 100) { out[i] = cand; continue; }
    if (i === 0) { i = 1; out[1] = p.slice(0, 100); } else break;
  }
  return { addr1: out[0] || undefined, addr2: out[1] || undefined };
}

/** Split a postal address printed as one string ("FLAT 4, ROAD 2, KONDAPUR, HYDERABAD, Telangana-500084 India") into the profile's fields. */
export function parseFreeAddress(text) {
  let s = clean(text);
  if (!s) return {};
  const out = {};
  const pins = [...s.matchAll(/(?<!\d)([1-9]\d{5})(?!\d)/g)];
  if (pins.length) { const last = pins[pins.length - 1]; out.pin = last[1]; s = clean(s.slice(0, last.index) + ' ' + s.slice(last.index + 6)); }
  const st = stateCodeFromText(s);
  if (st) {
    out.stateCode = st.code;
    // drop the state's name from the address (it has its own field)
    const re = new RegExp(`[\\s,\\-]*\\b${st.name.split(' ').join('[\\s.&]+(?:and[\\s.&]+)?')}\\b[\\s,\\-]*`, 'i');
    const t = s.replace(re, ', ');
    if (t !== s) s = t;
  }
  s = s.replace(/[\s,\-]*\bIndia\b[\s,\-]*/gi, ' ').replace(/[\s,\-]+$/g, '').replace(/^[\s,]+/, '');
  const parts = s.split(/\s*,\s*/).map(clean).filter((p) => p && !/^[-.]+$/.test(p));
  if (parts.length >= 2) { out.loc = parts.pop().slice(0, 50); }
  Object.assign(out, packAddress(parts));
  return out;
}

const ENTITY_FROM_CONSTITUTION = [
  [/limited liability partnership|\bllp\b/i, 'llp'], [/one person/i, 'opc'], [/private limited/i, 'private_limited'], [/public limited|\blimited company\b/i, 'public_limited'],
  [/partnership/i, 'partnership'], [/proprietor/i, 'proprietorship'], [/hindu undivided|\bhuf\b/i, 'huf'], [/society|club|\baop\b/i, 'society'], [/\btrust\b/i, 'trust'],
  [/government|statutory body|local authority|public sector|foreign|body corporate|unlimited/i, 'other'],
];
/** Our entity type for a constitution text and/or the legal name ("(OPC)", "PRIVATE LIMITED", "LLP" endings). */
export function entityTypeFrom(constitution, legalName) {
  const name = clean(legalName).toUpperCase();
  if (/\(OPC\)|\bOPC\b|ONE PERSON COMPANY/.test(name)) return 'opc';
  if (/\bLLP\b|LIMITED LIABILITY PARTNERSHIP$/.test(name)) return 'llp';
  for (const [re, type] of ENTITY_FROM_CONSTITUTION) if (constitution && re.test(constitution)) return type;
  if (/PRIVATE LIMITED$|PVT\.? LTD\.?$|\(P\) LTD\.?$/.test(name)) return 'private_limited';
  if (/LIMITED$|LTD\.?$/.test(name)) return 'public_limited';
  return undefined;
}

const DESIGNATION = String.raw`(?:(?:Additional|Managing|Whole[- ]time|Nominee|Alternate|Independent|ADDITIONAL|MANAGING|NOMINEE|ALTERNATE|INDEPENDENT)\s+)?(?:Director|DIRECTOR|Designated Partner|DESIGNATED PARTNER|Partner|PARTNER)`;

// ---------------------------------------------------------------------------------------------------------------- parsers
// Each parser gets { flat, lines }: the text on one line, and the text as lines. They return raw candidates; `finish` validates.

/** GST registration certificate, Form GST REG-06. */
export function parseGst({ flat }) {
  const r = { notes: [] };
  // GSTIN: the "Registration Number" first, then any GSTIN in the text. The first with a correct check character wins.
  const cands = [];
  const lab = /Registration Number\s*:?\s*(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])/.exec(flat);
  if (lab) cands.push(lab[1]);
  for (const m of flat.matchAll(GSTIN_FIND)) if (!cands.includes(m[1])) cands.push(m[1]);
  if (cands.length) {
    const good = cands.find((g) => parseGstin(g).checkOk);
    if (good) r.gstin = good; else r.notes.push('The GSTIN printed in the file did not pass the check-digit test, so it was left out. Please type it in.');
  }
  r.legalName = after(flat, /Legal Name/i, new RegExp(`\\s+(?:\\d{1,2}\\s*\\.\\s*)?Trade Name|${NEXT_ITEM}`), 120);
  r.tradeName = after(flat, /Trade Name\s*,?\s*if any/i, new RegExp(`\\s+(?:\\d{1,2}\\s*\\.\\s*)?Additional trade|${NEXT_ITEM}`), 120)
    || after(flat, /Trade Name(?!s)/i, new RegExp(`\\s+(?:\\d{1,2}\\s*\\.\\s*)?Additional trade|${NEXT_ITEM}`), 120);
  r.constitution = after(flat, /Constitution of Business/i, new RegExp(`${NEXT_ITEM}|\\s+Particulars of|\\s+Date of|\\s+Type of|\\s+Period of`), 80);
  r.registrationDate = dmy(after(flat, /Date of Liability/i, null, 25))
    || dmy(after(flat, /Period of Validity\s*:?\s*From/i, null, 25)) || dmy(after(flat, /Date of Registration/i, null, 25)) || undefined;

  // The principal place of business: "Label : value" pairs between "Address of Principal Place of Business" and the next form item.
  const start = /Address of Principal Place of Business/i.exec(flat);
  let block = start ? flat.slice(start.index + start[0].length) : flat;
  const end = /\s+(?:\d{1,2}\s*\.\s*)?(?:Date of (?:Liability|Registration)|Constitution of Business)/i.exec(block);
  if (end) block = block.slice(0, end.index);
  const LABELS = /(Floor No\.?|Building No\.?\s*\/?\s*Flat No\.?|Name Of Premises\s*\/?\s*Building|Road\s*\/\s*Street|Landmark|Block\s*\/?\s*Tower|Door No\.?|Locality\s*\/?\s*Sub Locality|City\s*\/\s*Town\s*\/\s*Locality\s*\/\s*Village|City\s*\/\s*Town|District|State|PIN Code|Pincode)\s*:/gi;
  const hits = [...block.matchAll(LABELS)];
  const f = {};
  hits.forEach((m, i) => {
    const key = m[1].toLowerCase();
    const v = val(block.slice(m.index + m[0].length, i + 1 < hits.length ? hits[i + 1].index : m.index + m[0].length + 60));
    const k = key.startsWith('floor') ? 'floor' : key.startsWith('building') || key.startsWith('door') ? 'building' : key.startsWith('name of') ? 'premises' : key.startsWith('road') ? 'road'
      : key.startsWith('landmark') ? 'landmark' : key.startsWith('block') ? 'block' : key.startsWith('city') || key.startsWith('locality') ? 'city' : key.startsWith('district') ? 'district'
        : key.startsWith('state') ? 'state' : 'pin';
    if (v && !(k in f)) f[k] = v;
  });
  // Some certificates print the address as one line instead of "Label : value" pairs.
  if (!hits.length && start && block.trim()) {
    Object.assign(r, parseFreeAddress(block.slice(0, 240)));
  } else {
    if (f.pin) r.pin = (/\d{6}/.exec(f.pin) || [])[0];
    if (f.state) { const s = stateCodeFromText(f.state); if (s) r.stateCode = s.code; }
    const cityParts = f.city ? f.city.split(',').map(clean).filter(Boolean) : [];
    const loc = cityParts.length ? cityParts.pop() : f.district;
    if (loc) r.loc = loc.slice(0, 50);
    const floor = f.floor && !/floor/i.test(f.floor) ? `Floor ${f.floor}` : f.floor;
    Object.assign(r, packAddress([floor, f.building, f.premises, f.block, f.road, f.landmark, ...cityParts]));
  }

  // Annexure B: "Name VIKRAM CHANDUPATLA Designation/Status DIRECTOR Resident of State Telangana"
  const dirs = [];
  for (const m of flat.matchAll(/Name\s+([A-Z][A-Z .'-]+?)\s+Designation\s*\/?\s*Status\s+([A-Za-z ]{2,40}?)(?=\s+Resident|\s+\d|\s+Name\b|\s+Photo|$)/g)) {
    const name = clean(m[1]);
    if (!dirs.some((d) => d.name === name)) dirs.push({ name, designation: clean(m[2]) });
  }
  if (dirs.length) r.directors = dirs;
  return r;
}

/** Certificate of Incorporation of a company (Form INC-11 / SPICe) or an LLP (Form 16). */
export function parseCoi({ flat, lines }) {
  const r = { notes: [] };
  const isLlp = /LLP Identification Number|Limited Liability Partnership|Form 16\b/i.test(flat);
  r.legalName = val((/certif(?:y|ied)\s+that\s+(.{3,150}?)\s+is\s+incorporated/i.exec(flat) || [])[1]);
  if (isLlp) {
    r.cin = (/(?:LLP Identification Number|LLPIN)\s*(?:\(LLPIN\))?\s*[:.]?\s*([A-Z]{2,4}-\d{3,6})/i.exec(flat) || [])[1]?.toUpperCase();
  } else {
    r.cin = (new RegExp(String.raw`Corporate Identity Number[\s\S]{0,60}?(?<![A-Z0-9])([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{2,3}\d{6})(?![A-Z0-9])`).exec(flat) || CIN_FIND.exec(flat) || [])[1];
  }
  const labelled = (label, re) => { const i = flat.search(label); return i < 0 ? undefined : (re.exec(flat.slice(i, i + 160)) || [])[1]; };
  r.pan = labelled(/Permanent Account Number/i, /(?<![A-Z0-9])([A-Z]{5}\d{4}[A-Z])(?![A-Z0-9])/) || (/(?<![A-Z0-9])([A-Z]{5}\d{4}[A-Z])\*/.exec(flat) || [])[1];
  r.tan = labelled(/Tax Deduction/i, /(?<![A-Z0-9])([A-Z]{4}\d{5}[A-Z])(?![A-Z0-9])/) || (/(?<![A-Z0-9])([A-Z]{4}\d{5}[A-Z])\*/.exec(flat) || [])[1];
  // "incorporated on this Twelfth day of September Two thousand twenty-six under ..."
  const w = /incorporated on this\s+([A-Za-z -]{3,25}?)\s+day of\s+([A-Za-z]{3,9})\s+([A-Za-z -]{3,60}?)\s+(?:under|and that|the )/i.exec(flat);
  r.incorporatedOn = (w && dateFromWords(w[1], w[2], w[3])) || dmy(after(flat, /Date of Incorporation/i, null, 25)) || undefined;
  // The mailing address block: the lines after "Mailing Address", with the company's own name line left out, up to the PIN code.
  const idx = lines.findIndex((l) => /(?:Mailing|Registered)\s+Address/i.test(l));
  if (idx >= 0) {
    const first = lines[idx].replace(/^.*?(?:Mailing|Registered)\s+Address[^:]*:?/i, '');
    const got = [];
    if (/\S/.test(first) && /[A-Za-z0-9]{3}/.test(first) && !/^\s*(?:of|as per|for)\b/i.test(first)) got.push(first);
    for (let i = idx + 1; i < lines.length && got.length < 7; i++) {
      if (/^(?:\*|Disclaimer|This is a system|Digitally signed|Registrar|Note\b|Page \d|Given under|Form )/i.test(lines[i])) break;
      got.push(lines[i]);
      if (/(?<!\d)[1-9]\d{5}(?!\d)/.test(lines[i])) break;
    }
    const nameKey = norm(r.legalName || '');
    if (got.length > 1 && nameKey && norm(got[0]) === nameKey) got.shift();
    else if (got.length && nameKey && norm(got[0]).startsWith(nameKey) && got[0].length > nameKey.length + 5) got[0] = got[0].slice(r.legalName.length);
    Object.assign(r, parseFreeAddress(got.join(', ')));
  }
  return r;
}

/** MCA company (or LLP) master data. */
export function parseMca({ flat, lines }) {
  const r = { notes: [] };
  r.cin = (/\bCIN\b\s*:?\s*([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{2,3}\d{6})/i.exec(flat) || CIN_FIND.exec(flat) || [])[1]?.toUpperCase();
  if (!r.cin) r.cin = (/\bLLPIN\b\s*:?\s*([A-Z]{2,4}-\d{3,6})/i.exec(flat) || [])[1]?.toUpperCase();
  r.legalName = after(flat, /(?:Company|LLP) Name/i, new RegExp(String.raw`\s+(?:ROC Code|Registration Number|Company (?:Category|Sub)|Class of|Date of|Category|Authori[sz]ed|Registered Address|LLP Status|Number of)|${NEXT_ITEM}`), 120);
  const em = /Email(?:\s*(?:Id|ID|Address))?\s*:?\s*([A-Za-z0-9._%+\-]+(?:\[at\]|\(at\)|@)[A-Za-z0-9.\-]+(?:\[dot\]|\(dot\)|\.)[A-Za-z]{2,}(?:(?:\[dot\]|\(dot\)|\.)[A-Za-z]{2,})*)/i.exec(flat);
  if (em) r.email = em[1].replace(/\[at\]|\(at\)/gi, '@').replace(/\[dot\]|\(dot\)/gi, '.').toLowerCase();
  r.incorporatedOn = dmy(after(flat, /Date of Incorporation/i, null, 25)) || undefined;
  // The registered address wraps over several lines: join them with commas (unless a line already ends in one), up to the PIN code.
  const STOP = /^(?:Address other than|Whether Listed|Listed in|Email|Category of Company|Authori[sz]ed Capital|Date of last AGM|Number of Members|Date of Balance|Company status)/i;
  const idx = lines.findIndex((l) => /^Registered Address/i.test(l));
  if (idx >= 0) {
    const got = [];
    const head = lines[idx].replace(/^Registered Address\s*:?\s*/i, '');
    if (head) got.push(head);
    for (let i = idx + 1; i < lines.length && got.length < 8; i++) {
      if (STOP.test(lines[i])) break;
      got.push(lines[i]);
    }
    let rest = got.reduce((s, l) => (s ? `${s}${/,\s*$/.test(s) ? ' ' : ', '}${l}` : l), '');
    const cut = /\s+(?:Address other than|Whether Listed|Listed in|Email|Category of Company|Authori[sz]ed Capital)/i.exec(rest);
    if (cut) rest = rest.slice(0, cut.index);
    const pins = [...rest.matchAll(/(?<!\d)([1-9]\d{5})(?!\d)/g)];
    if (pins.length) { const p = pins[pins.length - 1]; rest = rest.slice(0, p.index + 6); }
    Object.assign(r, parseFreeAddress(rest));
  }
  // Directors: "1 11943123 SANDYARANI KYAVERI Director Promoter" (DIN, name, designation)
  const dirs = [];
  const re = new RegExp(String.raw`(?<!\d)(\d{8})(?!\d)\s+([A-Z][A-Z .'-]*?[A-Z])\s+(${DESIGNATION})(?![A-Za-z])`, 'g');
  for (const m of flat.matchAll(re)) {
    const name = clean(m[2]);
    if (!dirs.some((d) => d.din === m[1])) dirs.push({ name, din: m[1], designation: clean(m[3]).replace(/^([A-Z])([A-Z]+)/, (_, a, b) => a + b.toLowerCase()) });
  }
  if (dirs.length) r.directors = dirs;
  return r;
}

const PARSERS = { gst: parseGst, coi: parseCoi, mca: parseMca };

/** What kind of registration document a text looks like (used when the stated kind finds nothing). */
export function detectKind(flat) {
  if (/GST REG-06|Registration Certificate|Goods and Services Tax/i.test(flat)) return 'gst';
  if (/Certificate of Incorporation/i.test(flat)) return 'coi';
  if (/Master Data/i.test(flat)) return 'mca';
  return null;
}

/** Keep only values that were read and pass the profile's format rules. */
function finish(raw) {
  const f = {};
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') f[k] = v; };
  const notes = [...(raw.notes ?? [])];
  const g = raw.gstin ? parseGstin(raw.gstin) : null;
  if (g?.formatOk && g.checkOk) { put('gstin', g.gstin); put('pan', g.pan); put('stateCode', g.stateCode); }
  if (raw.pan && PAN_RE.test(raw.pan) && !f.pan) put('pan', raw.pan);
  if (raw.pan && f.pan && raw.pan !== f.pan) notes.push('The PAN in the file differs from the PAN inside the GSTIN, so the one inside the GSTIN was used.');
  put('legalName', raw.legalName?.slice(0, 100));
  put('tradeName', raw.tradeName?.slice(0, 100));
  put('constitution', raw.constitution);
  put('entityType', entityTypeFrom(raw.constitution, raw.legalName) ?? (raw.cin && LLPIN_RE.test(raw.cin) ? 'llp' : undefined));
  put('addr1', raw.addr1); put('addr2', raw.addr2); put('loc', raw.loc);
  if (raw.pin && PIN_RE.test(raw.pin)) put('pin', raw.pin);
  if (!f.stateCode && raw.stateCode && raw.stateCode in STATES) put('stateCode', raw.stateCode);
  put('registrationDate', raw.registrationDate);
  if (raw.cin && (CIN_RE.test(raw.cin) || LLPIN_RE.test(raw.cin))) put('cin', raw.cin);
  put('incorporatedOn', raw.incorporatedOn);
  if (raw.tan && TAN_RE.test(raw.tan)) put('tan', raw.tan);
  if (raw.email && EMAIL_RE.test(raw.email) && raw.email.length <= 120) put('email', raw.email);
  if (/^[6-9]\d{9}$/.test(raw.phone ?? '')) put('phone', raw.phone);
  if (raw.directors?.length) put('directors', raw.directors.slice(0, 30).map((d) => ({ name: d.name.slice(0, 80), ...(d.din ? { din: d.din } : {}), ...(d.designation ? { designation: d.designation.slice(0, 40) } : {}) })));
  return { found: f, notes };
}

/** Parse the text of a document of the stated kind. Returns { kind, found, notes }. */
export function parseDocument(kind, text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
  const ctx = { lines, flat: lines.join(' ') };
  let used = kind;
  let res = finish(PARSERS[kind](ctx));
  if (Object.keys(res.found).length < 2) {
    const other = detectKind(ctx.flat);
    if (other && other !== kind) {
      const alt = finish(PARSERS[other](ctx));
      if (Object.keys(alt.found).length > Object.keys(res.found).length) { res = alt; used = other; }
    }
  }
  // a phone number is only taken when the document labels it
  const ph = /(?:Mobile|Phone|Contact)\s*(?:No\.?|Number)?\s*:?\s*(?:\+?91[- ]?)?([6-9]\d{9})(?!\d)/i.exec(ctx.flat);
  if (ph && !res.found.phone) res.found.phone = ph[1];
  return { kind: used, ...res };
}

/** The whole job for an upload: bytes in, the response of POST /v1/onboarding/extract out. */
export async function readDocument({ buffer, kind }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'No file was received. Please choose a PDF and try again.');
  if (!isPdf(buffer)) return { kind, supported: false, found: {}, message: UNSUPPORTED_MESSAGE };
  const text = await pdfToText(buffer);
  if (clean(text).length < 20) return { kind, supported: false, found: {}, message: 'This PDF has no readable text (it looks like a scan). Please type the details in the next steps.' };
  const { kind: used, found, notes } = parseDocument(kind, text);
  const n = Object.keys(found).filter((k) => k !== 'directors').length;
  let message;
  if (!n) message = 'We could not find the usual details in this file. Please check that it is the right document, or type the details in the next steps.';
  else message = `Read ${n} detail${n === 1 ? '' : 's'} from your ${KIND_LABELS[used]}.${used !== kind ? ` (This looks like a ${KIND_LABELS[used]}, not a ${KIND_LABELS[kind]}.)` : ''} Please check them in the next steps.`;
  if (notes.length) message += ` ${notes.join(' ')}`;
  return { kind: used, supported: true, found, message };
}
