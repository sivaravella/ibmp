// Attendance helpers. Pure functions; dates are 'YYYY-MM-DD'.
import { employedDays, monthInfo } from './payroll.js';

export const STATUSES = ['P', 'A', 'HD', 'L', 'HL', 'H', 'WO'];
export const LABELS = { P: 'Present', A: 'Absent (loss of pay)', HD: 'Half day (0.5 loss of pay)', L: 'Paid leave', HL: 'Paid half-day leave', H: 'Holiday', WO: 'Week off' };

export function datesInMonth(month) {
  const { days } = monthInfo(month);
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** 0 = Sunday .. 6 = Saturday, independent of the server's time zone. */
export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** First and last date the employee is on the books within the month, or null if not at all. */
export function employmentRange(emp, month) {
  if (employedDays(emp, month) === 0) return null;
  const { start, end } = monthInfo(month);
  return { from: emp.doj > start ? emp.doj : start, to: emp.exit_date && emp.exit_date < end ? emp.exit_date : end };
}

/**
 * Month summary for one employee. marks: Map(date -> status).
 * Only days inside the employment range count. Loss of pay = absent days + half a day per half-day.
 * Unmarked days are counted as present for pay, but reported so they can be reviewed.
 */
export function summarize(marks, emp, month) {
  const out = { P: 0, A: 0, HD: 0, L: 0, HL: 0, H: 0, WO: 0, employed: 0, marked: 0, unmarked: 0, lop: 0 };
  const range = employmentRange(emp, month);
  if (!range) return out;
  for (const d of datesInMonth(month)) {
    if (d < range.from || d > range.to) continue;
    out.employed++;
    const s = marks.get(d);
    if (s) { out[s]++; out.marked++; } else out.unmarked++;
  }
  out.lop = out.A + out.HD / 2;
  return out;
}
