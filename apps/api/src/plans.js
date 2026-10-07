// Plan catalog and billing constants. Prices and tiers come from the project handover (Starter ₹999, Professional ₹2,499,
// Enterprise ₹4,999 per month). Everything else here is an assumption that should be confirmed against the PRD:
//   - prices are exclusive of GST, which is added at GST_PCT
//   - the trial lasts TRIAL_DAYS and includes every feature
//   - HR modules (payroll, attendance, leave) start at Professional; Starter is accounting, GST and compliance
//   - Enterprise adds employee logins, which are not built yet (the feature flag is reserved)
//   - there is no discount for longer billing periods
//   - CONSULTANT SLAB PRICES ARE PLACEHOLDERS: the handover names the slabs (up to 5 and up to 10 companies) but gives no price.
//     Set the two 'monthly' values below before launch. A consultant's client companies are billed through the consultant's own
//     subscription and receive every feature; slab limits count the consultant's own company plus clients (archived ones excluded).

export const GST_PCT = 18;
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 3;                 // full access for this long after a paid period ends, with a warning
export const ALLOWED_MONTHS = [1, 3, 6, 12];
export const RENEWAL_WINDOW_DAYS = 7;

export const PLANS = {
  // audience: who may buy it ('any' = the trial). max_companies: how many companies one login may manage on it.
  trial: { code: 'trial', name: 'Free Trial', tier: 0, monthly: 0, purchasable: false, audience: 'any', max_companies: 1, features: ['accounting', 'hr'],
    highlights: ['Everything in Professional', `${TRIAL_DAYS} days, no card needed`] },
  starter: { code: 'starter', name: 'Starter', tier: 1, monthly: 999, purchasable: true, audience: 'individual', max_companies: 1, features: ['accounting'],
    highlights: ['Invoices, purchases and returns', 'Ledger and trial balance', 'GSTR-1 and GSTR-3B reports', 'Compliance calendar'] },
  professional: { code: 'professional', name: 'Professional', tier: 2, monthly: 2499, purchasable: true, audience: 'individual', max_companies: 1, features: ['accounting', 'hr'],
    highlights: ['Everything in Starter', 'Payroll with PF, ESI and TDS', 'Attendance register', 'Leave management'] },
  enterprise: { code: 'enterprise', name: 'Enterprise', tier: 3, monthly: 4999, purchasable: true, audience: 'individual', max_companies: 1, features: ['accounting', 'hr', 'employee_logins'],
    highlights: ['Everything in Professional', 'Employee logins (coming soon)', 'Priority support'] },
  // PLACEHOLDER PRICES: replace with the real slab prices.
  consultant_5: { code: 'consultant_5', name: 'Consultant: up to 5 companies', tier: 4, monthly: 3999, purchasable: true, audience: 'consultant', max_companies: 5, features: ['accounting', 'hr'],
    highlights: ['Manage up to 5 companies from one login', 'Every Professional feature in each company', 'Practice overview of client deadlines'] },
  consultant_10: { code: 'consultant_10', name: 'Consultant: up to 10 companies', tier: 5, monthly: 6999, purchasable: true, audience: 'consultant', max_companies: 10, features: ['accounting', 'hr'],
    highlights: ['Manage up to 10 companies from one login', 'Every Professional feature in each company', 'Practice overview of client deadlines'] },
};

/** Which plan feature a request path needs. Everything outside the HR modules is 'accounting'. */
export function featureForPath(path) {
  return /^\/(payroll|attendance|leave|statutory)(\/|$)/.test(path) ? 'hr' : 'accounting';
}

export const PLAN_FOR_FEATURE = { hr: 'professional', accounting: 'starter' };
