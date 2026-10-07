import { Router } from 'express';
import { h, httpError, today as todayFn, ymd } from '../util.js';
import { A } from '../ledger.js';

const R2 = (n) => Math.round(Number(n) * 100) / 100;
const month = (d) => ymd(d).slice(0, 7);
/** The `n` months ending with the month of `asOf`, oldest first: ['2026-05', ..., '2026-10']. */
export function monthsBack(asOf, n) {
  const [y, m] = asOf.slice(0, 7).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const t = (y * 12 + (m - 1)) - (n - 1 - i); return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; });
}
const pct = (cur, prev) => (prev > 0 ? R2(((cur - prev) / prev) * 100) : null);
const AGE_BUCKETS = [['0-30', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, Infinity]];
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Figures for the business dashboard: monthly trends, receivables and payables ageing, top customers and items, GST position,
 * cash and where the money went. Aggregated here from the company's own rows for a bounded window (default 12 months).
 */
export function analyticsRoutes(pool) {
  const r = Router();

  r.get('/analytics', h(async (req, res) => {
    const asOf = req.query.asOf ?? todayFn();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) throw httpError(400, 'asOf must be YYYY-MM-DD');
    const n = Math.min(Math.max(Number(req.query.months) || 12, 3), 24);
    const cid = req.user.companyId;
    const months = monthsBack(asOf, n);
    const from = `${months[0]}-01`;
    const blank = () => Object.fromEntries(months.map((m) => [m, 0]));
    const series = () => blank();

    const inv = (await pool.query('SELECT id, party_id, date, taxable, cgst, sgst, igst, total, paid, returned, status FROM invoices WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, asOf])).rows;
    const pur = (await pool.query('SELECT id, party_id, date, taxable, cgst, sgst, igst, total, paid, returned, tds, status FROM purchases WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, asOf])).rows;
    const notes = (await pool.query('SELECT kind, date, taxable, cgst, sgst, igst, total FROM notes WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, asOf])).rows;
    const pays = (await pool.query('SELECT kind, date, amount FROM payments WHERE company_id=$1 AND date >= $2 AND date <= $3', [cid, from, asOf])).rows;

    const sales = series(), salesGst = series(), purchases = series(), purchaseGst = series(), received = series(), paidOut = series(), returnsM = series();
    for (const i of inv) { const m = month(i.date); sales[m] += Number(i.taxable); salesGst[m] += Number(i.cgst) + Number(i.sgst) + Number(i.igst); }
    for (const p of pur) { const m = month(p.date); purchases[m] += Number(p.taxable); purchaseGst[m] += Number(p.cgst) + Number(p.sgst) + Number(p.igst); }
    for (const x of notes) {
      const m = month(x.date), gst = Number(x.cgst) + Number(x.sgst) + Number(x.igst);
      if (x.kind === 'credit') { returnsM[m] += Number(x.taxable); salesGst[m] -= gst; } else purchaseGst[m] -= gst;   // notes reduce output tax / input credit
    }
    for (const x of pays) (x.kind === 'receipt' ? received : paidOut)[month(x.date)] += Number(x.amount);

    // The month in progress is compared with the same days of the month before, never with its full total.
    const curM = months[months.length - 1], prevM = months[months.length - 2], dom = Number(asOf.slice(8, 10));
    const sameDays = (d) => month(d) === prevM && Number(ymd(d).slice(8, 10)) <= dom;
    const prevToDate = { sales: 0, purchases: 0, received: 0, outputGst: 0, inputGst: 0 };
    for (const i of inv) if (sameDays(i.date)) { prevToDate.sales += Number(i.taxable); prevToDate.outputGst += Number(i.cgst) + Number(i.sgst) + Number(i.igst); }
    for (const p of pur) if (sameDays(p.date)) { prevToDate.purchases += Number(p.taxable); prevToDate.inputGst += Number(p.cgst) + Number(p.sgst) + Number(p.igst); }
    for (const x of notes) if (sameDays(x.date)) { const g = Number(x.cgst) + Number(x.sgst) + Number(x.igst); if (x.kind === 'credit') prevToDate.outputGst -= g; else prevToDate.inputGst -= g; }
    for (const x of pays) if (x.kind === 'receipt' && sameDays(x.date)) prevToDate.received += Number(x.amount);
    prevToDate.netGst = prevToDate.outputGst - prevToDate.inputGst;

    const row = (m) => ({ month: m, sales: R2(sales[m]), purchases: R2(purchases[m]), returns: R2(returnsM[m]), received: R2(received[m]), paidOut: R2(paidOut[m]),
      outputGst: R2(salesGst[m]), inputGst: R2(purchaseGst[m]), netGst: R2(salesGst[m] - purchaseGst[m]) });
    const trend = months.map(row);
    const cur = trend[trend.length - 1], prev = trend[trend.length - 2];   // (prev is the full previous month, used for the sparkline context)
    const kpi = (key, label) => ({ key, label, period: curM, value: cur[key], previous: R2(prevToDate[key]), previousFullMonth: prev[key], changePct: pct(cur[key], prevToDate[key]), comparedWith: `${prevM} up to day ${dom}`, spark: trend.map((t) => t[key]) });

    // Receivables and payables, as of today, aged by document date. Everything unsettled counts, not just the window.
    const ageing = async (table, deduct) => {
      const rows = (await pool.query(`SELECT date, total, paid, returned${deduct ? ', tds' : ''} FROM ${table} WHERE company_id=$1 AND date <= $2`, [cid, asOf])).rows;
      const buckets = AGE_BUCKETS.map(([label]) => ({ label, amount: 0, count: 0 }));
      let total = 0;
      for (const d of rows) {
        const due = Number(d.total) - Number(d.paid) - Number(d.returned) - (deduct ? Number(d.tds) : 0);
        if (due < 0.005) continue;
        const age = dayDiff(ymd(d.date), asOf), b = AGE_BUCKETS.findIndex(([, lo, hi]) => age >= lo && age <= hi);
        buckets[b].amount += due; buckets[b].count += 1; total += due;
      }
      return { total: R2(total), buckets: buckets.map((b) => ({ ...b, amount: R2(b.amount) })) };
    };

    const names = new Map((await pool.query('SELECT id, name FROM parties WHERE company_id=$1', [cid])).rows.map((p) => [p.id, p.name]));
    const byParty = new Map();
    for (const i of inv) { const k = i.party_id; byParty.set(k, (byParty.get(k) ?? 0) + Number(i.taxable)); }
    const topCustomers = [...byParty].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, amount]) => ({ id, name: names.get(id) ?? 'Unknown', amount: R2(amount) }));

    const invIds = inv.map((i) => i.id);
    let topItems = [];
    if (invIds.length) {
      const lines = (await pool.query(`SELECT description, taxable FROM invoice_lines WHERE invoice_id IN (${invIds.map(Number).join(',')})`)).rows;
      const m = new Map();
      for (const l of lines) m.set(l.description, (m.get(l.description) ?? 0) + Number(l.taxable));
      topItems = [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, amount]) => ({ name, amount: R2(amount) }));
    }

    const billed = inv.reduce((t, i) => t + Number(i.total) - Number(i.returned), 0);
    const collected = inv.reduce((t, i) => t + Number(i.paid), 0);
    const status = { paid: { count: 0, amount: 0 }, partial: { count: 0, amount: 0 }, unpaid: { count: 0, amount: 0 }, returned: { count: 0, amount: 0 } };
    for (const i of inv) { const s = status[i.status] ?? status.unpaid; s.count += 1; s.amount += Number(i.total); }
    for (const s of Object.values(status)) s.amount = R2(s.amount);

    // Cash and bank from the ledger, and the expense accounts' movement over the window.
    const bal = async (code) => Number((await pool.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
       WHERE e.company_id=$1 AND a.code=$2 AND e.date <= $3`, [cid, code, asOf])).rows[0].b);
    const exp = (await pool.query(
      `SELECT a.name, COALESCE(SUM(l.debit - l.credit),0) AS amount FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
       WHERE e.company_id=$1 AND a.type='expense' AND e.date >= $2 AND e.date <= $3 GROUP BY a.name`, [cid, from, asOf])).rows
      .map((x) => ({ name: x.name, amount: R2(x.amount) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
    const expenseTotal = exp.reduce((s, x) => s + x.amount, 0);

    res.json({
      asOf, months,
      kpis: [kpi('sales', 'Sales'), kpi('purchases', 'Purchases'), kpi('received', 'Collected'), kpi('netGst', 'Net GST payable')],
      trend,
      totals: { sales: R2(trend.reduce((s, t) => s + t.sales, 0)), purchases: R2(trend.reduce((s, t) => s + t.purchases, 0)), received: R2(trend.reduce((s, t) => s + t.received, 0)), paidOut: R2(trend.reduce((s, t) => s + t.paidOut, 0)), invoices: inv.length, bills: pur.length },
      collection: { billed: R2(billed), collected: R2(collected), ratePct: billed > 0 ? R2(Math.min(100, (collected / billed) * 100)) : null },
      receivables: await ageing('invoices', false),
      payables: await ageing('purchases', true),
      topCustomers, topItems, invoiceStatus: status,
      cash: { cash: R2(await bal(A.CASH)), bank: R2(await bal(A.BANK)) },
      expenses: { total: R2(expenseTotal), top: exp.slice(0, 6) },
    });
  }));

  return r;
}
