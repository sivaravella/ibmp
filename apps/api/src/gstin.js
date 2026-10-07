// GSTIN helpers: check-digit validation and the unit-of-quantity codes used in GST returns.
import { GSTIN_RE } from './gst.js';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The 15th character of a GSTIN is a check character over the first 14 (a base-36 weighted checksum).
 * Returns null if the input has characters outside 0-9 A-Z.
 */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/** Format and check character both correct. (The portal rejects a GSTIN that fails the check character.) */
export const gstinValid = (g) => typeof g === 'string' && GSTIN_RE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];

export const panOfGstin = (g) => g.slice(2, 12);

// GSTN's list of unit quantity codes (UQC). Anything we cannot map goes to OTH, with a warning.
export const UQC = new Set(['BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD',
  'KGS', 'KLR', 'KME', 'LTR', 'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS']);

const ALIASES = {
  no: 'NOS', nos: 'NOS', number: 'NOS', numbers: 'NOS', piece: 'PCS', pieces: 'PCS', pc: 'PCS', pcs: 'PCS', unit: 'UNT', units: 'UNT',
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', kilograms: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', grams: 'GMS',
  l: 'LTR', ltr: 'LTR', litre: 'LTR', litres: 'LTR', liter: 'LTR', liters: 'LTR', ml: 'MLT', kl: 'KLR',
  m: 'MTR', mtr: 'MTR', meter: 'MTR', meters: 'MTR', metre: 'MTR', metres: 'MTR', box: 'BOX', boxes: 'BOX', set: 'SET', sets: 'SET',
  pack: 'PAC', packs: 'PAC', packet: 'PAC', packets: 'PAC', dozen: 'DOZ', doz: 'DOZ', pair: 'PRS', pairs: 'PRS', bag: 'BAG', bags: 'BAG',
  bottle: 'BTL', bottles: 'BTL', carton: 'CTN', cartons: 'CTN', roll: 'ROL', rolls: 'ROL', ton: 'TON', tons: 'TON', tonne: 'TON', tonnes: 'TON',
  quintal: 'QTL', sqft: 'SQF', sqm: 'SQM', sqyd: 'SQY', can: 'CAN', tube: 'TUB', tubes: 'TUB', tablet: 'TBS', tablets: 'TBS',
};

/** { code, exact }: exact is false when the unit could not be matched and OTH was used. */
export function uqcFor(unit) {
  const raw = String(unit ?? '').trim();
  if (UQC.has(raw.toUpperCase())) return { code: raw.toUpperCase(), exact: true };
  const hit = ALIASES[raw.toLowerCase().replace(/[.\s]/g, '')];
  return hit ? { code: hit, exact: true } : { code: 'OTH', exact: false };
}
