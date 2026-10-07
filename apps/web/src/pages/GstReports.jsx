import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

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
      <h2>GST Reports</h2>
      <div className="row">
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        <button className={tab === 'gstr1' ? 'primary' : ''} onClick={() => setTab('gstr1')}>GSTR-1 (outward)</button>
        <button className={tab === 'gstr3b' ? 'primary' : ''} onClick={() => setTab('gstr3b')}>GSTR-3B (summary)</button>
        <button onClick={() => window.print()}>Print</button>
        <button onClick={() => go('filing', { period })}>Prepare filing</button>
      </div>
      {err && <p className="err">{err}</p>}
      {!data && !err && <p>Loading…</p>}
      {data && <>
        <p className="muted">{data.company.name} · GSTIN {data.company.gstin || 'not set'} · State {data.company.stateCode}</p>
        {data.warnings.map((w) => <p key={w} className="err">⚠ {w}</p>)}
        {tab === 'gstr1' ? <Gstr1 d={data} /> : <Gstr3b d={data} />}
      </>}
    </>
  );
}

function Gstr1({ d }) {
  return (
    <>
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
  return (
    <>
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
