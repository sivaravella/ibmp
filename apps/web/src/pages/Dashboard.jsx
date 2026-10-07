import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { COLORS, Donut, HBars, Legend, SERIES, StackBar, TrendChart } from '../ui/charts.jsx';
import { Badge, DashboardSkeleton, EmptyState, KpiCard, PageHeader, Panel, Segmented } from '../ui/kit.jsx';
import { greeting, inr, inrCompact, monthLabel, num } from '../ui/format.js';

const AGE_COLORS = ['#10b981', '#f59e0b', '#f97316', '#f43f5e'];
const STATUS_COLORS = { paid: '#10b981', partial: '#f59e0b', unpaid: '#f43f5e', returned: '#94a3b8' };
const KPI_STYLE = { sales: ['brand', 'trend', COLORS.brand, 'up'], purchases: ['teal', 'cart', '#0d9488', 'up'], received: ['green', 'wallet', '#059669', 'up'], netGst: ['amber', 'percent', '#d97706', 'down'] };
const QUICK = [['file', 'New invoice', 'invoices'], ['cart', 'Record a bill', 'purchases'], ['users', 'Add a party', 'parties'], ['book', 'Ledger', 'ledger'], ['send', 'GST filing', 'filing'], ['receipt', 'TDS & Form 16', 'tds']];

