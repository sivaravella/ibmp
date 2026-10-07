// TDS on salary reporting: the year-end salary computation behind Form 16 Part B, and the data of a Form 24Q statement.
// Pure functions over rows the routes have already loaded. Money in whole rupees.
//
// What this is not: it does not produce the NSDL FVU input file, and Form 16 Part A is issued by TRACES, not computed here.
// Not tracked, so reported as nil with a warning: perquisites (Form 12BA), exemptions under section 10 (HRA, LTA), income from
// previous employers and other income, and the breakup of Chapter VI-A deductions (only the declared total is held).
import { annualTax } from './payroll.js';
import { fyOf, parseFy } from './compliance.js';

const pad = (n) => String(n).padStart(2, '0');
const R = Math.round;

export const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export const BSR_RE = /^\d{7}$/;
export const CHALLAN_SERIAL_RE = /^\d{5}$/;
export const TOKEN_RE = /^\d{15}$/;

export const DEDUCTOR_TYPES = ['Company', 'Firm', 'Individual / HUF', 'AOP / BOI', 'Local authority', 'Trust / society', 'Other'];

/** Months (YYYY-MM) of a financial-year quarter: 1 = Apr-Jun ... 4 = Jan-Mar. */
export function quarterMonths(fy, q) {
  const s0 = parseFy(fy);
  const m = [[s0, 4], [s0, 5], [s0, 6], [s0, 7], [s0, 8], [s0, 9], [s0, 10], [s0, 11], [s0, 12], [s0 + 1, 1], [s0 + 1, 2], [s0 + 1, 3]];
  return m.slice((q - 1) * 3, q * 3).map(([y, mo]) => `${y}-${pad(mo)}`);
}
export const quarterOf = (month) => { const mo = Number(month.slice(5, 7)); return mo >= 4 ? Math.floor((mo - 4) / 3) + 1 : 4; };
export const assessmentYear = (fy) => { const s = parseFy(fy) + 1; return `${s}-${pad((s + 1) % 100)}`; };
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** The date TDS for a payroll month must be deposited by: the 7th of the next month, 30 April for March. */
export function tdsDueDate(month) {
  const [y, m] = month.split('-').map(Number);
  if (m === 3) return `${y}-04-30`;
  return m === 12 ? `${y + 1}-01-07` : `${y}-${pad(m + 1)}-07`;
}
/** Due date of a quarter's 24Q statement. */
export const statementDue = (fy, q) => { const s0 = parseFy(fy); return [`${s0}-07-31`, `${s0}-10-31`, `${s0 + 1}-01-31`, `${s0 + 1}-05-31`][q - 1]; };

/** Calendar months, counting any part month as a full one: 30 Apr to 10 Jun is 2. */
export function monthsOrPart(from, to) {
  if (to <= from) return 0;
  const [y1, m1, d1] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0);
}

/** TDS (which includes 4% cess) split into income tax and cess for the statement. */
export const splitCess = (tds) => { const tax = R(tds / 1.04); return { tax, cess: tds - tax }; };

/**
 * One employee's year: what Form 16 Part B and 24Q Annexure II report.
 * slips: payslip rows for the FY from finalized or paid runs, each with { month, gross, tds, professional_tax }.
 */
