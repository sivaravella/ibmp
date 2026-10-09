// Financial reports built from the posted ledger: Profit & Loss, Balance Sheet and aged Outstanding.
// All arithmetic is in integer paise; the figures leave this module as rupees with two decimals.
import { ymd } from './util.js';
import { A } from './ledger.js';
import { fyOf, parseFy } from './compliance.js';

const paise = (n) => Math.round(Number(n) * 100);
export const rupees = (p) => Math.round(p) / 100;
const pad = (n) => String(n).padStart(2, '0');

// ---------- dates ----------
export const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toUtc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
/** Same day a number of years earlier, clamped (29 Feb becomes 28 Feb). */
export const addYears = (s, n) => {
  const y = Number(s.slice(0, 4)) + n, m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
};

/** The Indian financial year (1 April to 31 March) that contains a date. */
export function fyRange(date) {
  const s = parseFy(fyOf(date));
  return { fy: fyOf(date), from: `${s}-04-01`, to: `${s + 1}-03-31` };
}

/** The comparative period: the same dates a year earlier when the range starts on 1 April, otherwise an equal-length period just before. */
export function previousPeriod(from, to) {
  if (from.slice(5) === '04-01' && to < addYears(from, 1)) return { from: addYears(from, -1), to: addYears(to, -1) };
  const len = daysBetween(from, to) + 1;
  const pTo = addDays(from, -1);
  return { from: addDays(pTo, -(len - 1)), to: pTo };
}

/** The last day of the financial year before the one containing asOf (the comparative balance sheet date). */
export const previousYearEnd = (asOf) => addDays(fyRange(asOf).from, -1);

// ---------- loading ----------
export async function loadAccounts(q, companyId) {
  return (await q.query('SELECT id, code, name, type, normal FROM accounts WHERE company_id=$1 ORDER BY code', [companyId])).rows;
}

/** Debit and credit totals in paise per account id, for entries dated in [from, to] (either end optional). */
export async function loadTotals(q, companyId, { from, to } = {}) {
  const args = [companyId];
  let where = 'e.company_id=$1';
  if (from) { args.push(from); where += ` AND e.date >= $${args.length}`; }
  if (to) { args.push(to); where += ` AND e.date <= $${args.length}`; }
  const rows = (await q.query(
    `SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
     WHERE ${where} GROUP BY l.account_id`, args)).rows;
  return new Map(rows.map((r) => [r.account_id, { d: paise(r.d), c: paise(r.c) }]));
}

export async function loadCompany(q, companyId) {
  const c = (await q.query('SELECT name, legal_name, trade_name, gstin, state_code, addr1, addr2, loc, pin FROM companies WHERE id=$1', [companyId])).rows[0] ?? {};
  return { name: c.legal_name || c.name || '', tradeName: c.trade_name || null, gstin: c.gstin || null, stateCode: c.state_code || null,
    address: [c.addr1, c.addr2, c.loc, c.pin].filter(Boolean).join(', ') || null };
}

// ---------- layout helpers ----------
/** Net movement in an account's natural direction: credit minus debit for income and liabilities, debit minus credit otherwise. */
const natural = (a, t) => {
  const d = t?.d ?? 0, c = t?.c ?? 0;
  return a.type === 'income' || a.type === 'liability' || a.type === 'equity' ? c - d : d - c;
};

/**
 * Turns groups into report rows. groups: [{ key, label, lines: [{ code, name, cur, prev }], total? }].
 * Lines that are zero in both columns are left out (a group keeps its total even when empty).
 */
function groupRows(groups, hasPrev) {
  const rows = [];
  for (const g of groups) {
    const lines = g.lines.filter((l) => l.cur !== 0 || (hasPrev && l.prev !== 0) || g.keep?.includes(l.code));
    const cur = g.lines.reduce((s, l) => s + l.cur, 0), prev = g.lines.reduce((s, l) => s + l.prev, 0);
    rows.push({ kind: 'group', level: 0, key: g.key, label: g.label });
    for (const l of lines) rows.push({ kind: 'line', level: 1, code: l.code, label: l.name, amount: rupees(l.cur), previous: hasPrev ? rupees(l.prev) : null });
    rows.push({ kind: 'subtotal', level: 0, key: g.key, label: g.total ?? `Total ${g.label.toLowerCase()}`, amount: rupees(cur), previous: hasPrev ? rupees(prev) : null });
    g.cur = cur; g.prev = prev;
  }
  return rows;
}

