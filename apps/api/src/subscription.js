import { TRIAL_DAYS } from './plans.js';
import { addDays } from './billing.js';
import { today as todayFn, ymd } from './util.js';

/** The company's subscription row, created as a fresh trial the first time it is needed. */
export async function loadSubscription(q, companyId, today = todayFn()) {
  let row = (await q.query('SELECT * FROM subscriptions WHERE company_id=$1', [companyId])).rows[0];
  if (!row) {
    await q.query('INSERT INTO subscriptions (company_id, trial_ends) VALUES ($1,$2)', [companyId, addDays(today, TRIAL_DAYS)]);
    row = (await q.query('SELECT * FROM subscriptions WHERE company_id=$1', [companyId])).rows[0];
  }
  return {
    ...row,
    trial_ends: ymd(row.trial_ends),
    period_start: row.period_start ? ymd(row.period_start) : null,
    period_end: row.period_end ? ymd(row.period_end) : null,
  };
}
