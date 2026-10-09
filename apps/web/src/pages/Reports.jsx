import React, { useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { EmptyState, PageHeader, Segmented, Skeleton } from '../ui/kit.jsx';
import { Field, Notice } from '../ui/forms.jsx';
import { fmtDate } from '../ui/format.js';
import { BalanceCheck, Outstanding, ReportHead, Statement } from './reports-views.jsx';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Start of the Indian financial year (1 April) containing the date. */
const fyStart = (d) => new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);

function rangePresets(now = new Date()) {
  const fy = fyStart(now), y = fy.getFullYear();
  const qStart = new Date(now.getFullYear(), now.getMonth() - ((now.getMonth() + 9) % 3), 1);   // quarters start Apr, Jul, Oct, Jan
  return {
    fy: { label: 'This financial year', from: ymd(fy), to: ymd(now) },
    lastFy: { label: 'Last financial year', from: `${y - 1}-04-01`, to: `${y}-03-31` },
    quarter: { label: 'This quarter', from: ymd(qStart), to: ymd(now) },
    month: { label: 'This month', from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) },
  };
}
function asAtPresets(now = new Date()) {
  const y = fyStart(now).getFullYear();
  return {
    today: { label: 'Today', to: ymd(now) },
    lastMonth: { label: 'End of last month', to: ymd(addDays(new Date(now.getFullYear(), now.getMonth(), 1), -1)) },
    lastFy: { label: 'End of last financial year', to: `${y}-03-31` },
  };
}

const REPORTS = [
  { id: 'profit-loss', title: 'Profit & Loss', icon: 'trend', blurb: 'Income, expenses and profit for a period, laid out in Schedule III style, with the previous period beside it.', kind: 'range' },
  { id: 'balance-sheet', title: 'Balance Sheet', icon: 'layers', blurb: 'What the business owns and owes on a date. It always shows whether the two sides balance.', kind: 'asat' },
  { id: 'outstanding', title: 'Outstanding (aged)', icon: 'clock', blurb: 'Who owes you and whom you owe, aged 0-30, 31-60, 61-90 and over 90 days from the invoice or bill date.', kind: 'asat' },
];

export default function Reports({ params, go }) {
  const [id, setId] = useState(params?.report ?? null);
  const report = REPORTS.find((r) => r.id === id);
  if (!report) return <Home open={setId} go={go} />;
  return <ReportView key={report.id} report={report} back={() => setId(null)} />;
}

function Home({ open, go }) {
  return (
    <>
      <PageHeader title="Reports" subtitle="Financial statements built from the entries posted in your books" />
      <div className="rp-cards">
        {REPORTS.map((r) => (
          <button key={r.id} type="button" className="rp-card" onClick={() => open(r.id)}>
            <span className="rp-card-icon"><Icon name={r.icon} size={20} /></span>
            <strong>{r.title}</strong>
            <span>{r.blurb}</span>
            <em>Open report <Icon name="arrow" size={14} /></em>
          </button>
        ))}
        <button type="button" className="rp-card rp-card-link" onClick={() => go('ledger')}>
          <span className="rp-card-icon"><Icon name="book" size={20} /></span>
          <strong>Trial balance</strong>
          <span>Every account with its debit and credit balance, on the Ledger screen.</span>
          <em>Go to Ledger <Icon name="arrow" size={14} /></em>
        </button>
        <button type="button" className="rp-card rp-card-link" onClick={() => go('gst')}>
          <span className="rp-card-icon"><Icon name="chart" size={20} /></span>
          <strong>GST reports</strong>
          <span>GSTR-1 outward supplies and the GSTR-3B summary for a month.</span>
          <em>Go to GST reports <Icon name="arrow" size={14} /></em>
        </button>
      </div>
    </>
  );
}

