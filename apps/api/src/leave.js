// Leave balance engine. Pure functions; dates are 'YYYY-MM-DD'; the leave year is the financial year (April-March).
//
// Rules (all configurable per leave type except the month-counting convention):
//  - A month earns credit if the employee is on the books on its 15th, so joiners after the 15th start next month and
//    leavers before the 15th stop earning that month.
//  - 'monthly' types accrue quota/12 for each counted month up to the as-of date; 'annual' types credit the whole
//    year's quota up front, pro-rated by counted months for joiners and leavers. Totals round to the nearest half day.
//  - At each year end the balance carries forward up to the type's cap; the rest lapses. Negative balances never carry.
//  - Balance = carried + accrued + adjustments - approved leave taken.
// Not modelled: sandwich rules, probation restrictions, encashment pay-outs, compensatory off.

import { fyOf, parseFy } from './compliance.js';

export const roundHalf = (x) => Math.round(x * 2) / 2;
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' keys for April..March of a leave year such as '2026-27'. */
export function yearMonths(year) {
  const s0 = parseFy(year);
  return Array.from({ length: 12 }, (_, i) => { const m = ((i + 3) % 12) + 1; return `${m >= 4 ? s0 : s0 + 1}-${pad(m)}`; });
}
export const nextYear = (year) => { const s = parseFy(year) + 1; return `${s}-${pad((s + 1) % 100)}`; };
export const yearEnd = (year) => `${parseFy(year) + 1}-03-31`;

/** True if the employee is on the books on the 15th of the month. */
export const monthCounts = (emp, key) => emp.doj <= `${key}-15` && (!emp.exit_date || emp.exit_date >= `${key}-15`);

export function accruedFor(type, emp, year, asOf) {
  if (type.quota === null || type.quota === undefined) return 0;
  const keys = yearMonths(year).filter((k) => type.accrual === 'annual' || k <= asOf.slice(0, 7));
  return roundHalf((Number(type.quota) * keys.filter((k) => monthCounts(emp, k)).length) / 12);
}

/**
 * Balance of one leave type for an employee in a leave year, as of a date.
 * taken / adj: Map(year -> days). Walks forward from the employee's first year so carry-forward is applied each year end.
 */
export function balanceFor({ type, emp, year, asOf, taken = new Map(), adj = new Map() }) {
  const t = Number(taken.get(year) ?? 0), a = Number(adj.get(year) ?? 0);
  if (type.quota === null || type.quota === undefined) return { unlimited: true, carried: 0, accrued: 0, adjustments: a, taken: t, balance: null };

  let y = fyOf(emp.doj), carry = 0;
  if (parseFy(y) > parseFy(year)) return { unlimited: false, carried: 0, accrued: 0, adjustments: a, taken: t, balance: a - t };
  for (let guard = 0; guard < 80; guard++) {
    const accrued = accruedFor(type, emp, y, y === year ? asOf : yearEnd(y));
    const ya = Number(adj.get(y) ?? 0), yt = Number(taken.get(y) ?? 0);
    if (y === year) return { unlimited: false, carried: carry, accrued, adjustments: ya, taken: yt, balance: carry + accrued + ya - yt };
    carry = Math.min(Math.max(carry + accrued + ya - yt, 0), Number(type.carry_forward_max ?? 0));
    y = nextYear(y);
  }
  throw new Error('Leave year out of range');
}

/** Dates from..to inclusive. */
export function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Attendance code written for a leave day. Paid leave is never loss of pay; unpaid leave always is. */
export const attendanceMark = (paid, fraction) => (paid ? (fraction === 1 ? 'L' : 'HL') : (fraction === 1 ? 'A' : 'HD'));

export const DEFAULT_TYPES = [
  // Sensible starting points, not statutory entitlements: state Shops & Establishments rules differ. Edit to match your policy.
  { code: 'CL', name: 'Casual Leave', paid: true, quota: 12, accrual: 'monthly', carry_forward_max: 0 },
  { code: 'SL', name: 'Sick Leave', paid: true, quota: 6, accrual: 'annual', carry_forward_max: 0 },
  { code: 'EL', name: 'Earned Leave', paid: true, quota: 15, accrual: 'monthly', carry_forward_max: 30 },
  { code: 'LWP', name: 'Leave Without Pay', paid: false, quota: null, accrual: 'monthly', carry_forward_max: 0 },
];
