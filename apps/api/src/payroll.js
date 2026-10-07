// Payroll calculation engine. Pure functions, no database. Amounts are rupees (components rounded to whole rupees).
//
// Covered: loss of pay and part-month employment, PF (employee, EPS/EPF split, EDLI, admin), ESI, professional tax as a
// per-employee fixed amount, and TDS on salary projected over the financial year (new and old regime, 87A rebate,
// marginal relief, 4% cess).
// Not covered: surcharge (warned above ₹50 lakh taxable), previous-employer income, HRA/LTA exemptions in the old
// regime, perquisites, arrears relief, state-specific professional-tax slabs, labour welfare fund, gratuity, bonus.

import { fyOf } from './compliance.js';

export const PF_WAGE_CEILING = 15000;
export const ESI_WAGE_CEILING = 21000;
const RATE = { PF: 0.12, EPS: 0.0833, EDLI: 0.005, PF_ADMIN: 0.005, PF_ADMIN_MIN: 500, ESI_EE: 0.0075, ESI_ER: 0.0325 };

const R = Math.round;
const pad = (n) => String(n).padStart(2, '0');

// Slabs are [upper bound, rate]. FY 2026-27 reuses the FY 2025-26 figures: confirm against the Finance Act before relying on them.
const NEW_REGIME = { std: 75000, slabs: [[400000, 0], [800000, 0.05], [1200000, 0.10], [1600000, 0.15], [2000000, 0.20], [2400000, 0.25], [Infinity, 0.30]], rebate: { limit: 1200000, max: 60000, marginalRelief: true } };
const OLD_REGIME = { std: 50000, slabs: [[250000, 0], [500000, 0.05], [1000000, 0.20], [Infinity, 0.30]], rebate: { limit: 500000, max: 12500, marginalRelief: false } };
export const TAX_TABLES = {
  '2025-26': { verified: true, new: NEW_REGIME, old: OLD_REGIME },
  '2026-27': { verified: false, new: NEW_REGIME, old: OLD_REGIME },
};
export const taxTable = (fy) => ({ fy: TAX_TABLES[fy] ? fy : '2026-27', ...(TAX_TABLES[fy] ?? TAX_TABLES['2026-27']), exact: !!TAX_TABLES[fy] });

export function monthInfo(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new Error('Invalid month');
  const y = Number(m[1]), mo = Number(m[2]);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { y, m: mo, days, start: `${month}-01`, end: `${month}-${pad(days)}` };
}