function ReportView({ report, back }) {
  const isRange = report.kind === 'range';
  const presets = isRange ? rangePresets() : asAtPresets();
  const firstKey = Object.keys(presets)[0];
  const [preset, setPreset] = useState(firstKey);
  const [from, setFrom] = useState(presets[firstKey].from);
  const [to, setTo] = useState(presets[firstKey].to);
  const [loaded, setLoaded] = useState(null);       // { key, data }: only valid for the dates it was fetched for
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const query = isRange ? `from=${from}&to=${to}` : `asOf=${to}`;
  const valid = to && (!isRange || (from && from <= to));
  const key = `${report.id}|${query}`;
  const data = loaded?.key === key ? loaded.data : null;

  useEffect(() => {
    if (!valid) return undefined;
    setErr('');
    let stale = false;
    api('GET', `/reports/${report.id}?${query}`)
      .then((d) => !stale && setLoaded({ key, data: d }))
      .catch((e) => !stale && setErr(e.message));
    return () => { stale = true; };
  }, [key, valid]);

  const choose = (k) => {
    setPreset(k);
    if (k === 'custom') return;
    if (isRange) setFrom(presets[k].from);
    setTo(presets[k].to);
  };
  const options = [...Object.entries(presets).map(([k, p]) => [k, p.label]), ['custom', 'Custom']];

  const save = async (format) => {
    setBusy(format); setErr('');
    try {
      await download(`/reports/${report.id}?${query}&format=${format}`, `${report.id}-${isRange ? `${from}-to-${to}` : `as-at-${to}`}.${format}`);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const period = isRange ? `For the period ${fmtDate(from)} to ${fmtDate(to)}` : `As at ${fmtDate(to)}`;
  const explainer = report.id === 'outstanding'
    ? `Built from the invoices and bills in your books up to ${fmtDate(to)}, less the payments, receipts and credit or debit notes recorded by then. Each is aged from its own date.`
    : isRange
      ? `Built from the entries posted in your books between ${fmtDate(from)} and ${fmtDate(to)}. Sales are shown net of returns, and purchases net of purchase returns.`
      : `Built from every entry posted in your books up to ${fmtDate(to)}. Retained profit is all income less all expenses to that date.`;

  return (
    <div className="rp-page">
      <PageHeader title={report.title} subtitle={explainer}>
        <button type="button" onClick={back}><Icon name="arrow" size={14} /> All reports</button>
      </PageHeader>

      <div className="rp-controls no-print">
        <Segmented label="Period" value={preset} onChange={choose} options={options} />
        <div className="rp-dates">
          {isRange && <Field label="From"><input type="date" value={from} max={to || undefined} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} /></Field>}
          <Field label={isRange ? 'To' : 'As at'}><input type="date" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} /></Field>
        </div>
        <div className="rp-actions">
          <button type="button" disabled={!data || !!busy} onClick={() => save('xlsx')}><Icon name="download" size={14} /> {busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}</button>
          <button type="button" disabled={!data || !!busy} onClick={() => save('csv')}><Icon name="download" size={14} /> {busy === 'csv' ? 'Preparing…' : 'Download CSV'}</button>
          <button type="button" className="primary" disabled={!data} onClick={() => window.print()}><Icon name="file" size={14} /> Print / Save as PDF</button>
        </div>
      </div>

      {isRange && from && to && from > to && <Notice tone="warn">The start date is after the end date.</Notice>}
      {err && <Notice>{err}</Notice>}
      {!data && !err && valid && <Skeleton rows={8} height={34} />}
      {data && (
        <article className="rp-sheet" aria-live="polite">
          <ReportHead company={data.company} title={report.id === 'profit-loss' ? 'Profit and Loss Statement' : report.title.replace(' (aged)', ' receivables and payables')} period={period} />
          {report.id === 'outstanding' && <Outstanding data={data} />}
          {report.id === 'profit-loss' && (data.empty
            ? <EmptyState icon="file" title="No entries in this period" text="Post an invoice, bill or journal dated within these dates and it will appear here." />
            : <Statement label="Profit and loss" rows={data.rows} hasPrev curLabel={`${fmtDate(data.from)} to ${fmtDate(data.to)}`} prevLabel={`${fmtDate(data.previous.from)} to ${fmtDate(data.previous.to)}`} />)}
          {report.id === 'balance-sheet' && (
            <>
              <BalanceCheck data={data} />
              {data.empty
                ? <EmptyState icon="file" title="No entries yet" text="The balance sheet fills in as invoices, bills, payments and journals are posted." />
                : <Statement label="Balance sheet" rows={data.rows} hasPrev curLabel={`As at ${fmtDate(data.asOf)}`} prevLabel={`As at ${fmtDate(data.previousAsOf)}`} />}
            </>
          )}
          <p className="rp-foot">Amounts in rupees. Generated from the IBMP ledger.</p>
        </article>
      )}
    </div>
  );
}