const line = (a, c, p) => ({ code: a.code, name: a.name, cur: natural(a, c.get(a.id)), prev: p ? natural(a, p.get(a.id)) : 0 });
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// ---------- profit and loss ----------
const SALES = [A.SALES, A.SALES_RET], COGS = [A.PURCHASES, A.PURCH_RET], EMPLOYEE = [A.SALARY_EXP, A.EMPR_CONTRIB_EXP];

/**
 * accounts: the chart; cur / prev: Map from loadTotals for the period and the comparative (prev may be null).
 * Returns { rows, totals } where every figure is in rupees.
 */
export function buildProfitLoss(accounts, cur, prev) {
  const hasPrev = !!prev;
  const inc = accounts.filter((a) => a.type === 'income'), exp = accounts.filter((a) => a.type === 'expense');
  const mk = (list) => list.map((a) => line(a, cur, prev));
  const groups = {
    revenue: { key: 'revenue', label: 'Revenue from operations', total: 'Total revenue from operations', keep: [A.SALES], lines: mk(inc.filter((a) => SALES.includes(a.code))) },
    other: { key: 'otherIncome', label: 'Other income', total: 'Total other income', lines: mk(inc.filter((a) => !SALES.includes(a.code))) },
    cogs: { key: 'costOfGoods', label: 'Cost of goods and purchases', total: 'Net purchases', lines: mk(exp.filter((a) => COGS.includes(a.code))) },
    emp: { key: 'employee', label: 'Employee benefit expenses', total: 'Total employee benefit expenses', lines: mk(exp.filter((a) => EMPLOYEE.includes(a.code))) },
    oth: { key: 'otherExpenses', label: 'Other expenses', total: 'Total other expenses', lines: mk(exp.filter((a) => !COGS.includes(a.code) && !EMPLOYEE.includes(a.code))) },
  };
  const rows = [];
  const push = (r) => rows.push(...r);
  const total = (key, label, c, p, extra = {}) => rows.push({ kind: 'total', level: 0, key, label, amount: rupees(c), previous: hasPrev ? rupees(p) : null, ...extra });

  push(groupRows([groups.revenue, groups.other], hasPrev));
  const incCur = groups.revenue.cur + groups.other.cur, incPrev = groups.revenue.prev + groups.other.prev;
  total('totalIncome', 'Total income', incCur, incPrev);
  push(groupRows([groups.cogs, groups.emp, groups.oth], hasPrev));
  const expCur = groups.cogs.cur + groups.emp.cur + groups.oth.cur, expPrev = groups.cogs.prev + groups.emp.prev + groups.oth.prev;
  total('totalExpenses', 'Total expenses', expCur, expPrev);
  total('profitBeforeTax', incCur - expCur >= 0 ? 'Profit before tax' : 'Loss before tax', incCur - expCur, incPrev - expPrev, { highlight: true });

  const t = (g) => ({ amount: rupees(g.cur), previous: hasPrev ? rupees(g.prev) : null });
  const totals = {
    revenueFromOperations: t(groups.revenue), otherIncome: t(groups.other), totalIncome: { amount: rupees(incCur), previous: hasPrev ? rupees(incPrev) : null },
    costOfGoods: t(groups.cogs), employeeCosts: t(groups.emp), otherExpenses: t(groups.oth),
    totalExpenses: { amount: rupees(expCur), previous: hasPrev ? rupees(expPrev) : null },
    profitBeforeTax: { amount: rupees(incCur - expCur), previous: hasPrev ? rupees(incPrev - expPrev) : null },
  };
  return { rows, totals, empty: !rows.some((r) => r.kind === 'line' && r.amount !== 0) };
}

