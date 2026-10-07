import React, { useEffect, useState } from 'react';
import { api, download, inr } from '../api.js';

const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
const todayIso = () => new Date().toISOString().slice(0, 10);
const lastQuarter = () => { const m = new Date().getMonth() + 1; return m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : 3; };
const TYPE = { company: 'Company', non_company: 'Non-company' };

/** TDS on payments other than salary: deductions, the monthly challans, and Form 26Q. */
export default function TdsNs({ fy }) {
  const [view, setView] = useState('deduct');
  const [sections, setSections] = useState(null);
  useEffect(() => { api('GET', '/tds/ns/sections').then(setSections); }, []);
  return (
    <>
      <div className="row">
        {[['deduct', 'Deductions'], ['challans', 'Challans'], ['q26', 'Form 26Q']].map(([k, l]) => <button key={k} className={view === k ? 'primary' : ''} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {sections && !sections.ratesVerified && <p className="muted" style={{ color: '#92400e' }}>⚠ {sections.warning} Each deduction can use a different rate (for example from a lower-deduction certificate).</p>}
      {view === 'deduct' && sections && <Deductions fy={fy} sections={sections.sections} />}
      {view === 'challans' && <Challans fy={fy} />}
      {view === 'q26' && <Q26 fy={fy} />}
    </>
  );
}

function Deductions({ fy, sections }) {
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [bills, setBills] = useState([]);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('expense');
  const [f, setF] = useState({ partyId: '', section: '94JB', date: todayIso(), amount: '', payMode: 'bank', rate: '', certRef: '', purchaseId: '' });
  const [quote, setQuote] = useState(null);
  const load = () => {
    api('GET', `/tds/ns/deductions?fy=${fy}`).then((d) => setRows(d.deductions));
    api('GET', '/parties?type=vendor').then(setVendors);
    api('GET', '/purchases').then(setBills);
  };
  useEffect(load, [fy]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const bill = bills.find((b) => String(b.id) === String(f.purchaseId));
  const rateOverride = f.rate === '' ? {} : { rateOverride: Number(f.rate) };
  const certRef = f.certRef ? { certRef: f.certRef } : {};

  // Show what would be deducted before anything is posted.
  useEffect(() => {
    const partyId = mode === 'bill' ? bill?.partyId : Number(f.partyId);
    const amount = mode === 'bill' ? Number(bill?.taxable) : Number(f.amount);
    const date = mode === 'bill' ? String(bill?.date ?? '').slice(0, 10) : f.date;
    if (!partyId || !(amount > 0) || !date) { setQuote(null); return; }
    api('POST', '/tds/ns/quote', { partyId, section: f.section, amount, date, ...rateOverride }).then((q) => { setQuote(q); setErr(''); }).catch((e) => { setQuote(null); setErr(e.message); });
  }, [mode, f.partyId, f.section, f.date, f.amount, f.rate, f.purchaseId, bills.length]);

  async function submit(e) {
    e.preventDefault(); setErr('');
    try {
      if (mode === 'bill') await api('POST', '/tds/ns/bills', { purchaseId: Number(f.purchaseId), section: f.section, ...rateOverride, ...certRef });
      else await api('POST', '/tds/ns/expenses', { partyId: Number(f.partyId), section: f.section, date: f.date, amount: Number(f.amount), mode: f.payMode, ...rateOverride, ...certRef });
      setF({ ...f, amount: '', rate: '', certRef: '', purchaseId: '' });
      load();
    } catch (e2) { setErr(e2.message); }
  }
  async function reverse(d) {
    if (!window.confirm(`Reverse this ${d.sectionName} deduction${d.kind === 'expense' ? ' and the expense payment it recorded' : ''}?`)) return;
    try { await api('DELETE', `/tds/ns/deductions/${d.id}`); load(); } catch (e) { setErr(e.message); }
  }
  const open = bills.filter((b) => !(rows.some((d) => d.purchaseId === b.id && d.status === 'active')));
  const sec = sections.find((s) => s.code === f.section);

  return (
    <>
      <div className="card">
        <div className="row">
          <button className={mode === 'expense' ? 'primary' : ''} onClick={() => setMode('expense')}>Pay a vendor (rent, fees, commission…)</button>
          <button className={mode === 'bill' ? 'primary' : ''} onClick={() => setMode('bill')}>Deduct from a purchase bill</button>
        </div>
        <form className="row" onSubmit={submit} style={{ marginTop: 8 }}>
          {mode === 'expense' && <select value={f.partyId} onChange={set('partyId')} required><option value="">Vendor…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>}
          {mode === 'bill' && <select value={f.purchaseId} onChange={set('purchaseId')} required><option value="">Bill…</option>{open.map((b) => <option key={b.id} value={b.id}>{b.number} · {b.partyName} · {inr(b.taxable)}</option>)}</select>}
          <select value={f.section} onChange={set('section')}>{sections.filter((s) => mode === 'bill' || !s.billOnly).map((s) => <option key={s.code} value={s.code}>{s.section} {s.label}</option>)}</select>
          {mode === 'expense' && <>
            <input type="date" value={f.date} onChange={set('date')} required />
            <input type="number" min="1" step="0.01" placeholder="Amount (excl. GST)" value={f.amount} onChange={set('amount')} required style={{ width: 150 }} />
            <select value={f.payMode} onChange={set('payMode')}><option value="bank">Bank</option><option value="cash">Cash</option></select>
          </>}
          <input type="number" min="0" max="100" step="0.01" placeholder="Rate % (optional)" value={f.rate} onChange={set('rate')} style={{ width: 130 }} />
          {f.rate !== '' && <input placeholder="Certificate no." value={f.certRef} onChange={set('certRef')} style={{ width: 140 }} />}
          <button className="primary" disabled={!quote}>{mode === 'bill' ? 'Deduct TDS' : 'Record payment'}</button>
        </form>
        {sec?.note && <p className="muted" style={{ margin: '6px 0 0' }}>{sec.note}</p>}
        {quote && <p style={{ margin: '8px 0 0' }}>
          PAN <strong>{quote.pan ?? 'none'}</strong>{quote.rateReason === 'no_pan' && <span className="err"> (no PAN: higher rate)</span>} · rate <strong>{quote.rate}%</strong> ·
          paid so far this year {inr(quote.prior.base)} · <strong>TDS now {inr(quote.tds)}</strong>
          {quote.catchUp > 0 && <span className="muted"> (includes {inr(quote.catchUp)} of earlier payments: the yearly limit was crossed)</span>}
          {!quote.thresholdCrossed && <span className="muted"> (below the limit: nothing to deduct yet, but the payment is counted)</span>}
        </p>}
        {err && <p className="err">{err}</p>}
      </div>

      <h3>Deductions in FY {fy}</h3>
      <table>
        <thead><tr><th>Date</th><th>Vendor</th><th>PAN</th><th>Section</th><th>Paid</th><th>Rate</th><th>TDS</th><th>Source</th><th /></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.id} style={{ opacity: d.status === 'reversed' ? 0.45 : 1 }}>
            <td>{fmt(d.date)}</td><td>{d.partyName}</td><td>{d.pan ?? <span className="err">missing</span>}</td><td>{d.sectionName}</td><td>{inr(d.base)}</td>
            <td>{d.rate}%{d.rateReason === 'override' ? ' *' : ''}</td><td>{inr(d.tds)}</td><td>{d.kind === 'bill' ? 'Bill' : 'Payment'}{d.status === 'reversed' ? ' · reversed' : ''}</td>
            <td>{d.status === 'active' && <button onClick={() => reverse(d)}>Reverse</button>}</td>
          </tr>))}
          {!rows.length && <tr><td colSpan={9} className="muted">Nothing deducted yet this year.</td></tr>}
        </tbody>
      </table>
      <p className="muted">* a rate you entered yourself. Vendors need a PAN (set it under Parties); without one the tax is deducted at the higher rate.</p>
    </>
  );
}

