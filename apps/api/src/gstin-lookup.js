// What we can learn from a GSTIN, in two layers:
//   1. parseGstin(): everything the number itself says (format, check character, state, PAN, kind of taxpayer). Always available, offline.
//   2. a taxpayer lookup (legal name, trade name, status, address) from a provider, when one is configured. The GST portal's own
//      search needs a captcha, so a server cannot call it directly; a GST data provider's API (or a GSP) is needed. Without one the
//      screen says so plainly and the person types the name.
import { GSTIN_RE } from './gst.js';
import { gstinCheckChar } from './gstin.js';
import { stateName } from './states.js';

// 4th character of a PAN: the kind of taxpayer.
const PAN_KIND = {
  P: 'Individual or proprietor', C: 'Company', H: 'Hindu undivided family', F: 'Partnership firm or LLP', A: 'Association of persons', B: 'Body of individuals',
  G: 'Government', J: 'Artificial juridical person', L: 'Local authority', T: 'Trust',
};

/** Everything that can be read from the number alone. Never throws. */
export function parseGstin(input) {
  const gstin = String(input ?? '').trim().toUpperCase();
  const out = { gstin, formatOk: GSTIN_RE.test(gstin), checkOk: false, stateCode: null, stateName: null, pan: null, panKind: null, entityNo: null };
  if (!out.formatOk) return out;
  out.checkOk = gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
  out.stateCode = gstin.slice(0, 2);
  out.stateName = stateName(out.stateCode);
  out.pan = gstin.slice(2, 12);
  out.panKind = PAN_KIND[out.pan[3]] ?? null;
  out.entityNo = gstin[12];                // how many registrations this PAN holds in the state (1 = the first)
  return out;
}

const first = (...v) => v.find((x) => x !== undefined && x !== null && String(x).trim() !== '');
const clean = (v) => (v === undefined || v === null ? null : String(v).replace(/\s+/g, ' ').trim() || null);

/** Map the several shapes GST data providers return (GSTN field names or friendlier ones) onto one. */
export function normaliseTaxpayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.taxpayerInfo ?? raw.taxpayer ?? raw.data ?? raw.result ?? raw;
  const legalName = clean(first(t.lgnm, t.legalName, t.legal_name, t.legalNameOfBusiness));
  const tradeName = clean(first(t.tradeNam, t.tradeName, t.trade_name));
  if (!legalName && !tradeName) return null;
  const pr = t.pradr ?? t.principalPlace ?? t.address ?? {};
  const a = pr.addr ?? pr;
  const flat = typeof a === 'string' ? a : first(pr.adr, t.adr, null);
  const building = [first(a.bno, a.buildingNo), first(a.bnm, a.buildingName), first(a.flno, a.floorNo)].filter(Boolean).join(', ');
  const street = [first(a.st, a.street), first(a.loc, a.locality)].filter(Boolean).join(', ');
  const city = clean(first(a.dst, a.district, a.city, a.loc, a.location));
  const pin = clean(first(a.pncd, a.pincode, a.pin, a.postalCode));
  return {
    legalName, tradeName,
    status: clean(first(t.sts, t.status, t.gstStatus)),
    constitution: clean(first(t.ctb, t.constitution, t.constitutionOfBusiness)),
    taxpayerType: clean(first(t.dty, t.taxpayerType)),
    registeredOn: clean(first(t.rgdt, t.registrationDate, t.registeredOn)),
    addr1: clean(building) ?? clean(typeof flat === 'string' ? flat.split(',').slice(0, 2).join(',') : null),
    addr2: clean(street),
    loc: city,
    pin: pin && /^\d{6}$/.test(pin) ? pin : null,
  };
}

/**
 * A provider { name, lookup(gstin) -> normalised taxpayer | null } from the environment, or null when none is configured.
 *   IBMP_GSTIN_LOOKUP=appyflow  with IBMP_GSTIN_LOOKUP_KEY   (https://appyflow.in, key secret)
 *   IBMP_GSTIN_LOOKUP=custom    with IBMP_GSTIN_LOOKUP_URL, e.g. https://api.example.com/gst/{gstin}?key={key} and IBMP_GSTIN_LOOKUP_KEY,
 *                               optional IBMP_GSTIN_LOOKUP_AUTH_HEADER (a header name that carries the key instead of the URL)
 */
export function resolveGstinLookup(env = {}, fetchFn = globalThis.fetch) {
  const kind = String(env.GSTIN_LOOKUP ?? env.IBMP_GSTIN_LOOKUP ?? '').toLowerCase();
  const key = env.GSTIN_LOOKUP_KEY ?? env.IBMP_GSTIN_LOOKUP_KEY;
  if (!kind || !key) return null;
  let urlFor, headers = {};
  if (kind === 'appyflow') urlFor = (g) => `https://appyflow.in/api/verifyGST?gstNo=${encodeURIComponent(g)}&key_secret=${encodeURIComponent(key)}`;
  else if (kind === 'custom') {
    const tpl = env.GSTIN_LOOKUP_URL ?? env.IBMP_GSTIN_LOOKUP_URL;
    if (!tpl) return null;
    const hdr = env.GSTIN_LOOKUP_AUTH_HEADER ?? env.IBMP_GSTIN_LOOKUP_AUTH_HEADER;
    if (hdr) headers = { [hdr]: key };
    urlFor = (g) => tpl.replace('{gstin}', encodeURIComponent(g)).replace('{key}', encodeURIComponent(key));
  } else return null;
  return {
    name: kind,
    async lookup(gstin) {
      const res = await fetchFn(urlFor(gstin), { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`The GST data provider answered ${res.status}`);
      const body = await res.json();
      if (body?.error === true || body?.success === false || body?.flag === false) return null;      // "no such GSTIN" is an answer, not a failure
      return normaliseTaxpayer(body);
    },
  };
}

/**
 * The answer the screens use. Always resolves for a well-formed GSTIN: `found` says whether a provider gave taxpayer details, and `message`
 * says in plain words what was and was not filled in.
 */
export async function describeGstin(input, { provider = null } = {}) {
  const p = parseGstin(input);
  const base = { gstin: p.gstin, stateCode: p.stateCode, stateName: p.stateName, pan: p.pan, panKind: p.panKind, checkOk: p.checkOk, found: false, source: 'number' };
  if (provider) {
    try {
      const t = await provider.lookup(p.gstin);
      if (t) return { ...base, ...t, found: true, source: provider.name, message: t.status && !/active/i.test(t.status) ? `The GST portal lists this GSTIN as ${t.status}.` : null };
      return { ...base, message: 'No taxpayer was found for this GSTIN. Check the number, or type the details yourself.' };
    } catch (e) {
      return { ...base, message: 'The GST lookup service did not answer just now. State and PAN were filled from the number; please type the name, or try Fetch again in a minute.' };
    }
  }
  return { ...base, message: 'Live GST lookup is not switched on for this account, so the name and address cannot be fetched. The state and PAN were filled from the GSTIN; please type the name.' };
}