/** YYYY-MM keys from `from` to `to` inclusive (empty if to < from). */
function monthsRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  while (`${y}-${pad(m)}` <= to) { out.push(`${y}-${pad(m)}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

export function annualSummary({ fy, employee, slips, asOf }) {
  const warnings = [];
  const sum = (k) => slips.reduce((s, x) => s + Number(x[k] || 0), 0);
  const gross = sum('gross'), tds = sum('tds'), pt = sum('professional_tax');
  const regime = employee.tax_regime === 'old' ? 'old' : 'new';
  const declared = regime === 'old' ? Number(employee.declared_deductions || 0) : 0;

  const t = annualTax({ fy, regime, projectedGross: gross, ptAnnual: pt, declared });
  const b = t.breakdown;
  // The deductions the tax computation actually allowed, in Form 16's order.
  const tax_on_employment = regime === 'old' ? pt : 0;
  const deductions_16 = b.std_deduction + tax_on_employment;
  const salary_income = Math.max(0, gross - deductions_16);
  const chapter_vi_a = regime === 'old' ? Math.min(declared, salary_income) : 0;
  warnings.push(...t.warnings);
  if (regime === 'old') warnings.push('Old regime: HRA and LTA exemptions (section 10) and the section-wise split of Chapter VI-A deductions are not tracked: only the declared total is used.');
  warnings.push(...(t.taxable !== Math.max(0, salary_income - chapter_vi_a) ? ['The computed taxable income differs from the deductions shown: review this employee.'] : []));

  const months = slips.map((s) => s.month).sort();

  // A certificate built from partial payroll would understate salary and tax: say which months are missing.
  if (employee.doj && asOf) {
    const s0 = parseFy(fy);
    const prev = (() => { let [y, m] = asOf.slice(0, 7).split('-').map(Number); if (--m < 1) { m = 12; y--; } return `${y}-${pad(m)}`; })();
    const last = [`${s0 + 1}-03`, prev, employee.exit_date ? employee.exit_date.slice(0, 7) : '9999-12'].sort()[0];
    const first = [employee.doj.slice(0, 7), `${s0}-04`].sort().reverse()[0];
    const have = new Set(months);
    const missing = monthsRange(first, last).filter((m) => !have.has(m));
    if (missing.length)
      warnings.push(`No finalized payroll for ${missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more month(s)` : missing.join(', ')} in this year, although ${employee.name ?? 'the employee'} was employed. The figures cover only the recorded months and are incomplete: do not issue this as the year's certificate.`);
  }
  const diff = t.annual_tax - tds;
  if (diff > 0) warnings.push(`Tax deducted (₹${tds}) is ₹${diff} less than the tax on the year's salary (₹${t.annual_tax}).`);
  if (diff < 0) warnings.push(`Tax deducted (₹${tds}) is ₹${-diff} more than the tax on the year's salary (₹${t.annual_tax}): the employee can claim the excess as a refund.`);

  return {
    fy, ay: assessmentYear(fy), regime, period_from: months[0] ?? null, period_to: months[months.length - 1] ?? null, months: months.length,
    gross_salary: gross, perquisites: 0, profits_in_lieu: 0, exempt_allowances: 0,
    standard_deduction: b.std_deduction, entertainment_allowance: 0, tax_on_employment, deductions_16,
    income_from_salary: salary_income, other_income: 0, gross_total_income: salary_income,
    chapter_vi_a, taxable_income: t.taxable,
    tax_on_income: b.tax_on_income, rebate_87a: b.rebate, surcharge: 0, cess: b.cess, total_tax: t.annual_tax, relief_89: 0, net_tax_payable: t.annual_tax,
    tds_deducted: tds, shortfall: diff,                           // positive = short deduction, negative = excess
    warnings,
    monthly: slips.map((s) => ({ month: s.month, gross: Number(s.gross), tds: Number(s.tds) })).sort((a, b2) => a.month.localeCompare(b2.month)),
  };
}

/**
 * Data for one quarter's Form 24Q.
 * runs: finalized or paid payroll runs for the FY; slips: their payslips (with run_id, month, employee_id, gross, tds, pan, emp_name, emp_code);
 * employees: master rows (for regime and declared deductions); statements: already-recorded filings; asOf: 'YYYY-MM-DD'.
 */
