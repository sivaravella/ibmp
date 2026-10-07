// PF and ESI monthly contribution files, built from a finalized payroll month. Pure functions over loaded rows.
//
// ECR (EPFO): the ECR 2.0 text file, one line per member, eleven fields separated by "#~#":
//   UAN, member name, gross wages, EPF wages, EPS wages, EDLI wages, EPF contribution (member's 12%),
//   EPS contribution (8.33%), EPF-EPS difference (employer's 3.67%), NCP days, refund of advances.
// ESI (ESIC): the columns of the monthly contribution template: IP number, IP name, days wages were paid, total monthly wages,
//   reason code for zero working days, last working day.
//
// Written from the published layouts without access to the EPFO or ESIC portals' validators. The portals recompute the
// employer-side charges and reject rows they do not like, so treat a first upload as a test and read what they say.
import { toCsv } from './tds.js';

const R = Math.round;
const pad = (n) => String(n).padStart(2, '0');

export const UAN_RE = /^\d{12}$/;
export const ESI_IP_RE = /^(\d{10}|\d{17})$/;
export const TRRN_RE = /^\d{13}$/;
const PF_CEILING = 15000;
const dmy = (d) => String(d).slice(0, 10).split('-').reverse().join('/');
const monthEnd = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };

/** EPFO wants the name as in the UAN record: capital letters, spaces and full stops only. */
export function ecrName(name) {
  return String(name).toUpperCase().replace(/[^A-Z .]/g, '').replace(/\s+/g, ' ').trim();
}

/** 092026-style label used in file names. */
export const periodLabel = (month) => `${month.slice(5, 7)}${month.slice(0, 4)}`;

/**
 * ECR for one payroll month.
 * run: the payroll run (days, pf_admin); slips: its payslips; employees: master rows (current UAN and exit dates win over the snapshot).
 */
export function buildEcr({ month, run, slips, employees }) {
  const errors = [], warnings = [];
  if (!run) return { rows: [], errors: [`There is no finalized payroll for ${month}.`], warnings, challan: null, text: '', totals: null };
  const empBy = new Map(employees.map((e) => [e.id, e]));

  const rows = [];
  const seen = new Map();
  let renamed = 0, fractional = 0;
  for (const s of slips) {
    if (!(Number(s.pf_wages) > 0)) continue;                       // not a PF member this month (or no wages at all)
    const emp = empBy.get(s.employee_id) ?? {};
    const uan = (emp.uan ?? s.uan ?? '').trim();
    const label = `${s.emp_name} (${s.emp_code})`;
    if (!uan) errors.push(`${label} has no UAN.`);
    else if (!UAN_RE.test(uan)) errors.push(`${label}: the UAN "${uan}" is not a 12-digit number.`);
    else if (seen.has(uan)) errors.push(`${label} and ${seen.get(uan)} have the same UAN ${uan}.`);
    else seen.set(uan, label);

    const name = ecrName(s.emp_name);
    if (name !== String(s.emp_name).toUpperCase().trim()) renamed++;
    if (!name) errors.push(`${label}: the name has no usable letters for the ECR.`);

    const days = Number(s.days_in_month);
    const ncpExact = days - Number(s.paid_days);
    if (!Number.isInteger(ncpExact)) fractional++;
    const ncp = Math.max(0, Math.min(days, R(ncpExact)));
    const epfWages = R(Number(s.pf_wages));
    const gross = R(Number(s.gross));
    if (epfWages > gross) warnings.push(`${label}: PF wages (₹${epfWages}) are more than gross wages (₹${gross}).`);
    rows.push({
      uan, name, gross, epf_wages: epfWages, eps_wages: Math.min(epfWages, PF_CEILING), edli_wages: Math.min(epfWages, PF_CEILING),
      epf_ee: R(Number(s.pf_employee)), eps: R(Number(s.pf_eps)), epf_er_diff: R(Number(s.pf_epf)), ncp_days: ncp, refund: 0, employee_code: s.emp_code,
    });
  }
  if (renamed) warnings.push(`${renamed} name(s) were changed to capital letters and spaces only, as the ECR requires. They must still match the name in the member's UAN record.`);
  if (fractional) warnings.push(`${fractional} employee(s) have part-day loss of pay; non-contributory days are rounded to whole days.`);
  if (!rows.length) warnings.push('No employee has PF wages in this month, so there is nothing to upload.');
  if (rows.some((r) => r.epf_wages > PF_CEILING)) warnings.push('Some members contribute on wages above ₹15,000. EPS and EDLI wages are capped at ₹15,000; a higher-pension option is not modelled.');

  // The challan by account, the way EPFO's payment page lists it.
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const ee = sum('epf_ee'), er = sum('epf_er_diff'), eps = sum('eps');
  const edli = R(slips.reduce((t, s) => t + (Number(s.pf_wages) > 0 ? Number(s.edli) : 0), 0));
  const admin = R(Number(run.pf_admin));
  const challan = {
    ac01_employee: ee, ac01_employer: er, ac10_eps: eps, ac02_admin: admin, ac21_edli: edli, ac22_edli_admin: 0,
    total: ee + er + eps + admin + edli,
  };
  // What the member rows add up to must be what the payroll run recorded (the admin charge comes from the run itself).
  if (rows.length && (ee !== R(Number(run.pf_employee)) || er + eps !== R(Number(run.pf_employer)) || edli !== R(Number(run.edli))))
    errors.push('The contributions in the file do not add up to the payroll run\'s PF totals. Recalculate the payroll before uploading.');
  warnings.push('EPFO recomputes the admin charge and EDLI contribution when you upload, so the challan amount can differ from this by a few rupees.');
  warnings.push('Assumes every member is an EPS member under 58 (EPS wages are capped at ₹15,000).');

  const text = rows.map((r) => [r.uan, r.name, r.gross, r.epf_wages, r.eps_wages, r.edli_wages, r.epf_ee, r.eps, r.epf_er_diff, r.ncp_days, r.refund].join('#~#')).join('\r\n') + (rows.length ? '\r\n' : '');
  return {
    rows, errors: [...new Set(errors)], warnings: [...new Set(warnings)], challan, text,
    totals: { members: rows.length, gross: sum('gross'), epf_wages: sum('epf_wages'), eps_wages: sum('eps_wages'), ncp_days: sum('ncp_days') },
  };
}