export default function Dashboard({ go, me }) {
  const [months, setMonths] = useState(12);
  const [a, setA] = useState(null);
  const [c, setC] = useState(null);
  const [lv, setLv] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('GET', `/analytics?months=${months}`).then((x) => { setA(x); setErr(''); }).catch((e) => setErr(e.message));
  }, [months]);
  useEffect(() => {
    api('GET', '/compliance/summary').then(setC).catch(() => {});
    api('GET', '/leave/summary').then(setLv).catch(() => {});
  }, []);

  if (err) return <div className="card"><p className="err">{err}</p></div>;
  if (!a) return <DashboardSkeleton />;

  const data = a.trend.map((t) => ({ ...t, label: monthLabel(t.month), tipLabel: monthLabel(t.month, true) }));
  const first = String(me?.name ?? '').split(' ')[0];
  const net = a.receivables.total - a.payables.total;
  const cashTotal = a.cash.cash + a.cash.bank;
  const noActivity = !a.totals.invoices && !a.totals.bills;
  const statusRows = ['paid', 'partial', 'unpaid', 'returned'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: a.invoiceStatus[k].count, color: STATUS_COLORS[k] }));
  const invoiceCount = statusRows.reduce((s, x) => s + x.value, 0);
  const ageRows = (side, noun) => side.buckets.map((b, i) => ({ label: `${b.label} days · ${b.count} ${b.count === 1 ? noun : `${noun}s`}`, value: b.amount, color: AGE_COLORS[i] }));
  const salesLegend = [{ label: `Sales ${inrCompact(a.totals.sales)}`, color: COLORS.brand }, { label: `Purchases ${inrCompact(a.totals.purchases)}`, color: COLORS.teal }, { label: `Collected ${inrCompact(a.totals.received)}`, color: COLORS.amber }];
  const dom = Number(a.asOf.slice(8, 10)), prevMonth = (() => { const [y, m] = a.kpis[0].period.split('-').map(Number); return monthLabel(`${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`); })();
  const watch = c ? [...c.mostOverdue.map((i) => ({ ...i, late: true })), ...c.next].slice(0, 5) : [];

  return (
    <>
      <PageHeader title={`${greeting()}${first ? `, ${first}` : ''}`} subtitle={`${me?.company ?? ''} · figures exclude GST unless stated · as of ${a.asOf.split('-').reverse().join('-')}`}>
        <Segmented label="Period" value={months} onChange={setMonths} options={[[6, '6 months'], [12, '12 months'], [24, '24 months']]} />
        <button className="primary" onClick={() => go('invoices')}><Icon name="plus" size={15} /> New invoice</button>
      </PageHeader>

      <div className="kpi-grid">
        {a.kpis.map((k) => {
          const [tone, icon, color, good] = KPI_STYLE[k.key];
          return <KpiCard key={k.key} label={`${k.label} · ${monthLabel(k.period)} so far`} value={inrCompact(k.value)} icon={icon} tone={tone} pct={k.changePct} good={good} spark={k.spark} color={color} suffix={`vs 1–${dom} ${prevMonth}`} hint={k.changePct === null && k.previousFullMonth ? `Last month in full: ${inrCompact(k.previousFullMonth)}` : undefined} />;
        })}
      </div>

      {noActivity && (
        <Panel className="mb"><EmptyState icon="file" title="No sales or purchases yet" text="Create your first invoice or record a vendor bill and this page fills with trends, ageing and tax figures.">
          <div className="row"><button className="primary" onClick={() => go('invoices')}>Create an invoice</button><button onClick={() => go('purchases')}>Record a bill</button></div>
        </EmptyState></Panel>
      )}

      <div className="g12">
        <Panel className="s8" title="Sales, purchases and collections" hint={`Last ${months} months · ${num(a.totals.invoices)} invoices, ${num(a.totals.bills)} bills`} action={<Legend inline items={salesLegend} />}>
          <TrendChart data={data} height={300} ariaLabel="Monthly sales, purchases and collections"
            series={[{ key: 'sales', label: 'Sales', color: COLORS.brand, type: 'bar' }, { key: 'purchases', label: 'Purchases', color: COLORS.teal, type: 'bar' }, { key: 'received', label: 'Collected', color: COLORS.amber, type: 'line' }]} />
        </Panel>
        <Panel className="s4" title="Cash position" hint="Cash and bank, from the ledger">
          <div className="big-number">{inr(cashTotal)}</div>
          <div className="mini-stats" style={{ marginTop: 10 }}>
            <div><span>Bank</span><b>{inrCompact(a.cash.bank)}</b></div><div><span>Cash in hand</span><b>{inrCompact(a.cash.cash)}</b></div>
          </div>
          <div className="split" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <div><span className="muted">You are owed</span><div style={{ fontSize: 19, fontWeight: 700 }}>{inrCompact(a.receivables.total)}</div></div>
            <div style={{ textAlign: 'right' }}><span className="muted">You owe</span><div style={{ fontSize: 19, fontWeight: 700 }}>{inrCompact(a.payables.total)}</div></div>
          </div>
          <div style={{ margin: '8px 0 6px' }}><StackBar segments={[{ label: 'Receivable', value: a.receivables.total, color: COLORS.green }, { label: 'Payable', value: a.payables.total, color: COLORS.rose }]} height={9} /></div>
          <p className="muted" style={{ fontSize: 12.5 }}>Net position <b style={{ color: net >= 0 ? 'var(--green)' : 'var(--rose)' }}>{inrCompact(net)}</b> once everything is settled.</p>
          <div className="row" style={{ justifyContent: 'space-between', margin: '12px 0 5px' }}><span className="muted">Collected, of what you billed</span><b>{a.collection.ratePct === null ? '—' : `${a.collection.ratePct.toFixed(0)}%`}</b></div>
          <div className="meter"><span style={{ width: `${a.collection.ratePct ?? 0}%` }} /></div>
        </Panel>
      </div>

      <div className="g12">
        <Panel className="s8" title="GST position" hint="Output tax collected, input credit available and the net you owe" action={<><Legend inline items={[{ label: 'Output', color: COLORS.brand }, { label: 'Input credit', color: COLORS.teal }, { label: 'Net payable', color: COLORS.rose }]} /><button onClick={() => go('gst')}>GST reports</button></>}>
          <TrendChart data={data} height={278} ariaLabel="Monthly output tax, input credit and net GST"
            series={[{ key: 'outputGst', label: 'Output GST', color: COLORS.brand, type: 'bar' }, { key: 'inputGst', label: 'Input credit', color: COLORS.teal, type: 'bar' }, { key: 'netGst', label: 'Net payable', color: COLORS.rose, type: 'line' }]} />
        </Panel>
        <Panel className="s4" title="Compliance" hint="From your calendar" action={<button onClick={() => go('compliance')}>Open</button>}>
          {c ? (
            <>
              <div className="split" style={{ marginBottom: 6 }}>
                <Badge tone={c.overdue ? 'bad' : 'ok'}>{c.overdue} overdue</Badge><Badge tone={c.dueSoon ? 'warn' : 'neutral'}>{c.dueSoon} due this week</Badge>
                {lv && lv.pending > 0 && <button className="row-btn" onClick={() => go('leave')}><Icon name="sun" size={13} /> {lv.pending} leave request(s)</button>}
              </div>
              <ul className="list">
                {watch.map((i) => (
                  <li key={i.name + i.due}>
                    <span className="dot" style={{ background: i.late ? COLORS.rose : i.daysToDue <= 7 ? COLORS.amber : COLORS.green }} />
                    <div className="grow"><b title={i.name}>{i.name}</b><span>{i.late ? `${-i.daysToDue} day(s) overdue` : i.daysToDue === 0 ? 'Due today' : `Due in ${i.daysToDue} day(s)`}</span></div>
                  </li>
                ))}
                {!watch.length && <li><span className="dot" style={{ background: COLORS.green }} /><div className="grow"><b>All clear</b><span>Nothing pending</span></div></li>}
              </ul>
            </>
          ) : <HBars rows={[]} empty="Calendar not available" />}
        </Panel>
      </div>

      <div className="g12">
        <Panel className="s3" title="Receivables ageing" hint={`${inrCompact(a.receivables.total)} outstanding`} action={<button className="row-btn" onClick={() => go('invoices')}>View</button>}>
          <StackBar segments={ageRows(a.receivables, 'invoice')} />
          <Legend items={ageRows(a.receivables, 'invoice')} format={inrCompact} />
        </Panel>
        <Panel className="s3" title="Payables ageing" hint={`${inrCompact(a.payables.total)} to pay`} action={<button className="row-btn" onClick={() => go('purchases')}>View</button>}>
          <StackBar segments={ageRows(a.payables, 'bill')} />
          <Legend items={ageRows(a.payables, 'bill')} format={inrCompact} />
        </Panel>
        <Panel className="s3" title="Invoice status" hint={`${num(invoiceCount)} invoices in the period`}>
          <div className="split">
            <Donut size={118} thickness={15} centerValue={num(invoiceCount)} centerLabel="invoices" segments={statusRows} ariaLabel="Invoices by payment status" />
            <Legend items={statusRows.map((r) => ({ label: r.label, color: r.color, value: r.value }))} />
          </div>
        </Panel>
        <Panel className="s3" title="Where the money went" hint={`Expenses ${inrCompact(a.expenses.total)}`}>
          {a.expenses.top.length ? (
            <div className="split">
              <Donut size={118} thickness={15} centerValue={inrCompact(a.expenses.total)} centerLabel="expenses" ariaLabel="Expenses by account" segments={a.expenses.top.map((e, i) => ({ label: e.name, value: e.amount, color: SERIES[i % SERIES.length] }))} />
              <Legend format={inrCompact} items={a.expenses.top.map((e, i) => ({ label: e.name, value: e.amount, color: SERIES[i % SERIES.length] }))} />
            </div>
          ) : <HBars rows={[]} empty="No expenses booked yet" />}
        </Panel>
      </div>

      <div className="g12">
        <Panel className="s4" title="Top customers" hint="By sales in the period"><HBars rows={a.topCustomers.map((x) => ({ label: x.name, value: x.amount }))} color={COLORS.brand} empty="No sales in this period" /></Panel>
        <Panel className="s4" title="Top items" hint="By sales in the period"><HBars rows={a.topItems.map((x) => ({ label: x.name, value: x.amount }))} color={COLORS.teal} empty="No sales in this period" /></Panel>
        <Panel className="s4" title="Quick actions" hint="Jump straight in">
          <div className="quick">{QUICK.map(([icon, text, tab]) => <button key={tab} onClick={() => go(tab)}><Icon name={icon} size={17} />{text}</button>)}</div>
        </Panel>
      </div>
    </>
  );
}
