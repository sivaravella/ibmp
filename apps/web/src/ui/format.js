// Number and date formatting shared by every screen.
const inrFull = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export const inr = (n) => inrFull.format(Number(n) || 0);
export const inrRound = (n) => inrWhole.format(Number(n) || 0);

/** Compact rupees for charts and KPI cards, in the Indian system: ₹4.5 K, ₹3.05 L, ₹1.2 Cr. */
export function inrCompact(n) {
  const v = Number(n) || 0, a = Math.abs(v), sign = v < 0 ? '−' : '';
  const f = (x, d) => String(Number(x.toFixed(d)));
  if (a >= 1e7) return `${sign}₹${f(a / 1e7, 2)} Cr`;
  if (a >= 1e5) return `${sign}₹${f(a / 1e5, 2)} L`;
  if (a >= 1e3) return `${sign}₹${f(a / 1e3, 1)} K`;
  return `${sign}₹${f(a, 0)}`;
}

export const num = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);
export const pct = (n, d = 0) => `${(Number(n) || 0).toFixed(d)}%`;

/** '2026-10-05' -> '05-10-2026'. */
export const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10' -> 'Oct'; with the year for January or when asked: 'Jan 26'. */
export const monthLabel = (m, withYear = false) => {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]}${withYear || mo === 1 ? ` ${String(y).slice(2)}` : ''}`;
};

export const initials = (name) => String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

export const greeting = (d = new Date()) => { const h = d.getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
