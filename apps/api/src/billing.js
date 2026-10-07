// Subscription maths: dates, status, upgrade credit, and quotes with GST. Pure functions; money in integer paise, dates 'YYYY-MM-DD'.
import { ALLOWED_MONTHS, GRACE_DAYS, GST_PCT, PLANS } from './plans.js';

export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => paise / 100;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

const iso = (t) => new Date(t).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const addDays = (d, n) => iso(Date.parse(d) + n * 86400000);

/** Same day n months later, clamped to the end of a shorter month (31 Jan + 1 month = 28 Feb). */
export function addMonths(d, n) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
  const t = new Date(Date.UTC(y, m + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last)));
}

/** Last day of access for a period of `months` starting on `start`. */
export const periodEnd = (start, months) => addDays(addMonths(start, months), -1);

/**
 * Where a company stands today.
 * sub: { plan_code, trial_ends, period_end }.
 * trialing | active | grace (paid period ended within GRACE_DAYS) | expired. Expired companies keep read access.
 */
export function subscriptionStatus(sub, today) {
  const paid = sub.plan_code !== 'trial';
  let status, daysLeft = null;
  if (paid && sub.period_end >= today) { status = 'active'; daysLeft = daysBetween(today, sub.period_end); }
  else if (paid && daysBetween(sub.period_end, today) <= GRACE_DAYS) { status = 'grace'; daysLeft = -daysBetween(sub.period_end, today); }
  else if (!paid && sub.trial_ends >= today) { status = 'trialing'; daysLeft = daysBetween(today, sub.trial_ends); }
  else status = 'expired';
  return { status, plan: sub.plan_code, daysLeft, writable: status !== 'expired' };
}

/**
 * Value of paid-for time that has not been used yet, in paise. invoices: paid, not yet credited, current plan:
 * [{ taxable (rupees), period_start, period_end }]. A period in the future is entirely unused.
 */
export function unusedCredit(invoices, today) {
  let credit = 0;
  for (const inv of invoices) {
    const total = daysBetween(inv.period_start, inv.period_end) + 1;
    const remaining = today < inv.period_start ? total : Math.max(0, daysBetween(today, inv.period_end));
    credit += Math.round((toPaise(inv.taxable) * remaining) / total);
  }
  return credit;
}

/**
 * Price a purchase.
 *  - no paid period running (trial, grace, expired): a new period starting today
 *  - same plan while active: a renewal that starts the day after the current period ends
 *  - higher plan while active: an upgrade starting today, with the unused value of the current plan credited
 *  - lower plan while active: refused until the current period ends
 */
export function quote({ plan, months, sub, creditable = [], today, providerState, customerState, accountType = 'individual' }) {
  const target = PLANS[plan];
  if (!target || !target.purchasable) throw err(400, 'Unknown plan');
  if (target.audience !== accountType) throw err(400, `${target.name} is not available for ${accountType} accounts`, 'PLAN_AUDIENCE');
  if (!ALLOWED_MONTHS.includes(months)) throw err(400, `Billing period must be ${ALLOWED_MONTHS.join(', ')} months`);

  const st = subscriptionStatus(sub, today);
  const current = PLANS[sub.plan_code];
  let kind = 'new', start = today, credit = 0, credited = [];
  if (st.status === 'active') {
    if (plan === sub.plan_code) { kind = 'renewal'; start = addDays(sub.period_end, 1); }
    else if (target.tier > current.tier) {
      kind = 'upgrade';
      credit = unusedCredit(creditable, today);
      credited = creditable.map((c) => c.id);
    } else {
      throw err(409, `You are on ${current.name} until ${sub.period_end}. You can switch to ${target.name} after that, or renew ${current.name} now.`, 'DOWNGRADE_LATER');
    }
  }

  const base = toPaise(target.monthly) * months;
  if (credit >= base) throw err(409, `Your unused ${current.name} credit (₹${toRupees(credit)}) covers this period: choose a longer one.`, 'CREDIT_EXCEEDS_PRICE');
  const taxable = base - credit;
  const tax = Math.round((taxable * GST_PCT) / 100);
  const intra = providerState === customerState;
  const half = Math.floor(tax / 2);
  const cgst = intra ? half : 0, sgst = intra ? tax - half : 0, igst = intra ? 0 : tax;
  return {
    kind, plan, months, period_start: start, period_end: periodEnd(start, months),
    base, credit, taxable, cgst, sgst, igst, total: taxable + tax, gst_pct: GST_PCT, credited_ids: credited,
  };
}

/** Quote in rupees for API responses. */
export const quoteForApi = (q) => ({
  ...q, base: toRupees(q.base), credit: toRupees(q.credit), taxable: toRupees(q.taxable),
  cgst: toRupees(q.cgst), sgst: toRupees(q.sgst), igst: toRupees(q.igst), total: toRupees(q.total),
});

/**
 * How many companies one login may manage right now. Individuals always have one. A consultant gets the slab they are
 * paying for; during the free trial they may manage up to the smallest slab so they can try the product with real clients.
 */
export function companyLimit({ accountType, sub, today }) {
  if (accountType !== 'consultant') return 1;
  const st = subscriptionStatus(sub, today);
  if (st.status === 'trialing') return PLANS.consultant_5.max_companies;
  return PLANS[sub.plan_code].max_companies;
}
