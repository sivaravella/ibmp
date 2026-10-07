// Once a return for a month is submitted or filed, documents dated in that month can no longer be added: they would change
// figures that have already gone to the GST portal. They belong in a later period (or in an amendment).
const NAMES = { GSTR1: 'GSTR-1', GSTR3B: 'GSTR-3B' };

export async function assertPeriodOpen(q, companyId, types, date, what) {
  const period = String(date).slice(0, 7);
  const hit = (await q.query(
    `SELECT return_type, status FROM gst_filings WHERE company_id=$1 AND period=$2 AND status IN ('submitted','filed') AND return_type IN (${types.map((_, i) => `$${i + 3}`).join(',')})`,
    [companyId, period, ...types])).rows[0];
  if (hit) {
    throw Object.assign(new Error(
      `${NAMES[hit.return_type]} for ${period} is already ${hit.status}, so a ${what} dated in that month cannot be recorded. Date it in the current period, or amend it through a later return.`),
    { status: 409, code: 'PERIOD_FILED' });
  }
}