export const ECR_CSV = [['uan', 'UAN'], ['name', 'Member name'], ['gross', 'Gross wages'], ['epf_wages', 'EPF wages'], ['eps_wages', 'EPS wages'], ['edli_wages', 'EDLI wages'],
  ['epf_ee', 'EPF contribution (member)'], ['eps', 'EPS contribution'], ['epf_er_diff', 'EPF-EPS difference (employer)'], ['ncp_days', 'NCP days'], ['refund', 'Refund of advances']];

/** ESI contribution rows for one payroll month: employees covered by the Act in that month. */
export function buildEsi({ month, run, slips, employees }) {
  const errors = [], warnings = [];
  if (!run) return { rows: [], errors: [`There is no finalized payroll for ${month}.`], warnings, summary: null };
  const empBy = new Map(employees.map((e) => [e.id, e]));
  const end = monthEnd(month);

  const rows = [];
  const seen = new Map();
  for (const s of slips) {
    if (!s.esi_covered) continue;
    const emp = empBy.get(s.employee_id) ?? {};
    const label = `${s.emp_name} (${s.emp_code})`;
    const ip = String(emp.esi_no ?? '').trim();
    if (!ip) errors.push(`${label} has no ESI insurance number.`);
    else if (!ESI_IP_RE.test(ip)) errors.push(`${label}: the ESI number "${ip}" must be 10 or 17 digits.`);
    else if (seen.has(ip)) errors.push(`${label} and ${seen.get(ip)} have the same ESI number ${ip}.`);
    else seen.set(ip, label);

    const paidDays = Number(s.paid_days);
    const days = Math.ceil(paidDays);
    if (!Number.isInteger(paidDays)) warnings.push(`${label} has part-day loss of pay: days are rounded up to ${days}.`);
    const exit = emp.exit_date ? String(emp.exit_date).slice(0, 10) : null;
    const leftThisMonth = !!exit && exit <= end;
    // A reason is required when no wages were paid for the month: 1 = on leave, 2 = left service.
    const reason = days === 0 ? (leftThisMonth ? 2 : 1) : 0;
    rows.push({
      ip_number: ip, name: s.emp_name, days, wages: R(Number(s.gross)), reason_code: reason, last_working_day: leftThisMonth ? dmy(exit) : '',
      employee_code: s.emp_code, ee: R(Number(s.esi_employee)), er: R(Number(s.esi_employer)),
    });
  }
  if (!rows.length) warnings.push('No employee is covered by ESI in this month, so there is nothing to upload.');

  const ee = rows.reduce((t, r) => t + r.ee, 0), er = rows.reduce((t, r) => t + r.er, 0);
  const summary = { members: rows.length, wages: rows.reduce((t, r) => t + r.wages, 0), employee_contribution: ee, employer_contribution: er, total: ee + er };
  if (rows.length && summary.total !== R(Number(run.esi_employee) + Number(run.esi_employer)))
    errors.push('The contributions do not add up to the payroll run\'s ESI total. Recalculate the payroll before uploading.');
  warnings.push('The ESIC portal calculates the contribution itself (0.75% from the employee and 3.25% from the employer, rounded up) from the wages you upload.');
  warnings.push('An employee who earns above ₹21,000 during a contribution period stays covered until that period ends; this build drops them as soon as the monthly wage limit is crossed.');
  return { rows, errors: [...new Set(errors)], warnings: [...new Set(warnings)], summary };
}

// The headers of ESIC's monthly contribution template, in its order.
export const ESI_CSV = [
  ['ip_number', 'IP Number'], ['name', 'IP Name'], ['days', 'No of Days for which wages paid/payable during the month'], ['wages', 'Total Monthly Wages'],
  ['reason_code', 'Reason Code for Zero workings days(numeric only; provide 0 for all other reasons)'], ['last_working_day', 'Last Working Day (Format DD/MM/YYYY or DD-MM-YYYY)'],
];

export const ecrCsv = (rows) => toCsv(rows, ECR_CSV);
export const esiCsv = (rows) => toCsv(rows, ESI_CSV);
