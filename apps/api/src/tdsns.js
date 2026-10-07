// TDS on payments other than salary (Form 26Q): the section catalogue, the deduction maths and the quarterly statement data.
// Pure functions over rows the routes have loaded. Money in whole rupees.
//
// THE RATES AND THRESHOLDS BELOW ARE A STARTING POINT, NOT AUTHORITY. They follow the Finance Act 2025 as I understand it
// (effective 1 April 2025). They change often and the Income-tax Act 2025 renumbers the sections from 1 April 2026, so confirm
// every figure and the section codes the current Return Preparation Utility accepts before relying on them. Each deduction can
// override the rate (for example with a lower-deduction certificate).
import { PAN_RE, TAN_RE, assessmentYear, monthsOrPart, quarterMonths, statementDue, tdsDueDate } from './tds.js';

const R = Math.round;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export const RATES_VERIFIED = false;
export const NO_PAN_RATE = 20;                                    // section 206AA: the higher of the rate and 20%

/**
 * code: the 26Q section code. rate: percent, or { individual, other } where it depends on who is paid.
 * single / annual: thresholds in rupees. mode 'excess' means tax applies only to what is paid above `annual` (194Q).
 */
export const SECTIONS = {
  '94A': { section: '194A', label: 'Interest other than interest on securities', rate: 10, annual: 10000, note: 'The ₹10,000 limit is for payers other than banks and co-operatives (₹50,000 for those, ₹1,00,000 for senior citizens).' },
  '94C': { section: '194C', label: 'Payment to contractors', rate: { individual: 1, other: 2 }, single: 30000, annual: 100000, note: '1% for an individual or HUF, 2% for others. Deducted when one payment exceeds ₹30,000 or the year\'s total exceeds ₹1,00,000.' },
  '94H': { section: '194H', label: 'Commission or brokerage', rate: 2, annual: 20000 },
  '94IA': { section: '194I(a)', label: 'Rent: plant and machinery', rate: 2, annual: 600000 },
  '94IB': { section: '194I(b)', label: 'Rent: land, building and furniture', rate: 10, annual: 600000 },
  '94JA': { section: '194J(a)', label: 'Fees for technical services', rate: 2, annual: 50000 },
  '94JB': { section: '194J(b)', label: 'Professional fees and royalty', rate: 10, annual: 50000, note: 'Director\'s remuneration has no limit and is not modelled here.' },
  '94Q': { section: '194Q', label: 'Purchase of goods', rate: 0.1, annual: 5000000, mode: 'excess', noPanRate: 5, note: '0.1% on what you pay one seller above ₹50 lakh in the year; applies if your turnover exceeded ₹10 crore.' },
};

/** The deductee's nature from the fourth letter of the PAN. */
export const PAN_KINDS = { P: 'Individual', H: 'HUF', C: 'Company', F: 'Firm', A: 'AOP', B: 'BOI', T: 'Trust', L: 'Local authority', J: 'Artificial juridical person', G: 'Government' };
export const panKind = (pan) => (PAN_RE.test(pan ?? '') ? pan[3] : null);
export const deducteeType = (pan) => (panKind(pan) === 'C' ? 'company' : 'non_company');

/** The PAN to report: the party's own, else the one inside its GSTIN. */
export const partyPan = (p) => (p.pan && PAN_RE.test(p.pan) ? p.pan : p.gstin ? p.gstin.slice(2, 12) : null);

export function standardRate(section, pan) {
  const def = SECTIONS[section];
  if (!def) throw Object.assign(new Error('Unknown TDS section'), { status: 400 });
  const kind = panKind(pan);
  let rate = typeof def.rate === 'object' ? (kind === 'P' || kind === 'H' ? def.rate.individual : def.rate.other) : def.rate;
  if (!kind) return { rate: Math.max(rate, def.noPanRate ?? NO_PAN_RATE), reason: 'no_pan' };
  return { rate, reason: 'standard' };
}

/**
 * What to deduct on a payment.
 * prior: { base, taxedBase } already paid to this deductee under this section this year (active deductions only).
 * Aggregate sections deduct once the year's total passes the limit, and then on everything paid so far (catch-up); 194C also
 * deducts on any single payment over its limit. 194Q taxes only the part above its limit.
 */
