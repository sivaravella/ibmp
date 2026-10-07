import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { COLORS, HBars, Legend, StackBar } from '../ui/charts.jsx';
import { KpiCard, PageHeader, Panel, Segmented, Skeleton } from '../ui/kit.jsx';
import { Notice } from '../ui/forms.jsx';
import { inrCompact } from '../ui/format.js';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const fmtDate = (d) => String(d).slice(0, 10).split('-').reverse().join('-');

function Section({ title, hint, children }) {
  return <><h3 style={{ margin: '20px 0 6px' }}>{title}</h3>{hint && <p className="muted" style={{ marginBottom: 6 }}>{hint}</p>}{children}</>;
}

function Empty({ rows, children }) {
  return rows.length ? children : <p className="muted">Nothing to report.</p>;
}

const Tax = ({ r }) => <><td>{inr(r.taxable)}</td><td>{inr(r.igst)}</td><td>{inr(r.cgst)}</td><td>{inr(r.sgst)}</td></>;
const TaxHead = () => <><th>Taxable</th><th>IGST</th><th>CGST</th><th>SGST</th></>;

export default function GstReports({ params, go }) {
  const [period, setPeriod] = useState(params?.period || thisMonth());
  const [tab, setTab] = useState('gstr1');
  const [loaded, setLoaded] = useState(null); // { key, data }: data is only valid for the tab+period it was fetched for
  const [err, setErr] = useState('');
  const key = `${tab}|${period}`;
  const data = loaded?.key === key ? loaded.data : null;

  useEffect(() => {
    setErr('');
    let stale = false;
    api('GET', `/gst/${tab}?period=${period}`)
      .then((d) => !stale && setLoaded({ key, data: d }))
      .catch((e) => !stale && setErr(e.message));
    return () => { stale = true; };
  }, [key]);

  return (
    <>
      <PageHeader title="GST reports" subtitle="What goes into GSTR-1 and GSTR-3B for the month, checked against your ledger">
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Month" />
        <Segmented label="Return" value={tab} onChange={setTab} options={[['gstr1', 'GSTR-1 outward'], ['gstr3b', 'GSTR-3B summary']]} />
        <button onClick={() => window.print()}><Icon name="file" size={14} /> Print</button>
        <button className="primary" onClick={() => go('filing', { period })}><Icon name="send" size={14} /> Prepare filing</button>
      </PageHeader>
      {err && <Notice>{err}</Notice>}
      {!data && !err && <Skeleton rows={6} height={40} />}
      {data && <>
        <p className="muted" style={{ marginBottom: 12 }}>{data.company.name} · GSTIN {data.company.gstin || 'not set'} · State {data.company.stateCode}</p>
        {data.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
        {tab === 'gstr1' ? <Gstr1 d={data} /> : <Gstr3b d={data} />}
      </>}
    </>
  );
}

function Gstr1({ d }) {
  const sum = (rows) => rows.reduce((t, r) => t + Number(r.taxable), 0);
  const gstTotal = Number(d.totals.igst) + Number(d.totals.cgst) + Number(d.totals.sgst);
  const split = [{ label: 'B2B (registered buyers)', value: sum(d.b2b), color: COLORS.brand }, { label: 'B2C large', value: sum(d.b2cl), color: COLORS.teal }, { label: 'B2C small', value: sum(d.b2cs), color: COLORS.amber }];
  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Net taxable value" value={inrCompact(d.totals.taxable)} icon="file" tone="brand" hint="Invoices less credit notes" />
        <KpiCard label="Output GST" value={inrCompact(gstTotal)} icon="percent" tone="amber" hint={`IGST ${inrCompact(d.totals.igst)} · CGST ${inrCompact(d.totals.cgst)} · SGST ${inrCompact(d.totals.sgst)}`} />
        <KpiCard label="B2B invoices" value={d.b2b.length} icon="users" tone="teal" hint={`${d.b2cl.length} B2C large · ${d.b2cs.length} B2C small lines`} />
        <KpiCard label="Credit notes" value={d.cdnr.length + d.cdnur.length} icon="undo" tone="rose" hint={`${d.docs.invoices.count} invoices issued in the month`} />
      </div>
      <div className="g12">
        <Panel className="s6" title="Where the sales came from" hint="Taxable value by return table"><StackBar segments={split} /><Legend items={split.map((x) => ({ ...x, value: x.value }))} format={inrCompact} /></Panel>
        <Panel className="s6" title="Top HSN codes" hint="By taxable value"><HBars rows={[...d.hsn].sort((a, b) => Number(b.taxable) - Number(a.taxable)).slice(0, 5).map((r) => ({ label: `${r.hsn} (${r.qty} ${r.unit})`, value: Number(r.taxable) }))} color={COLORS.brand} empty="No supplies in this month" /></Panel>
      </div>
      <Section title="Net outward supplies" hint="Invoices less credit notes issued in the period.">
        <table><thead><tr><th /><TaxHead /></tr></thead><tbody><tr><td><strong>Total</strong></td><Tax r={d.totals} /></tr></tbody></table>
      </Section>

      <Section title="4A/4B — B2B invoices (registered buyers)">
        <Empty rows={d.b2b}><table>
          <thead><tr><th>GSTIN</th><th>Party</th><th>Invoice</th><th>Date</th><th>POS</th><th>Value</th><TaxHead /></tr></thead>
          <tbody>{d.b2b.map((i) => <tr key={i.number}><td>{i.ctin}</td><td>{i.party}</td><td>{i.number}</td><td>{fmtDate(i.date)}</td><td>{i.pos}</td><td>{inr(i.value)}</td><Tax r={i} /></tr>)}</tbody>
        </table></Empty>
      </Section>

      <Section title="5 — B2C large" hint="Inter-state invoices above ₹2,50,000 to unregistered buyers.">
        <Empty rows={d.b2cl}><table>
          <thead><tr><th>Invoice</th><th>Date</th><th>POS</th><th>Value</th><TaxHead /></tr></thead>
          <tbody>{d.b2cl.map((i) => <tr key={i.number}><td>{i.number}</td><td>{fmtDate(i.date)}</td><td>{i.pos}</td><td>{inr(i.value)}</td><Tax r={i} /></tr>)}</tbody>
        </table></Empty>
      </Section>

      <Section title="7 — B2C small" hint="Consolidated by place of supply and rate, net of credit notes.">
        <Empty rows={d.b2cs}><table>
          <thead><tr><th>Type</th><th>POS</th><th>Rate</th><TaxHead /></tr></thead>
          <tbody>{d.b2cs.map((r) => <tr key={`${r.type}${r.pos}${r.rate}`}><td>{r.type}</td><td>{r.pos}</td><td>{r.rate}%</td><Tax r={r} /></tr>)}</tbody>
        </table></Empty>
      </Section>

      <Section title="9B — Credit notes">
        <Empty rows={[...d.cdnr, ...d.cdnur]}><table>
          <thead><tr><th>Table</th><th>GSTIN</th><th>Note</th><th>Date</th><th>Against</th><th>Value</th><TaxHead /></tr></thead>
          <tbody>
            {d.cdnr.map((n) => <tr key={n.number}><td>CDNR</td><td>{n.ctin}</td><td>{n.number}</td><td>{fmtDate(n.date)}</td><td>{n.against}</td><td>{inr(n.value)}</td><Tax r={n} /></tr>)}
            {d.cdnur.map((n) => <tr key={n.number}><td>CDNUR</td><td>—</td><td>{n.number}</td><td>{fmtDate(n.date)}</td><td>{n.against}</td><td>{inr(n.value)}</td><Tax r={n} /></tr>)}
          </tbody>
        </table></Empty>
        <p className="muted">Credit notes against small B2C invoices are netted into table 7 above.</p>
      </Section>

      <Section title="12 — HSN summary" hint="Net of credit notes.">
        <Empty rows={d.hsn}><table>
          <thead><tr><th>HSN</th><th>Unit</th><th>Qty</th><TaxHead /></tr></thead>
          <tbody>{d.hsn.map((r) => <tr key={r.hsn}><td>{r.hsn}</td><td>{r.unit}</td><td>{r.qty}</td><Tax r={r} /></tr>)}</tbody>
        </table></Empty>
      </Section>

      <Section title="13 — Documents issued">
        <table><thead><tr><th>Document</th><th>From</th><th>To</th><th>Count</th></tr></thead><tbody>
          <tr><td>Invoices</td><td>{d.docs.invoices.from || '—'}</td><td>{d.docs.invoices.to || '—'}</td><td>{d.docs.invoices.count}</td></tr>
          <tr><td>Credit notes</td><td>{d.docs.creditNotes.from || '—'}</td><td>{d.docs.creditNotes.to || '—'}</td><td>{d.docs.creditNotes.count}</td></tr>
        </tbody></table>
      </Section>
    </>
  );
}

