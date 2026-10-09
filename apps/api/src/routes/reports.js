import { Router } from 'express';
import { h, httpError, today } from '../util.js';
import { buildWorkbook, toCsv } from '../sheets.js';
import {
  BUCKETS, buildBalanceSheet, buildProfitLoss, fyRange, isDate, loadAccounts, loadCompany, loadOutstanding, loadTotals, previousPeriod, previousYearEnd,
} from '../reports.js';

const FORMATS = ['json', 'xlsx', 'csv'];
const NUM = '#,##0.00';
const slug = (s) => String(s || 'company').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'company';
const dmy = (d) => d.split('-').reverse().join('-');
const money = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));

function dateParam(v, name, fallback) {
  if (v === undefined || v === '') return fallback;
  if (!isDate(v)) throw httpError(400, `${name} must be a real date written YYYY-MM-DD`);
  return v;
}
function formatParam(v) {
  const f = String(v ?? 'json').toLowerCase();
  if (!FORMATS.includes(f)) throw httpError(400, 'format must be json, xlsx or csv');
  return f;
}

/** Send a spreadsheet or CSV as a file download. */
async function sendFile(res, format, base, sheets, csvRows) {
  const name = `${base}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'xlsx') {
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(await buildWorkbook(sheets));
  }
  res.type('text/csv; charset=utf-8');
  return res.send(toCsv(csvRows));
}

const indent = (r) => `${'    '.repeat(r.level ?? 0)}${r.label}`;
const rowFormat = (r) => ({ __bold: r.kind !== 'line' || undefined, __fill: r.highlight ? 'FFFFF3C4' : undefined });

/** The report rows as spreadsheet rows. */
function statementRows(rows, hasPrev) {
  return rows.map((r) => ({
    label: indent(r), code: r.code ?? '',
    amount: r.kind === 'group' || r.kind === 'section' ? null : r.amount,
    previous: hasPrev && r.kind !== 'group' && r.kind !== 'section' ? r.previous : null,
    ...rowFormat(r),
  }));
}

function statementSheet({ name, title, company, subtitle, note, rows, hasPrev, curLabel, prevLabel }) {
  return {
    name, title: `${company.name} - ${title}`,
    subtitle: [company.gstin ? `GSTIN ${company.gstin}` : null, subtitle].filter(Boolean).join('  |  '),
    columns: [
      { header: 'Particulars', key: 'label', width: 52 }, { header: 'Code', key: 'code', width: 9 },
      { header: curLabel, key: 'amount', width: 20, numFmt: NUM },
      ...(hasPrev ? [{ header: prevLabel, key: 'previous', width: 20, numFmt: NUM }] : []),
    ],
    rows: statementRows(rows, hasPrev), notes: note ? [note] : [],
  };
}

function statementCsv({ company, title, subtitle, rows, hasPrev, curLabel, prevLabel, extra = [] }) {
  return [
    [company.name], [`GSTIN: ${company.gstin || 'not set'}`], [title], [subtitle], [],
    ['Particulars', 'Code', curLabel, ...(hasPrev ? [prevLabel] : [])],
    ...rows.map((r) => [indent(r), r.code ?? '',
      r.kind === 'group' || r.kind === 'section' ? '' : money(r.amount),
      ...(hasPrev ? [r.kind === 'group' || r.kind === 'section' ? '' : money(r.previous)] : [])]),
    ...extra,
  ];
}

export function reportRoutes(pool) {
  const r = Router();

  r.get('/reports/index', h(async (req, res) => {
    const t = today(), fy = fyRange(t);
    const formats = ['xlsx', 'csv'];
    res.json({
      today: t, financialYear: fy.fy, from: fy.from, to: fy.to,
      reports: [
        { id: 'profit-loss', title: 'Profit & Loss', description: 'Income, expenses and profit for a period, in Schedule III style.', path: '/reports/profit-loss', formats },
        { id: 'balance-sheet', title: 'Balance Sheet', description: 'What the business owns and owes on a date, in Schedule III style.', path: '/reports/balance-sheet', formats },
        { id: 'outstanding', title: 'Outstanding', description: 'Money customers owe you and you owe vendors, aged by days.', path: '/reports/outstanding', formats },
      ],
    });
  }));

  r.get('/reports/profit-loss', h(async (req, res) => {
    const cid = req.user.companyId, t = today(), fy = fyRange(t);
    const from = dateParam(req.query.from, 'from', fy.from), to = dateParam(req.query.to, 'to', t);
    if (from > to) throw httpError(400, 'The start date is after the end date');
    const format = formatParam(req.query.format);
    const prevRange = previousPeriod(from, to);
    const [company, accounts, cur, prev] = await Promise.all([
      loadCompany(pool, cid), loadAccounts(pool, cid), loadTotals(pool, cid, { from, to }), loadTotals(pool, cid, prevRange),
    ]);
    const pl = buildProfitLoss(accounts, cur, prev);
    const out = { company, from, to, previous: prevRange, ...pl };
    if (format === 'json') return res.json(out);

    const subtitle = `For the period ${dmy(from)} to ${dmy(to)}`;
    const curLabel = `${dmy(from)} to ${dmy(to)} (Rs)`, prevLabel = `${dmy(prevRange.from)} to ${dmy(prevRange.to)} (Rs)`;
    const note = 'Built from the entries posted in your books. Sales are net of returns; purchases are net of purchase returns.';
    return sendFile(res, format, `${slug(company.name)}-profit-and-loss-${from}-to-${to}`,
      [statementSheet({ name: 'Profit and Loss', title: 'Profit and Loss Statement', company, subtitle, note, rows: pl.rows, hasPrev: true, curLabel, prevLabel })],
      statementCsv({ company, title: 'Profit and Loss Statement', subtitle, rows: pl.rows, hasPrev: true, curLabel, prevLabel }));
  }));

  r.get('/reports/balance-sheet', h(async (req, res) => {
    const cid = req.user.companyId;
    const asOf = dateParam(req.query.asOf, 'asOf', today());
    const format = formatParam(req.query.format);
    const prevDate = previousYearEnd(asOf);
    const [company, accounts, cur, prev] = await Promise.all([
      loadCompany(pool, cid), loadAccounts(pool, cid), loadTotals(pool, cid, { to: asOf }), loadTotals(pool, cid, { to: prevDate }),
    ]);
    const bs = buildBalanceSheet(accounts, cur, prev);
    const out = { company, asOf, previousAsOf: prevDate, ...bs };
    if (format === 'json') return res.json(out);

    const subtitle = `As at ${dmy(asOf)}`;
    const curLabel = `As at ${dmy(asOf)} (Rs)`, prevLabel = `As at ${dmy(prevDate)} (Rs)`;
    const check = bs.balanced ? 'Balance sheet balances: total assets equal total equity and liabilities.'
      : `Balance sheet does not balance: difference of Rs ${bs.difference.toFixed(2)}.`;
    return sendFile(res, format, `${slug(company.name)}-balance-sheet-as-at-${asOf}`,
      [statementSheet({ name: 'Balance Sheet', title: 'Balance Sheet', company, subtitle, note: check, rows: bs.rows, hasPrev: true, curLabel, prevLabel })],
      statementCsv({ company, title: 'Balance Sheet', subtitle, rows: bs.rows, hasPrev: true, curLabel, prevLabel, extra: [[], [check]] }));
  }));

  r.get('/reports/outstanding', h(async (req, res) => {
    const cid = req.user.companyId;
    const asOf = dateParam(req.query.asOf, 'asOf', today());
    const format = formatParam(req.query.format);
    const [company, o] = await Promise.all([loadCompany(pool, cid), loadOutstanding(pool, cid, asOf)]);
    const out = { company, asOf, buckets: BUCKETS.map(([key, label]) => ({ key, label })), ...o };
    if (format === 'json') return res.json(out);

    const subtitle = `Aged from the invoice or bill date, as at ${dmy(asOf)}`;
    const columns = [
      { header: 'Party', key: 'name', width: 36 },
      ...BUCKETS.map(([key, label]) => ({ header: label, key, width: 16, numFmt: NUM })),
      { header: 'Total', key: 'total', width: 18, numFmt: NUM },
    ];
    const sheet = (name, title, side) => ({
      name, title: `${company.name} - ${title}`,
      subtitle: [company.gstin ? `GSTIN ${company.gstin}` : null, subtitle].filter(Boolean).join('  |  '),
      columns, rows: side.parties.map((p) => ({ name: p.name, b0: p.b0, b1: p.b1, b2: p.b2, b3: p.b3, total: p.total })),
      totals: { name: 'Total', ...side.totals },
    });
    const head = ['Type', 'Party', ...BUCKETS.map(([, l]) => l), 'Total'];
    const csvLine = (type, p) => [type, p.name, ...['b0', 'b1', 'b2', 'b3', 'total'].map((k) => money(p[k]))];
    return sendFile(res, format, `${slug(company.name)}-outstanding-as-at-${asOf}`,
      [sheet('Receivables', 'Outstanding Receivables', o.receivables), sheet('Payables', 'Outstanding Payables', o.payables)],
      [[company.name], [`GSTIN: ${company.gstin || 'not set'}`], ['Outstanding receivables and payables'], [subtitle], [], head,
        ...o.receivables.parties.map((p) => csvLine('Receivable', p)), csvLine('Receivable total', { name: '', ...o.receivables.totals }),
        ...o.payables.parties.map((p) => csvLine('Payable', p)), csvLine('Payable total', { name: '', ...o.payables.totals })]);
  }));

  return r;
}