export function computeDeduction({ section, pan, prior = { base: 0, taxedBase: 0 }, payment, rateOverride = null }) {
  const def = SECTIONS[section];
  if (!def) throw Object.assign(new Error('Unknown TDS section'), { status: 400 });
  const std = standardRate(section, pan);
  const rate = rateOverride === null || rateOverride === undefined ? std.rate : Number(rateOverride);
  const reason = rateOverride === null || rateOverride === undefined ? std.reason : 'override';

  const cumulative = prior.base + payment;
  let newTaxed;
  if (def.mode === 'excess') newTaxed = Math.max(0, cumulative - def.annual);
  else {
    const crossedAnnual = def.annual != null && cumulative > def.annual;
    const crossedSingle = def.single != null && payment > def.single;
    const noLimits = def.annual == null && def.single == null;
    newTaxed = noLimits || crossedAnnual ? cumulative : crossedSingle ? prior.taxedBase + payment : prior.taxedBase;
  }
  const taxedBase = Math.max(0, newTaxed - prior.taxedBase);
  return {
    section, base: payment, taxed_base: taxedBase, rate, rate_reason: reason, tds: R((rate * taxedBase) / 100),
    cumulative_base: cumulative, threshold_crossed: taxedBase > 0, catch_up: taxedBase > payment && def.mode !== 'excess' ? taxedBase - payment : 0,
  };
}

/**
 * Data for one quarter's Form 26Q.
 * deductions: active deductions with { party_name, pan, party_gstin, section, date, base, taxed_base, rate, rate_reason, tds, cert_ref };
 * challans: tds_ns_challans rows; statements: recorded filings.
 */
