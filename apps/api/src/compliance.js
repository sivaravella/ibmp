// Compliance rules engine: statutory due dates generated per company profile and financial year.
// Pure functions, no database. Dates are 'YYYY-MM-DD' strings.
//
// These are the *default statutory* due dates. The government frequently extends them by notification,
// so every item supports a per-item override (stored separately) rather than editing the rule.
// Not modelled: state Professional Tax (varies by state), ROC filings, late fees/interest, holiday adjustment.

export const CATEGORIES = ['GST', 'TDS', 'PF', 'ESI', 'Income Tax', 'Custom'];

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
/** date(y, m, d) with m 1-12; months beyond 12 roll into the next year. */
const date = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

// QRMP: 22nd for these state codes (GST "Category X" states and UTs), 24th for the rest.
const QRMP_22 = new Set(['22', '23', '24', '25', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37']);

export function parseFy(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy ?? ''));
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) return null;
  return Number(m[1]);
}

/** Financial year label containing a date, e.g. '2026-10-06' -> '2026-27'. */
export function fyOf(isoDate) {
  const y = Number(isoDate.slice(0, 4)), mo = Number(isoDate.slice(5, 7));
  const s = mo >= 4 ? y : y - 1;
  return `${s}-${pad((s + 1) % 100)}`;
}
export const prevFy = (fy) => { const s = parseFy(fy) - 1; return `${s}-${pad((s + 1) % 100)}`; };

export const DEFAULT_SETTINGS = { gst_frequency: 'monthly', tds_deductor: false, pf: false, esi: false, advance_tax: true, tax_audit: false, tds_nonsalary: false };

/**
 * Items for one financial year. company: { gstin, state_code }. Returns
 * [{ rule_code, period_key, name, category, period_label, due, note?, link? }] sorted by due date.
 */