const Heads = ({ r, label }) => <tr><td>{label}</td><td>{inr(r.igst)}</td><td>{inr(r.cgst)}</td><td>{inr(r.sgst)}</td></tr>;

function Gstr3b({ d }) {
  const { outward: o, itc, liability: l, reconciliation: rc } = d;
  const heads = (r) => Number(r.igst) + Number(r.cgst) + Number(r.sgst);
  const outTotal = heads(l.output), cash = Number(l.cashTotal), byItc = Math.max(0, outTotal - cash);
  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Output tax" value={inrCompact(outTotal)} icon="percent" tone="brand" hint="Net of credit notes" />
        <KpiCard label="Input tax credit (net)" value={inrCompact(heads(itc.net))} icon="wallet" tone="teal" hint={`${inrCompact(heads(itc.ineligible))} ineligible (unregistered vendors)`} />
        <KpiCard label="Payable in cash" value={inrCompact(cash)} icon="landmark" tone={cash ? 'rose' : 'green'} hint="After using the credit available" />
        <KpiCard label="Credit carried forward" value={inrCompact(heads(l.itcCarryForward))} icon="layers" tone="green" hint="Unused ITC for next month" />
      </div>
      <div className="g12">
        <Panel className="s6" title="How the tax is paid" hint="Input credit first, the rest in cash"><StackBar segments={[{ label: 'Through ITC', value: byItc, color: COLORS.teal }, { label: 'In cash', value: cash, color: COLORS.rose }]} /><Legend format={inrCompact} items={[{ label: 'Through input credit', value: byItc, color: COLORS.teal }, { label: 'In cash', value: cash, color: COLORS.rose }]} /></Panel>
        <Panel className="s6" title="Ledger reconciliation" hint="GST accounts against the documents">{rc.ok ? <Notice tone="ok">Ledger agrees with the documents.</Notice> : <Notice>Differences found: see the table below.</Notice>}</Panel>
      </div>
      <Section title="3.1 — Outward supplies" hint="Net of credit notes issued in the period.">
        <table><thead><tr><th>Nature of supply</th><TaxHead /></tr></thead><tbody>
          <tr><td>(a) Taxable (other than zero/nil rated)</td><Tax r={o.taxable} /></tr>
          <tr><td>(c) Nil-rated / exempt</td><td>{inr(o.nilRated.taxable)}</td><td /><td /><td /></tr>
        </tbody></table>
      </Section>

      <Section title="3.2 — Inter-state supplies to unregistered persons">
        <Empty rows={o.unregisteredInterstate}><table>
          <thead><tr><th>Place of supply</th><th>Taxable</th><th>IGST</th></tr></thead>
          <tbody>{o.unregisteredInterstate.map((r) => <tr key={r.pos}><td>{r.pos}</td><td>{inr(r.taxable)}</td><td>{inr(r.igst)}</td></tr>)}</tbody>
        </table></Empty>
      </Section>

      <Section title="4 — Input tax credit" hint="Only bills from GST-registered vendors qualify.">
        <table><thead><tr><th /><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
          <Heads r={itc.available} label="(A) ITC available" />
          <Heads r={itc.reversed} label="(B) ITC reversed (debit notes)" />
          <Heads r={itc.net} label="(C) Net ITC (A − B)" />
          <Heads r={itc.ineligible} label="(D) Ineligible (unregistered vendors)" />
        </tbody></table>
      </Section>

      <Section title="6 — Tax payable" hint="ITC set off in the order set by section 49: IGST credit first, CGST and SGST credits never against each other's head.">
        <table><thead><tr><th /><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
          <Heads r={l.output} label="Output tax" />
          <Heads r={{ igst: l.itcUsed.igst.igst + l.itcUsed.cgst.igst + l.itcUsed.sgst.igst, cgst: l.itcUsed.igst.cgst + l.itcUsed.cgst.cgst, sgst: l.itcUsed.igst.sgst + l.itcUsed.sgst.sgst }} label="Paid through ITC" />
          <tr><td><strong>Payable in cash</strong></td><td><strong>{inr(l.cashPayable.igst)}</strong></td><td><strong>{inr(l.cashPayable.cgst)}</strong></td><td><strong>{inr(l.cashPayable.sgst)}</strong></td></tr>
          <Heads r={l.itcCarryForward} label="ITC carried forward" />
        </tbody></table>
        <p><strong>Total cash payable: {inr(l.cashTotal)}</strong></p>
      </Section>

      <Section title="Ledger reconciliation" hint="GST accounts in the ledger for this period against the figures above.">
        <p className={rc.ok ? 'muted' : 'err'}>{rc.ok ? '✓ Ledger agrees with the documents.' : '✗ Differences found.'}</p>
        <table><thead><tr><th /><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
          <Heads r={rc.output.ledger} label="Output tax — ledger" />
          <Heads r={rc.output.report} label="Output tax — report" />
          <Heads r={rc.input.ledger} label="Input tax — ledger" />
          <Heads r={rc.input.report} label="Input tax — report (incl. ineligible)" />
        </tbody></table>
      </Section>
    </>
  );
}