export function build24q({ company, fy, quarter, runs, slips, employees, statements = [], asOf }) {
  const errors = [], warnings = [];
  const months = quarterMonths(fy, quarter);
  const end = lastDay(months[2]);
  const due = statementDue(fy, quarter);

  // ---- deductor ----
  const pan = company.pan || (company.gstin ? company.gstin.slice(2, 12) : null);
  if (!company.tan) errors.push('The deductor TAN is not set. Add it under TDS setup.');
  else if (!TAN_RE.test(company.tan)) errors.push(`The TAN "${company.tan}" is not in the TAN format (4 letters, 5 digits, 1 letter).`);
  if (!pan) errors.push('The deductor PAN is not set.');
  if (!company.tds_person_name) errors.push('The person responsible for deducting tax is not named. Add it under TDS setup.');
  if (!company.addr1 || !company.loc || !company.pin) errors.push('The deductor address is incomplete (address, town and PIN code are needed).');
  if (end >= asOf) errors.push(`${fy} Q${quarter} has not ended yet: a statement can only be prepared after the quarter is over.`);
  if (statements.some((s) => s.fy === fy && s.quarter === quarter))
    warnings.push(`A statement for this quarter was already recorded as filed (token ${statements.find((s) => s.fy === fy && s.quarter === quarter).token_no}). A correction statement is a separate process.`);

  const runByMonth = new Map(runs.map((r) => [r.month, r]));
  const missingRuns = months.filter((m) => !runByMonth.has(m));
  if (missingRuns.length) warnings.push(`No finalized payroll for ${missingRuns.join(', ')}: those months are not in this statement.`);

  // ---- challans: one per payroll month that deducted tax ----
  const challans = [];
  const deductees = [];
  let sr = 0;
  for (const month of months) {
    const run = runByMonth.get(month);
    if (!run) continue;
    const mslips = slips.filter((s) => s.run_id === run.id && Number(s.tds) > 0);
    const total = mslips.reduce((s, x) => s + Number(x.tds), 0);
    if (!total) continue;

    const paidOn = run.paid_on || lastDay(month);
    const deposited = run.remitted_tds;
    const splitTotal = splitCess(total);
    if (!deposited) errors.push(`TDS for ${month} (₹${total}) has not been recorded as deposited. Deposit it, then record it on the payroll run.`);
    if (!run.tds_bsr || !run.tds_challan_serial) errors.push(`Challan details (BSR code and serial number) are missing for the ${month} TDS deposit.`);
    challans.push({
      month, bsr: run.tds_bsr ?? null, challan_serial: run.tds_challan_serial ?? null, date_deposited: deposited ?? null,
      tds_income_tax: splitTotal.tax, surcharge: 0, cess: splitTotal.cess, interest: Number(run.tds_interest || 0), fee: Number(run.tds_fee || 0),
      total_deposited: total + Number(run.tds_interest || 0) + Number(run.tds_fee || 0), tds_deducted: total, due_date: tdsDueDate(month),
    });

    if (deposited && deposited > tdsDueDate(month)) {
      const m = monthsOrPart(lastDay(month), deposited);
      const est = R((total * 0.015 * m));
      if (est > Number(run.tds_interest || 0))
        warnings.push(`TDS for ${month} was deposited on ${deposited}, after the due date ${tdsDueDate(month)}. Interest for late deposit (1.5% a month) is about ₹${est}; ₹${Number(run.tds_interest || 0)} is recorded on the challan.`);
    }

    for (const s of mslips) {
      const sp = splitCess(Number(s.tds));
      sr += 1;
      if (!s.pan) errors.push(`${s.emp_name} (${s.emp_code}) has no PAN: it is required to report their tax.`);
      deductees.push({
        sr, employee_code: s.emp_code, pan: s.pan ?? null, name: s.emp_name, section: '192', month,
        date_of_payment: paidOn, amount_paid: Number(s.gross), date_of_deduction: paidOn, date_of_deposit: deposited ?? null,
        tds_income_tax: sp.tax, surcharge: 0, cess: sp.cess, tds_total: Number(s.tds), challan_bsr: run.tds_bsr ?? null, challan_serial: run.tds_challan_serial ?? null,
      });
    }
  }

  // ---- Annexure II (the fourth quarter only): the year's salary and tax for every employee ----
  let annexure2 = null;
  if (quarter === 4) {
    annexure2 = [];
    const byEmp = new Map();
    for (const s of slips) { if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, []); byEmp.get(s.employee_id).push(s); }
    for (const [empId, list] of byEmp) {
      const emp = employees.find((e) => e.id === empId);
      if (!emp) continue;
      const a = annualSummary({ fy, employee: emp, slips: list, asOf });
      const pan2 = list[list.length - 1].pan ?? emp.pan ?? null;
      if (!pan2 && !deductees.some((d) => d.name === emp.name)) errors.push(`${emp.name} (${emp.code}) has no PAN: it is required in Annexure II.`);
      annexure2.push({ employee_code: emp.code, pan: pan2, name: emp.name, ...a, warnings: undefined });
      for (const w of a.warnings) warnings.push(`${emp.name}: ${w}`);
    }
    annexure2.sort((a, b) => a.employee_code.localeCompare(b.employee_code));
    warnings.push('Annexure II lists every employee paid in the year, including those with no tax deducted. Confirm that against the current statement rules.');
  }

  // ---- totals and statement-level checks ----
  const totalDeducted = deductees.reduce((s, d) => s + d.tds_total, 0);
  const totalDeposited = challans.filter((c) => c.date_deposited).reduce((s, c) => s + c.tds_deducted, 0);
  if (!challans.length) warnings.push('No tax was deducted in this quarter. A nil statement is still due if you are a registered deductor: confirm with your tax adviser.');
  if (asOf > due) {
    const lateDays = daysBetween(due, asOf);
    const fee = Math.min(lateDays * 200, totalDeducted);
    warnings.push(`This statement was due on ${due}. The late filing fee under section 234E (₹200 a day, up to the tax deducted) is about ₹${fee} if it is filed today.`);
  }
  warnings.push('The tax figures use the payroll TDS (which includes 4% cess) split into income tax and cess for the statement. Surcharge is not computed.');
  warnings.push('Form 16 Part A is issued from TRACES after this statement is filed and processed. It is not produced here.');

  return {
    statement: {
      form: '24Q', fy, ay: assessmentYear(fy), quarter, period: { from: `${months[0]}-01`, to: end }, due_date: due,
      deductor: {
        tan: company.tan ?? null, pan, name: company.legal_name || company.name, type: company.deductor_type ?? null,
        address: [company.addr1, company.addr2, company.loc, company.pin].filter(Boolean).join(', '), email: company.email ?? null, phone: company.phone ?? null,
        responsible_person: { name: company.tds_person_name ?? null, designation: company.tds_person_designation ?? null },
      },
      challans, deductees, annexure2,
      totals: { deducted: totalDeducted, deposited: totalDeposited, challans: challans.length, deductee_rows: deductees.length },
    },
    errors: [...new Set(errors)], warnings: [...new Set(warnings)],
  };
}