function Challans({ fy }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [f, setF] = useState({ bsr: '', serial: '', depositedOn: todayIso(), interest: '0', fee: '0', mode: 'bank' });
  const load = () => api('GET', `/tds/ns/challans?fy=${fy}`).then((d) => setRows(d.challans));
  useEffect(() => { load(); }, [fy]);
  const key = (r) => `${r.month}|${r.deducteeType}`;
  async function save(e, r) {
    e.preventDefault(); setErr('');
    try {
      await api('POST', '/tds/ns/challans', { month: r.month, deducteeType: r.deducteeType, bsr: f.bsr, serial: f.serial, depositedOn: f.depositedOn, interest: Number(f.interest || 0), fee: Number(f.fee || 0), mode: f.mode });
      setOpen(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function remove(r) {
    if (!window.confirm('Remove this challan? The deposit entry in the books is reversed.')) return;
    try { await api('DELETE', `/tds/ns/challans/${r.challan.id}`); load(); } catch (e) { setErr(e.message); }
  }
  return (
    <>
      <p className="muted">One challan per month and type of deductee (ITNS 281: company deductees and non-company deductees are paid separately). Record the BSR code and serial number from the bank's receipt.</p>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>Month</th><th>Deductees</th><th>Challan</th><th>TDS</th><th>Due</th><th>Deposit</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <React.Fragment key={key(r)}>
            <tr>
              <td>{r.month} <span className="muted">Q{r.quarter}</span></td><td>{TYPE[r.deducteeType]}</td><td>{r.challanType}</td><td>{inr(r.tds)}</td><td>{fmt(r.dueDate)}</td>
              <td>{r.challan ? <>{fmt(r.challan.depositedOn)} · BSR {r.challan.bsr} · #{r.challan.serial}{r.late && <span className="err"> late</span>}{(r.challan.interest > 0 || r.challan.fee > 0) && <span className="muted"> (+{inr(r.challan.interest + r.challan.fee)} interest/fee)</span>}</>
                : <span style={{ color: r.late ? '#b91c1c' : '#92400e' }}>{r.late ? 'Overdue' : 'Not deposited'}</span>}</td>
              <td>{r.challan ? <button onClick={() => remove(r)}>Remove</button> : <button onClick={() => { setOpen(key(r)); setErr(''); }}>Record deposit</button>}</td>
            </tr>
            {open === key(r) && <tr><td colSpan={7}>
              <form className="row" onSubmit={(e) => save(e, r)}>
                <input placeholder="BSR code (7 digits)" value={f.bsr} maxLength={7} onChange={(e) => setF({ ...f, bsr: e.target.value })} required style={{ width: 150 }} />
                <input placeholder="Serial (5 digits)" value={f.serial} maxLength={5} onChange={(e) => setF({ ...f, serial: e.target.value })} required style={{ width: 130 }} />
                <input type="date" value={f.depositedOn} onChange={(e) => setF({ ...f, depositedOn: e.target.value })} required />
                <input type="number" min="0" placeholder="Interest" value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} style={{ width: 90 }} />
                <input type="number" min="0" placeholder="Fee" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} style={{ width: 90 }} />
                <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="bank">Bank</option><option value="cash">Cash</option></select>
                <button className="primary">Save</button><button type="button" onClick={() => setOpen(null)}>Cancel</button>
              </form>
            </td></tr>}
          </React.Fragment>))}
          {!rows.length && <tr><td colSpan={7} className="muted">No TDS has been deducted this year.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Q26({ fy }) {
  const [quarter, setQuarter] = useState(lastQuarter());
  const [d, setD] = useState(null);
  const [f, setF] = useState({ tokenNo: '', filedOn: todayIso() });
  const [err, setErr] = useState('');
  const load = () => api('GET', `/tds/26q?fy=${fy}&quarter=${quarter}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); }, [fy, quarter]);
  const get = (section, name) => download(`/tds/26q/export?fy=${fy}&quarter=${quarter}&section=${section}`, name).catch((e) => setErr(e.message));
  async function record(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/tds/26q/filed', { fy, quarter, tokenNo: f.tokenNo, filedOn: f.filedOn }); load(); } catch (e2) { setErr(e2.message); }
  }
  const st = d?.statement;
  return (
    <>
      <div className="row">
        {[1, 2, 3, 4].map((q) => <button key={q} className={quarter === q ? 'primary' : ''} onClick={() => setQuarter(q)}>Q{q}</button>)}
        {st && <span className="muted">{fmt(st.period.from)} to {fmt(st.period.to)} · due {fmt(st.dueDate)}</span>}
      </div>
      {err && <p className="err">{err}</p>}
      {!d ? <p>Loading…</p> : <>
        <p className="muted" style={{ marginTop: 0 }}>This prepares the <strong>data</strong> of Form 26Q. It is not the NSDL file: key or import it into NSDL's Return Preparation Utility, validate with the FVU, and upload it. Then record the token number below.</p>
        {d.errors.map((e) => <p key={e} className="err">✗ {e}</p>)}
        {d.warnings.length > 0 && <details style={{ margin: '8px 0' }}><summary style={{ color: '#92400e', cursor: 'pointer' }}>{d.warnings.length} warning(s)</summary><ul style={{ margin: '6px 0', paddingLeft: 18 }}>{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
        <div className="tiles">
          <div className="card tile"><span className="muted">Tax deducted</span><strong>{inr(st.totals.deducted)}</strong></div>
          <div className="card tile"><span className="muted">Deposited</span><strong>{inr(st.totals.deposited)}</strong></div>
          <div className="card tile"><span className="muted">Challans / deductee rows</span><strong>{st.totals.challans} / {st.totals.deducteeRows}</strong></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => get('challans', `26Q_${fy}_Q${quarter}_challans.csv`)} disabled={!st.challans.length}>Download challans (CSV)</button>
          <button onClick={() => get('deductees', `26Q_${fy}_Q${quarter}_deductees.csv`)} disabled={!st.deductees.length}>Download deductees (CSV)</button>
          <button onClick={() => get('json', `26Q_${fy}_Q${quarter}.json`)}>Download all (JSON)</button>
        </div>
        <h3>Challan details</h3>
        <table>
          <thead><tr><th>Month</th><th>Type</th><th>BSR</th><th>Serial</th><th>Deposited</th><th>TDS</th><th>Interest</th><th>Fee</th><th>Total</th></tr></thead>
          <tbody>{st.challans.map((c) => <tr key={`${c.month}${c.challanType}`}><td>{c.month}</td><td>{c.challanType}</td><td>{c.bsr ?? '—'}</td><td>{c.challanSerial ?? '—'}</td><td>{fmt(c.dateDeposited)}</td><td>{inr(c.tdsIncomeTax)}</td><td>{inr(c.interest)}</td><td>{inr(c.fee)}</td><td>{inr(c.totalDeposited)}</td></tr>)}</tbody>
        </table>
        <h3>Deductee details</h3>
        <table>
          <thead><tr><th>#</th><th>Deductee</th><th>PAN</th><th>Section</th><th>Paid on</th><th>Amount paid</th><th>Rate</th><th>Tax deducted</th><th>Deposited</th></tr></thead>
          <tbody>{st.deductees.map((x) => <tr key={x.sr}><td>{x.sr}</td><td>{x.name}</td><td>{x.pan === 'PANNOTAVBL' ? <span className="err">PANNOTAVBL</span> : x.pan}</td><td>{x.sectionName}</td><td>{fmt(x.dateOfPayment)}</td><td>{inr(x.amountPaid)}</td><td>{x.rate}%</td><td>{inr(x.tdsTotal)}</td><td>{fmt(x.dateOfDeposit)}</td></tr>)}</tbody>
        </table>
        <h3>Filing record</h3>
        {d.recorded
          ? <p>Recorded as filed on <strong>{fmt(d.recorded.filedOn)}</strong>, token number <strong>{d.recorded.tokenNo}</strong>. This quarter's deductions and challans are now locked.{' '}
            <button onClick={() => window.confirm('Remove this record? The calendar item is reopened and the quarter unlocked.') && api('DELETE', `/tds/26q/statements/${d.recorded.id}`).then(load)}>Remove</button></p>
          : <form className="row" onSubmit={record}>
            <input placeholder="15-digit token number" value={f.tokenNo} maxLength={15} onChange={(e) => setF({ ...f, tokenNo: e.target.value })} required style={{ width: 200 }} />
            <input type="date" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} required />
            <button className="primary">Record as filed</button>
          </form>}
      </>}
    </>
  );
}