// ---------- balance sheet ----------
const CASH = [A.CASH, A.BANK], GST_IN = [A.IN_CGST, A.IN_SGST, A.IN_IGST], GST_OUT = [A.OUT_CGST, A.OUT_SGST, A.OUT_IGST];
const STATUTORY = [A.PF_PAYABLE, A.ESI_PAYABLE, A.TDS_PAYABLE, A.PT_PAYABLE, A.TDS_NS_PAYABLE];

/** cur / prev: Maps of totals from the start of the books up to the date. Retained earnings is income less expenses to date. */
export function buildBalanceSheet(accounts, cur, prev) {
  const hasPrev = !!prev;
  const of = (type) => accounts.filter((a) => a.type === type);
  const mk = (list) => list.map((a) => line(a, cur, prev));
  const assets = of('asset'), liab = of('liability'), eq = of('equity');
  const used = new Set();
  const take = (list, codes) => { const r = list.filter((a) => codes.includes(a.code)); r.forEach((a) => used.add(a.id)); return r; };
  const rest = (list) => list.filter((a) => !used.has(a.id));

  const aGroups = [
    { key: 'cash', label: 'Cash and bank balances', total: 'Total cash and bank', keep: [A.CASH, A.BANK], lines: mk(take(assets, CASH)) },
    { key: 'receivables', label: 'Trade receivables', total: 'Total trade receivables', keep: [A.DEBTORS], lines: mk(take(assets, [A.DEBTORS])) },
    { key: 'gstCredit', label: 'GST input credit', total: 'Total GST input credit', lines: mk(take(assets, GST_IN)) },
    { key: 'advances', label: 'Loans and advances', total: 'Total loans and advances', lines: mk(take(assets, [A.EMP_ADVANCES])) },
  ];
  const otherAssets = rest(assets);
  aGroups.push({ key: 'otherAssets', label: 'Other assets', total: 'Total other assets', lines: mk(otherAssets) });

  used.clear();
  const lGroups = [
    { key: 'payables', label: 'Trade payables', total: 'Total trade payables', keep: [A.CREDITORS], lines: mk(take(liab, [A.CREDITORS])) },
    { key: 'gstPayable', label: 'GST payable', total: 'Total GST payable', lines: mk(take(liab, GST_OUT)) },
    { key: 'employeePayables', label: 'Salary payable', total: 'Total salary payable', lines: mk(take(liab, [A.SALARY_PAYABLE])) },
    { key: 'statutory', label: 'Statutory dues (PF, ESI, TDS, professional tax)', total: 'Total statutory dues', lines: mk(take(liab, STATUTORY)) },
  ];
  lGroups.push({ key: 'otherLiabilities', label: 'Other liabilities', total: 'Total other liabilities', lines: mk(rest(liab)) });

  // Retained earnings: everything income and expense up to the date, in the natural (profit positive) direction.
  const profit = (m) => {
    if (!m) return 0;
    return sum(accounts.filter((a) => a.type === 'income'), (a) => natural(a, m.get(a.id))) - sum(accounts.filter((a) => a.type === 'expense'), (a) => natural(a, m.get(a.id)));
  };
  const retained = { code: null, name: 'Retained profit / (loss) to date', cur: profit(cur), prev: profit(prev) };
  const eGroups = [{ key: 'equity', label: "Owner's equity", total: "Total owner's equity",
    keep: [A.CAPITAL], lines: [...mk(eq), retained] }];

  const rows = [];
  rows.push({ kind: 'section', level: 0, key: 'assetsHead', label: 'ASSETS' });
  rows.push(...groupRows(aGroups, hasPrev));
  const ta = sum(aGroups, (g) => g.cur), tap = sum(aGroups, (g) => g.prev);
  rows.push({ kind: 'total', level: 0, key: 'totalAssets', label: 'Total assets', amount: rupees(ta), previous: hasPrev ? rupees(tap) : null });
  rows.push({ kind: 'section', level: 0, key: 'liabHead', label: 'EQUITY AND LIABILITIES' });
  rows.push(...groupRows(eGroups, hasPrev));
  rows.push(...groupRows(lGroups, hasPrev));
  const tl = sum(lGroups, (g) => g.cur), tlp = sum(lGroups, (g) => g.prev);
  const te = eGroups[0].cur, tep = eGroups[0].prev;
  rows.push({ kind: 'total', level: 0, key: 'totalLiabilities', label: 'Total liabilities', amount: rupees(tl), previous: hasPrev ? rupees(tlp) : null });
  rows.push({ kind: 'total', level: 0, key: 'totalEquityLiabilities', label: 'Total equity and liabilities', amount: rupees(tl + te), previous: hasPrev ? rupees(tlp + tep) : null, highlight: true });

  const difference = ta - (tl + te);
  const totals = {
    totalAssets: rupees(ta), totalLiabilities: rupees(tl), totalEquity: rupees(te), retainedEarnings: rupees(retained.cur),
    previous: hasPrev ? { totalAssets: rupees(tap), totalLiabilities: rupees(tlp), totalEquity: rupees(tep), retainedEarnings: rupees(retained.prev) } : null,
  };
  return { rows, totals, balanced: difference === 0, difference: rupees(difference), empty: ta === 0 && tl === 0 && te === 0 };
}