/** Days of the month the employee was on the books (joining / exit dates clip the month). */
export function employedDays(emp, month) {
  const { days, start, end } = monthInfo(month);
  const from = emp.doj > start ? emp.doj : start;
  const to = emp.exit_date && emp.exit_date < end ? emp.exit_date : end;
  if (to < from) return 0;
  return Math.min(days, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
}

const monthlyGross = (e) => ['basic', 'hra', 'special', 'travel', 'medical'].reduce((s, k) => s + Number(e[k] || 0), 0);

function slabTax(taxable, slabs) {
  let tax = 0, lower = 0;
  for (const [upper, rate] of slabs) {
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

/**
 * Annual tax on salary for a regime. Returns { taxable, annual_tax, warnings }.
 * annual_tax = slab tax after rebate (with marginal relief in the new regime) plus 4% cess, rounded to the rupee.
 */
export function annualTax({ fy, regime, projectedGross, ptAnnual = 0, declared = 0 }) {
  const t = taxTable(fy)[regime === 'old' ? 'old' : 'new'];
  const warnings = [];
  let taxable = projectedGross - t.std;
  if (regime === 'old') taxable -= ptAnnual + declared;
  taxable = Math.max(0, taxable);
  const slab = slabTax(taxable, t.slabs);
  let tax = slab;
  if (taxable <= t.rebate.limit) tax = Math.max(0, tax - Math.min(tax, t.rebate.max));
  else if (t.rebate.marginalRelief) tax = Math.min(tax, taxable - t.rebate.limit);
  if (taxable > 5000000) warnings.push('Taxable income above ₹50 lakh: surcharge is not computed, TDS will be understated.');
  const total = R(tax * 1.04);
  // The breakdown is what Form 16 Part B prints: tax on income, rebate / marginal relief, then cess on the remainder.
  return {
    taxable, annual_tax: total, warnings,
    breakdown: { std_deduction: Math.min(t.std, projectedGross), tax_on_income: R(slab), rebate: R(slab) - R(tax), tax_after_rebate: R(tax), cess: total - R(tax) },
  };
}

/** Months from `month` to the end of the FY (or the exit month, if earlier), inclusive of `month`. */
export function monthsLeft(month, exitDate) {
  const { y, m } = monthInfo(month);
  let left = m >= 4 ? 12 - m + 4 : 4 - m;       // Oct -> Oct..Mar = 6
  if (exitDate && fyOf(`${month}-01`) === fyOf(exitDate)) {
    const ey = Number(exitDate.slice(0, 4)), em = Number(exitDate.slice(5, 7));
    left = Math.max(1, Math.min(left, (ey - y) * 12 + (em - m) + 1));
  }
  return left;
}

/**
 * One employee's payslip for a month.
 * emp: employee row (numeric strings ok). opts: { lopDays, otherEarnings, otherDeductions, ytd: {gross, tds} }.
 */
export function computePayslip(emp, month, opts = {}) {
  const warnings = [];
  const { days } = monthInfo(month);
  const lop = Number(opts.lopDays || 0);
  const otherEarnings = Number(opts.otherEarnings || 0), otherDeductions = Number(opts.otherDeductions || 0);
  const ytd = opts.ytd ?? { gross: 0, tds: 0 };

  const employed = employedDays(emp, month);
  if (lop < 0 || lop > employed) throw Object.assign(new Error(`Loss of pay days must be between 0 and ${employed}`), { status: 400 });
  const paidDays = employed - lop;
  const ratio = paidDays / days;

  const earn = (k) => R(Number(emp[k] || 0) * ratio);
  const e = { basic: earn('basic'), hra: earn('hra'), special: earn('special'), travel: earn('travel'), medical: earn('medical') };
  const gross = e.basic + e.hra + e.special + e.travel + e.medical + otherEarnings;

  // PF: 12% of basic, normally capped at the ₹15,000 wage ceiling unless the employee contributes on actual wages.
  let pfWages = 0, pfEmployee = 0, pfEps = 0, pfEpf = 0, edli = 0;
  if (emp.pf_applicable && paidDays > 0) {
    pfWages = emp.pf_on_actual ? e.basic : Math.min(e.basic, PF_WAGE_CEILING);
    pfEmployee = R(pfWages * RATE.PF);
    const employer = R(pfWages * RATE.PF);
    pfEps = R(Math.min(pfWages, PF_WAGE_CEILING) * RATE.EPS);   // pension share is always capped at the ceiling
    pfEpf = employer - pfEps;
    edli = R(Math.min(pfWages, PF_WAGE_CEILING) * RATE.EDLI);
  }

  // ESI: covered when the full monthly gross is within ₹21,000; contribution on earned wages, rounded up to the rupee.
  const esiCovered = !!emp.esi_applicable && monthlyGross(emp) <= ESI_WAGE_CEILING;
  const esiEmployee = esiCovered && paidDays > 0 ? Math.ceil(gross * RATE.ESI_EE - 1e-9) : 0;
  const esiEmployer = esiCovered && paidDays > 0 ? Math.ceil(gross * RATE.ESI_ER - 1e-9) : 0;

  const pt = paidDays > 0 ? Number(emp.pt_monthly || 0) : 0;

  // TDS: tax on the projected full-year salary, less tax already deducted, spread over the months left.
  let tds = 0, taxable = 0, annual = 0;
  if (paidDays > 0) {
    const left = monthsLeft(month, emp.exit_date);
    const projected = Number(ytd.gross) + gross + (left - 1) * monthlyGross(emp);
    const t = annualTax({ fy: fyOf(`${month}-01`), regime: emp.tax_regime, projectedGross: projected,
      ptAnnual: pt * 12, declared: Number(emp.declared_deductions || 0) });
    warnings.push(...t.warnings);
    taxable = t.taxable; annual = t.annual_tax;
    tds = Math.max(0, R((t.annual_tax - Number(ytd.tds)) / left));
    tds = Math.min(tds, Math.max(0, gross - pfEmployee - esiEmployee - pt));   // never push net pay below zero
  }

  const net = gross - pfEmployee - esiEmployee - pt - tds - otherDeductions;
  if (net < 0) warnings.push('Deductions exceed earnings: net pay is negative. Reduce the other deductions.');
  if (!taxTable(fyOf(`${month}-01`)).exact) warnings.push('No tax table for this financial year; the latest available one was used.');

  return {
    days_in_month: days, employed_days: employed, lop_days: lop, paid_days: paidDays,
    earned_basic: e.basic, earned_hra: e.hra, earned_special: e.special, earned_travel: e.travel, earned_medical: e.medical,
    other_earnings: otherEarnings, gross,
    pf_wages: pfWages, pf_employee: pfEmployee, pf_eps: pfEps, pf_epf: pfEpf, edli,
    esi_covered: esiCovered, esi_employee: esiEmployee, esi_employer: esiEmployer,
    professional_tax: pt, tds, other_deductions: otherDeductions, net,
    taxable_income: taxable, annual_tax: annual,
    warnings,
  };
}

/** Run-level totals from payslips. PF admin charge is per establishment (0.5% of PF wages, minimum ₹500). */
export function runTotals(slips) {
  const sum = (k) => slips.reduce((s, x) => s + Number(x[k] || 0), 0);
  const pfWages = sum('pf_wages');
  const pfAdmin = slips.some((x) => Number(x.pf_wages) > 0) ? Math.max(RATE.PF_ADMIN_MIN, R(pfWages * RATE.PF_ADMIN)) : 0;
  const t = {
    employees: slips.length, gross: sum('gross'), net: sum('net'),
    pf_employee: sum('pf_employee'), pf_employer: sum('pf_eps') + sum('pf_epf'), edli: sum('edli'), pf_admin: pfAdmin,
    esi_employee: sum('esi_employee'), esi_employer: sum('esi_employer'),
    tds: sum('tds'), professional_tax: sum('professional_tax'), other_deductions: sum('other_deductions'),
  };
  t.employer_contributions = t.pf_employer + t.edli + t.pf_admin + t.esi_employer;
  t.employer_cost = t.gross + t.employer_contributions;
  t.pf_payable = t.pf_employee + t.pf_employer + t.edli + t.pf_admin;
  t.esi_payable = t.esi_employee + t.esi_employer;
  return t;
}