/** A section of a statement as CSV: header row plus rows, quoted where needed. */
export function toCsv(rows, columns) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(([, h]) => h).join(','), ...rows.map((r) => columns.map(([k]) => cell(r[k])).join(','))].join('\r\n') + '\r\n';
}

export const CSV_COLUMNS = {
  challans: [['month', 'Month'], ['bsr', 'BSR code'], ['challan_serial', 'Challan serial no'], ['date_deposited', 'Date of deposit'], ['tds_income_tax', 'TDS (income tax)'], ['surcharge', 'Surcharge'], ['cess', 'Education cess'],
    ['interest', 'Interest'], ['fee', 'Fee'], ['total_deposited', 'Total deposited']],
  deductees: [['sr', 'Sr no'], ['employee_code', 'Employee code'], ['pan', 'PAN'], ['name', 'Name'], ['section', 'Section'], ['date_of_payment', 'Date of payment/credit'], ['amount_paid', 'Amount paid/credited'],
    ['date_of_deduction', 'Date of deduction'], ['tds_income_tax', 'TDS (income tax)'], ['surcharge', 'Surcharge'], ['cess', 'Education cess'], ['tds_total', 'Total tax deducted'],
    ['date_of_deposit', 'Date of deposit'], ['challan_bsr', 'BSR code'], ['challan_serial', 'Challan serial no']],
  annexure2: [['employee_code', 'Employee code'], ['pan', 'PAN'], ['name', 'Name'], ['period_from', 'Employed from (month)'], ['period_to', 'Employed to (month)'], ['regime', 'Tax regime'],
    ['gross_salary', 'Gross salary'], ['perquisites', 'Perquisites'], ['exempt_allowances', 'Exempt allowances (s.10)'], ['standard_deduction', 'Standard deduction'], ['tax_on_employment', 'Tax on employment'],
    ['income_from_salary', 'Income chargeable under salaries'], ['chapter_vi_a', 'Chapter VI-A deductions'], ['taxable_income', 'Total taxable income'], ['tax_on_income', 'Tax on total income'],
    ['rebate_87a', 'Rebate u/s 87A'], ['surcharge', 'Surcharge'], ['cess', 'Cess'], ['net_tax_payable', 'Net tax payable'], ['tds_deducted', 'Tax deducted'], ['shortfall', 'Short (+) / excess (-)']],
};