// ---------- outstanding ----------
export const BUCKETS = [['b0', '0-30 days', 0, 30], ['b1', '31-60 days', 31, 60], ['b2', '61-90 days', 61, 90], ['b3', 'Over 90 days', 91, Infinity]];

/**
 * Open amount on each invoice (receivables) and bill (payables) at the date: the document total less what was paid or credited by then
 * (and, on bills, TDS held back). Aged from the document date. Returns { receivables, payables } each { parties, totals }.
 */
export async function loadOutstanding(q, companyId, asOf) {
  const side = async (table, payKey, noteKind, deductTds) => {
    const docs = (await q.query(
      `SELECT d.id, d.number, d.date, d.total, ${deductTds ? 'd.tds' : '0 AS tds'}, d.party_id, p.name AS party_name
       FROM ${table} d JOIN parties p ON p.id=d.party_id WHERE d.company_id=$1 AND d.date <= $2 ORDER BY d.date, d.id`, [companyId, asOf])).rows;
    const paid = new Map();
    const add = (m, id, v) => m.set(id, (m.get(id) ?? 0) + paise(v));
    for (const r of (await q.query(`SELECT ${payKey} AS id, amount FROM payments WHERE company_id=$1 AND ${payKey} IS NOT NULL AND date <= $2`, [companyId, asOf])).rows) add(paid, r.id, r.amount);
    const credited = new Map();
    for (const r of (await q.query(`SELECT ${payKey} AS id, total FROM notes WHERE company_id=$1 AND kind=$2 AND ${payKey} IS NOT NULL AND date <= $3`, [companyId, noteKind, asOf])).rows) add(credited, r.id, r.total);

    const byParty = new Map();
    for (const d of docs) {
      const open = paise(d.total) - (paid.get(d.id) ?? 0) - (credited.get(d.id) ?? 0) - paise(d.tds);
      if (open <= 0) continue;
      const date = ymd(d.date), days = daysBetween(date, asOf);
      const b = BUCKETS.find(([, , lo, hi]) => days >= lo && days <= hi) ?? BUCKETS[0];
      let p = byParty.get(d.party_id);
      if (!p) { p = { partyId: d.party_id, name: d.party_name, b0: 0, b1: 0, b2: 0, b3: 0, total: 0, documents: [] }; byParty.set(d.party_id, p); }
      p[b[0]] += open; p.total += open;
      p.documents.push({ number: d.number, date, days, bucket: b[0], open: rupees(open) });
    }
    const parties = [...byParty.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const totals = { b0: 0, b1: 0, b2: 0, b3: 0, total: 0 };
    for (const p of parties) for (const k of Object.keys(totals)) totals[k] += p[k];
    const out = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? rupees(v) : v]));
    return { parties: parties.map((p) => ({ ...out(p), documents: p.documents })), totals: out(totals) };
  };
  return {
    receivables: await side('invoices', 'invoice_id', 'credit', false),
    payables: await side('purchases', 'purchase_id', 'debit', true),
  };
}