export function build26q({ company, fy, quarter, deductions, challans, statements = [], asOf }) {
  const errors = [], warnings = [];
  const months = quarterMonths(fy, quarter);
  const end = lastDay(months[2]);
  const due = statementDue(fy, quarter);

  const pan = company.pan || (company.gstin ? company.gstin.slice(2, 12) : null);
  if (!company.tan) errors.push('The deductor TAN is not set. Add it under TDS setup.');
  else if (!TAN_RE.test(company.tan)) errors.push(`The TAN "${company.tan}" is not in the TAN format (4 letters, 5 digits, 1 letter).`);
  if (!pan) errors.push('The deductor PAN is not set.');
  if (!company.tds_person_name) errors.push('The person responsible for deducting tax is not named. Add it under TDS setup.');
  if (!company.addr1 || !company.loc || !company.pin) errors.push('The deductor address is incomplete (address, town and PIN code are needed).');
  if (end >= asOf) errors.push(`${fy} Q${quarter} has not ended yet: a statement can only be prepared after the quarter is over.`);
  const recorded = statements.find((s) => s.fy === fy && s.quarter === quarter);
  if (recorded) warnings.push(`A statement for this quarter was already recorded as filed (token ${recorded.token_no}). A correction statement is a separate process.`);

  const inQuarter = deductions.filter((d) => months.includes(d.date.slice(0, 7))).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const key = (month, type) => `${month}|${type}`;
  const chBy = new Map(challans.filter((c) => months.includes(c.month)).map((c) => [key(c.month, c.deductee_type), c]));

  // Tax deducted per challan group: one challan per month and type of deductee.
  const groups = new Map();
  for (const d of inQuarter) {
    const type = deducteeType(d.pan);
    const k = key(d.date.slice(0, 7), type);
    if (!groups.has(k)) groups.set(k, { month: d.date.slice(0, 7), type, tds: 0 });
    groups.get(k).tds += d.tds;
  }

  const challanRows = [];
  for (const [k, g] of [...groups].sort()) {
    const c = chBy.get(k);
    const label = `${g.month} (${g.type === 'company' ? 'company' : 'non-company'} deductees)`;
    if (!c) { errors.push(`The TDS for ${label}, ₹${g.tds}, has not been deposited. Record the challan first.`); }
    else if (R(Number(c.tax)) !== g.tds) errors.push(`The ${label} challan is for ₹${R(Number(c.tax))} but the deductions add up to ₹${g.tds}.`);
    const dep = c ? c.deposited_on : null;
    challanRows.push({
      month: g.month, challan_type: g.type === 'company' ? '0020' : '0021', bsr: c?.bsr ?? null, challan_serial: c?.serial ?? null, date_deposited: dep,
      tds_income_tax: g.tds, surcharge: 0, cess: 0, interest: Number(c?.interest ?? 0), fee: Number(c?.fee ?? 0), total_deposited: g.tds + Number(c?.interest ?? 0) + Number(c?.fee ?? 0),
      due_date: tdsDueDate(g.month),
    });
    if (dep && dep > tdsDueDate(g.month)) {
      const est = R(g.tds * 0.015 * monthsOrPart(g.month === '' ? dep : lastDay(g.month), dep));
      if (est > Number(c.interest)) warnings.push(`The ${label} TDS was deposited on ${dep}, after the due date ${tdsDueDate(g.month)}. Interest for late deposit (1.5% a month) is about ₹${est}; ₹${R(Number(c.interest))} is recorded on the challan.`);
    }
  }

  const deductees = inQuarter.map((d, i) => {
    const type = deducteeType(d.pan);
    const c = chBy.get(key(d.date.slice(0, 7), type));
    if (!d.pan) warnings.push(`${d.party_name} has no PAN: tax was deducted at ${d.rate}% and the statement shows PANNOTAVBL. Get the PAN, which the deductee needs to claim credit.`);
    if (d.rate_reason === 'override') warnings.push(`${d.party_name} (${SECTIONS[d.section].section}): a rate of ${d.rate}% was used${d.cert_ref ? ` under certificate ${d.cert_ref}` : ' with no certificate number recorded'}.`);
    return {
      sr: i + 1, section: d.section, section_name: SECTIONS[d.section].section, deductee_code: type === 'company' ? '01' : '02', pan: d.pan ?? 'PANNOTAVBL', name: d.party_name,
      date_of_payment: d.date, amount_paid: d.base, taxed_base: d.taxed_base, rate: d.rate, tds_income_tax: d.tds, surcharge: 0, cess: 0, tds_total: d.tds,
      date_of_deduction: d.date, date_of_deposit: c?.deposited_on ?? null, challan_bsr: c?.bsr ?? null, challan_serial: c?.serial ?? null, reason: d.rate_reason,
    };
  });
  for (const c of challanRows) if (c.date_deposited && (!c.bsr || !c.challan_serial)) errors.push(`Challan details are missing for the ${c.month} deposit.`);

  const totalDeducted = deductees.reduce((s, d) => s + d.tds_total, 0);
  const totalDeposited = challanRows.filter((c) => c.date_deposited).reduce((s, c) => s + c.tds_income_tax, 0);
  if (!deductees.length) warnings.push('No tax was deducted on non-salary payments in this quarter. If you are a registered deductor a nil statement may still be due: confirm with your tax adviser.');
  if (asOf > due) {
    const fee = Math.min(daysBetween(due, asOf) * 200, totalDeducted);
    warnings.push(`This statement was due on ${due}. The late filing fee under section 234E (₹200 a day, up to the tax deducted) is about ₹${fee} if it is filed today.`);
  }
  if (deductees.some((d) => d.taxed_base > d.amount_paid && d.section !== '94Q')) warnings.push('Some deductions include catch-up tax on earlier payments, made when a yearly limit was crossed.');
  warnings.push('Higher rates for non-filers of returns (section 206AB) are not applied: check the deductee against the "specified person" list.');
  warnings.push('Section codes follow the Income-tax Act 1961 numbering. The Income-tax Act 2025 renumbers them from 1 April 2026: confirm what the current Return Preparation Utility expects. The rates are not verified (see the section list).');
  warnings.push('Form 16A is issued from TRACES after this statement is processed. It is not produced here.');

  return {
    statement: {
      form: '26Q', fy, ay: assessmentYear(fy), quarter, period: { from: `${months[0]}-01`, to: end }, due_date: due,
      deductor: {
        tan: company.tan ?? null, pan, name: company.legal_name || company.name, type: company.deductor_type ?? null,
        address: [company.addr1, company.addr2, company.loc, company.pin].filter(Boolean).join(', '), email: company.email ?? null, phone: company.phone ?? null,
        responsible_person: { name: company.tds_person_name ?? null, designation: company.tds_person_designation ?? null },
      },
      challans: challanRows, deductees,
      totals: { deducted: totalDeducted, deposited: totalDeposited, challans: challanRows.length, deductee_rows: deductees.length },
    },
    errors: [...new Set(errors)], warnings: [...new Set(warnings)],
  };
}

export const CSV_26Q = {
  challans: [['month', 'Month'], ['challan_type', 'Challan type'], ['bsr', 'BSR code'], ['challan_serial', 'Challan serial no'], ['date_deposited', 'Date of deposit'], ['tds_income_tax', 'TDS (income tax)'],
    ['surcharge', 'Surcharge'], ['cess', 'Education cess'], ['interest', 'Interest'], ['fee', 'Fee'], ['total_deposited', 'Total deposited']],
  deductees: [['sr', 'Sr no'], ['section', 'Section code'], ['deductee_code', 'Deductee code (01 company, 02 other)'], ['pan', 'PAN'], ['name', 'Name'], ['date_of_payment', 'Date of payment/credit'],
    ['amount_paid', 'Amount paid/credited'], ['rate', 'Rate %'], ['tds_income_tax', 'TDS'], ['surcharge', 'Surcharge'], ['cess', 'Education cess'], ['tds_total', 'Total tax deducted'],
    ['date_of_deduction', 'Date of deduction'], ['date_of_deposit', 'Date of deposit'], ['challan_bsr', 'BSR code'], ['challan_serial', 'Challan serial no']],
};