export function generateItems(company, settings, fy) {
  const s0 = parseFy(fy);
  if (s0 === null) throw new Error('Invalid financial year');
  const st = { ...DEFAULT_SETTINGS, ...settings };
  const out = [];
  const add = (rule_code, period_key, name, category, period_label, due, extra = {}) =>
    out.push({ rule_code, period_key, name, category, period_label, due, ...extra });

  // The 12 months of the FY, Apr..Mar.
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = ((i + 3) % 12) + 1;
    return { y: m >= 4 ? s0 : s0 + 1, m, key: `${m >= 4 ? s0 : s0 + 1}-${pad(m)}`, label: `${MONTH[m - 1]} ${m >= 4 ? s0 : s0 + 1}` };
  });
  const quarters = [
    { q: 1, label: `Q1 (Apr-Jun ${s0})`, end: { y: s0, m: 6 }, months: months.slice(0, 3) },
    { q: 2, label: `Q2 (Jul-Sep ${s0})`, end: { y: s0, m: 9 }, months: months.slice(3, 6) },
    { q: 3, label: `Q3 (Oct-Dec ${s0})`, end: { y: s0, m: 12 }, months: months.slice(6, 9) },
    { q: 4, label: `Q4 (Jan-Mar ${s0 + 1})`, end: { y: s0 + 1, m: 3 }, months: months.slice(9, 12) },
  ];

  if (company.gstin) {
    if (st.gst_frequency === 'quarterly') {
      const day3b = QRMP_22.has(company.state_code) ? 22 : 24;
      for (const q of quarters) {
        const key = `${s0}-Q${q.q}`;
        add('GSTR1_Q', key, `GSTR-1 (quarterly) - ${q.label}`, 'GST', q.label, date(q.end.y, q.end.m + 1, 13));
        add('GSTR3B_Q', key, `GSTR-3B (quarterly) - ${q.label}`, 'GST', q.label, date(q.end.y, q.end.m + 1, day3b));
        for (const mo of q.months.slice(0, 2))   // first two months of each quarter: pay by challan PMT-06
          add('PMT06', mo.key, `GST tax payment PMT-06 - ${mo.label}`, 'GST', mo.label, date(mo.y, mo.m + 1, 25));
      }
    } else {
      for (const mo of months) {
        add('GSTR1_M', mo.key, `GSTR-1 - ${mo.label}`, 'GST', mo.label, date(mo.y, mo.m + 1, 11), { link: { page: 'gst', period: mo.key } });
        add('GSTR3B_M', mo.key, `GSTR-3B - ${mo.label}`, 'GST', mo.label, date(mo.y, mo.m + 1, 20), { link: { page: 'gst', period: mo.key } });
      }
    }
    add('GSTR9', `FY${fy}`, `GSTR-9 annual return - FY ${fy}`, 'GST', `FY ${fy}`, date(s0 + 1, 12, 31),
      { note: 'Mandatory above ₹2 crore turnover; optional below.' });
  }

  if (st.tds_deductor) {
    for (const mo of months)   // March TDS is due 30 April, other months the 7th of the next month
      add('TDS_PAY', mo.key, `TDS payment - ${mo.label}`, 'TDS', mo.label, mo.m === 3 ? date(mo.y, 4, 30) : date(mo.y, mo.m + 1, 7));
    const ret = [[1, date(s0, 7, 31)], [2, date(s0, 10, 31)], [3, date(s0 + 1, 1, 31)], [4, date(s0 + 1, 5, 31)]];
    for (const [q, due] of ret)
      add('TDS_RET', `${s0}-Q${q}`, `TDS return (24Q/26Q) - ${quarters[q - 1].label}`, 'TDS', quarters[q - 1].label, due);
    add('FORM16', `FY${fy}`, `Form 16 to employees - FY ${fy}`, 'TDS', `FY ${fy}`, date(s0 + 1, 6, 15), { note: 'Part A comes from TRACES after the Q4 statement is processed.' });
  }

  if (st.tds_nonsalary) {   // TDS on contractors, professionals, rent and the like: Form 26Q
    for (const mo of months)
      add('TDS_PAY_NS', mo.key, `TDS payment (non-salary) - ${mo.label}`, 'TDS', mo.label, mo.m === 3 ? date(mo.y, 4, 30) : date(mo.y, mo.m + 1, 7), { link: { page: 'tds' } });
    for (const [q, due] of [[1, date(s0, 7, 31)], [2, date(s0, 10, 31)], [3, date(s0 + 1, 1, 31)], [4, date(s0 + 1, 5, 31)]])
      add('TDS_RET_26Q', `${s0}-Q${q}`, `TDS return 26Q - ${quarters[q - 1].label}`, 'TDS', quarters[q - 1].label, due, { link: { page: 'tds' } });
  }

  if (st.pf) for (const mo of months) add('PF', mo.key, `PF contribution & ECR - ${mo.label}`, 'PF', mo.label, date(mo.y, mo.m + 1, 15));
  if (st.esi) for (const mo of months) add('ESI', mo.key, `ESI contribution - ${mo.label}`, 'ESI', mo.label, date(mo.y, mo.m + 1, 15));

  if (st.advance_tax) {
    [[6, 15], [9, 45], [12, 75], [3, 100]].forEach(([m, pct]) => {
      const y = m === 3 ? s0 + 1 : s0;
      add('ADV_TAX', `${s0}-${pct}`, `Advance tax - ${pct}% cumulative`, 'Income Tax', `Due ${MONTH[m - 1]} ${y}`, date(y, m, 15),
        { note: 'Applies if estimated tax liability is ₹10,000 or more.' });
    });
  }

  if (st.tax_audit) {
    add('TAX_AUDIT', `FY${fy}`, `Tax audit report (3CD) - FY ${fy}`, 'Income Tax', `FY ${fy}`, date(s0 + 1, 9, 30));
    add('ITR', `FY${fy}`, `Income tax return (audit case) - FY ${fy}`, 'Income Tax', `FY ${fy}`, date(s0 + 1, 10, 31));
  } else {
    add('ITR', `FY${fy}`, `Income tax return - FY ${fy}`, 'Income Tax', `FY ${fy}`, date(s0 + 1, 7, 31));
  }

  return out.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const DUE_SOON_DAYS = 7;

/** Merge a generated/custom item with the user's record and compute its status as of `today`. */
export function withStatus(item, rec, today) {
  const due = rec?.due_override || item.due;
  const completed_on = rec?.completed_on || null;
  let status;
  if (completed_on) status = 'completed';
  else if (due < today) status = 'overdue';
  else if (daysBetween(today, due) <= DUE_SOON_DAYS) status = 'due_soon';
  else status = 'upcoming';
  return {
    ...item,
    statutory_due: item.due,
    due,
    overridden: !!rec?.due_override,
    override_note: rec?.override_note ?? null,
    completed_on,
    filed_late: !!completed_on && completed_on > due,
    reference: rec?.reference ?? null,
    notes: rec?.notes ?? null,
    status,
    days_to_due: completed_on ? null : daysBetween(today, due),   // negative when overdue
  };
}
