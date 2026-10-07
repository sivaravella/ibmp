import React, { useEffect, useState } from 'react';
import { api, download, inr } from '../api.js';
import TdsNs from './TdsNs.jsx';

const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
const curFy = () => { const d = new Date(); const s = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const shiftFy = (fy, n) => { const s = Number(fy.slice(0, 4)) + n; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const lastQuarter = () => { const m = new Date().getMonth() + 1; return m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : 3; };   // the most recently finished quarter

export default function Tds({ go }) {
  const [tab, setTab] = useState('q24');
  const [fy, setFy] = useState(curFy());
  return (
    <>
      <h2>TDS &amp; Form 16</h2>
      <div className="row">
        {[['q24', 'Form 24Q (salary)'], ['f16', 'Form 16'], ['ns', 'Non-salary TDS & 26Q'], ['setup', 'Setup & challans']].map(([k, l]) => <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        <button onClick={() => setFy(shiftFy(fy, -1))}>‹</button><strong>FY {fy}</strong><button onClick={() => setFy(shiftFy(fy, 1))}>›</button>
      </div>
      {tab === 'setup' && <Setup fy={fy} go={go} />}
      {tab === 'q24' && <Q24 fy={fy} />}
      {tab === 'f16' && <Form16 fy={fy} />}
      {tab === 'ns' && <TdsNs fy={fy} />}
    </>
  );
}

// ---------------- setup and challans ----------------
function Setup({ fy, go }) {
  const [s, setS] = useState(null);
  const [runs, setRuns] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => { api('GET', '/tds/settings').then(setS); api('GET', `/tds/runs?fy=${fy}`).then((d) => setRuns(d.runs)); };
  useEffect(load, [fy]);
  if (!s) return <p>Loading…</p>;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });

  async function save(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try { await api('PUT', '/tds/settings', { tan: s.tan ?? '', pan: s.pan ?? '', deductorType: s.deductorType ?? '', responsibleName: s.responsibleName ?? '', responsibleDesignation: s.responsibleDesignation ?? '' }); setMsg('Saved.'); load(); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      <form className="card" onSubmit={save}>
        <strong>Deductor details</strong>
        <p className="muted" style={{ margin: '4px 0 8px' }}>These go on every Form 24Q and Form 16.</p>
        <div className="row">
          <input placeholder="TAN, e.g. HYDR12345A" maxLength={10} value={s.tan ?? ''} onChange={set('tan')} />
          <input placeholder={`PAN${s.panFromGstin ? ` (from GSTIN: ${s.panFromGstin})` : ''}`} maxLength={10} value={s.pan ?? ''} onChange={set('pan')} />
          <select value={s.deductorType ?? ''} onChange={set('deductorType')}><option value="">Deductor type…</option>{s.deductorTypes.map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <div className="row">
          <input placeholder="Person responsible for deducting tax" value={s.responsibleName ?? ''} onChange={set('responsibleName')} style={{ minWidth: 260 }} />
          <input placeholder="Designation" value={s.responsibleDesignation ?? ''} onChange={set('responsibleDesignation')} />
        </div>
        {!s.addressOk && <p className="err">The business address is incomplete. Add it under E-invoice &amp; E-way → Setup. <button type="button" onClick={() => go('edocs')}>Open</button></p>}
        {err && <p className="err">{err}</p>}{msg && <p style={{ color: '#15803d' }}>{msg}</p>}
        <button className="primary">Save</button>
      </form>

      <h3>Challans for the TDS deposited in FY {fy}</h3>
      <p className="muted">After you pay the TDS at the bank, record the payment on the payroll run, then enter the challan's BSR code and serial number here. Both are on the challan counterfoil.</p>
      <table>
        <thead><tr><th>Month</th><th>TDS</th><th>Due</th><th>Deposited</th><th>BSR code</th><th>Challan serial</th><th>Interest</th><th>Fee</th><th /></tr></thead>
        <tbody>{runs.map((r) => <ChallanRow key={r.runId} r={r} onSaved={load} />)}</tbody>
      </table>
      {!runs.length && <p className="muted">No payroll with TDS in this year yet.</p>}
    </>
  );
}

function ChallanRow({ r, onSaved }) {
  const [f, setF] = useState({ bsr: r.bsr ?? '', serial: r.challanSerial ?? '', interest: String(r.interest || ''), fee: String(r.fee || '') });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setOk(false); };
  async function save() {
    setErr('');
    try { await api('PUT', `/tds/runs/${r.runId}/challan`, { bsr: f.bsr, serial: f.serial, interest: Number(f.interest || 0), fee: Number(f.fee || 0) }); setOk(true); onSaved(); }
    catch (e) { setErr(e.message); }
  }
  return (
    <>
      <tr>
        <td>{r.month}</td><td>{inr(r.tds)}</td><td>{fmt(r.dueDate)}</td>
        <td>{r.depositedOn ? <>{fmt(r.depositedOn)}{r.late && <span style={{ color: '#b91c1c' }}> late</span>}</> : <span style={{ color: '#92400e' }}>not recorded</span>}</td>
        <td><input value={f.bsr} onChange={set('bsr')} maxLength={7} style={{ width: 90 }} disabled={!r.depositedOn} /></td>
        <td><input value={f.serial} onChange={set('serial')} maxLength={5} style={{ width: 70 }} disabled={!r.depositedOn} /></td>
        <td><input type="number" min="0" value={f.interest} onChange={set('interest')} style={{ width: 80 }} disabled={!r.depositedOn} /></td>
        <td><input type="number" min="0" value={f.fee} onChange={set('fee')} style={{ width: 80 }} disabled={!r.depositedOn} /></td>
        <td><button disabled={!r.depositedOn || !f.bsr || !f.serial} onClick={save}>{ok ? 'Saved ✓' : 'Save'}</button></td>
      </tr>
      {err && <tr><td colSpan={9} className="err">{err}</td></tr>}
    </>
  );
}

// ---------------- Form 24Q ----------------
function Q24({ fy }) {
  const [quarter, setQuarter] = useState(lastQuarter());
  const [d, setD] = useState(null);
  const [f, setF] = useState({ tokenNo: '', filedOn: new Date().toISOString().slice(0, 10) });
  const [err, setErr] = useState('');
  const load = () => api('GET', `/tds/24q?fy=${fy}&quarter=${quarter}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); }, [fy, quarter]);

  const get = (section, name) => download(`/tds/24q/export?fy=${fy}&quarter=${quarter}&section=${section}`, name).catch((e) => setErr(e.message));
  async function record(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/tds/24q/filed', { fy, quarter, tokenNo: f.tokenNo, filedOn: f.filedOn }); load(); } catch (e2) { setErr(e2.message); }
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
        <p className="muted" style={{ marginTop: 0 }}>This prepares the <strong>data</strong> of the statement. It is not the NSDL file: key or import it into NSDL's Return Preparation Utility, validate it with the FVU, upload it with your TRACES / TIN-FC login, then record the token number below.</p>
        {d.errors.map((e) => <p key={e} className="err">✗ {e}</p>)}
        {d.warnings.length > 0 && <details style={{ margin: '8px 0' }}><summary style={{ color: '#92400e', cursor: 'pointer' }}>{d.warnings.length} warning(s)</summary><ul style={{ margin: '6px 0', paddingLeft: 18 }}>{d.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></details>}

        <div className="tiles">
          <div className="card tile"><span className="muted">Tax deducted</span><strong>{inr(st.totals.deducted)}</strong></div>
          <div className="card tile"><span className="muted">Deposited</span><strong>{inr(st.totals.deposited)}</strong></div>
          <div className="card tile"><span className="muted">Challans / deductee rows</span><strong>{st.totals.challans} / {st.totals.deducteeRows}</strong></div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => get('challans', `24Q_${fy}_Q${quarter}_challans.csv`)} disabled={!st.challans.length}>Download challans (CSV)</button>
          <button onClick={() => get('deductees', `24Q_${fy}_Q${quarter}_deductees.csv`)} disabled={!st.deductees.length}>Download deductees (CSV)</button>
          {st.annexure2 && <button onClick={() => get('annexure2', `24Q_${fy}_Q${quarter}_annexure2.csv`)}>Download Annexure II (CSV)</button>}
          <button onClick={() => get('json', `24Q_${fy}_Q${quarter}.json`)}>Download all (JSON)</button>
        </div>

        <h3>Challan details</h3>
        <table>
          <thead><tr><th>Month</th><th>BSR</th><th>Serial</th><th>Deposited</th><th>Income tax</th><th>Cess</th><th>Interest</th><th>Fee</th><th>Total</th></tr></thead>
          <tbody>{st.challans.map((c) => <tr key={c.month}><td>{c.month}</td><td>{c.bsr ?? '—'}</td><td>{c.challanSerial ?? '—'}</td><td>{fmt(c.dateDeposited)}</td><td>{inr(c.tdsIncomeTax)}</td><td>{inr(c.cess)}</td><td>{inr(c.interest)}</td><td>{inr(c.fee)}</td><td>{inr(c.totalDeposited)}</td></tr>)}</tbody>
        </table>

        <h3>Deductee details (section 192)</h3>
        <table>
          <thead><tr><th>#</th><th>Employee</th><th>PAN</th><th>Paid on</th><th>Amount paid</th><th>Tax deducted</th><th>Deposited</th></tr></thead>
          <tbody>{st.deductees.map((x) => <tr key={x.sr}><td>{x.sr}</td><td>{x.name} <span className="muted">{x.employeeCode}</span></td><td>{x.pan ?? <span className="err">missing</span>}</td><td>{fmt(x.dateOfPayment)}</td><td>{inr(x.amountPaid)}</td><td>{inr(x.tdsTotal)}</td><td>{fmt(x.dateOfDeposit)}</td></tr>)}</tbody>
        </table>

        {st.annexure2 && <>
          <h3>Annexure II: salary details for the year</h3>
          <table>
            <thead><tr><th>Employee</th><th>PAN</th><th>Gross salary</th><th>Taxable income</th><th>Tax payable</th><th>Tax deducted</th><th>Short / excess</th></tr></thead>
            <tbody>{st.annexure2.map((a) => <tr key={a.employeeCode}><td>{a.name}</td><td>{a.pan ?? '—'}</td><td>{inr(a.grossSalary)}</td><td>{inr(a.taxableIncome)}</td><td>{inr(a.netTaxPayable)}</td><td>{inr(a.tdsDeducted)}</td>
              <td style={{ color: a.shortfall ? '#b91c1c' : undefined }}>{a.shortfall ? `${a.shortfall > 0 ? 'short ' : 'excess '}${inr(Math.abs(a.shortfall))}` : '—'}</td></tr>)}</tbody>
          </table>
        </>}

        <h3>Filing record</h3>
        {d.recorded
          ? <p>Recorded as filed on <strong>{fmt(d.recorded.filedOn)}</strong>, token number <strong>{d.recorded.tokenNo}</strong>. The compliance calendar is updated.{' '}
            <button onClick={() => window.confirm('Remove this record? The calendar item is reopened.') && api('DELETE', `/tds/statements/${d.recorded.id}`).then(load)}>Remove</button></p>
          : <form className="row" onSubmit={record}>
            <input placeholder="15-digit token number" value={f.tokenNo} maxLength={15} onChange={(e) => setF({ ...f, tokenNo: e.target.value })} required style={{ width: 200 }} />
            <input type="date" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} required />
            <button className="primary">Record as filed</button>
          </form>}
      </>}
    </>
  );
}

// ---------------- Form 16 ----------------
function Form16({ fy }) {
  const [rows, setRows] = useState(null);
  const [cert, setCert] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setRows(null); setCert(null); api('GET', `/tds/form16?fy=${fy}`).then((d) => setRows(d.employees)).catch((e) => setErr(e.message)); }, [fy]);
  const open = (id) => api('GET', `/tds/form16/${id}?fy=${fy}`).then(setCert).catch((e) => setErr(e.message));
  if (!rows) return <p>{err || 'Loading…'}</p>;
  return (
    <>
      <p className="muted">Part B of Form 16, the salary and tax computation, from your finalized payroll. Part A is issued from TRACES after the quarterly statements are processed. Print or save this as PDF, attach Part A, and sign.</p>
      {err && <p className="err">{err}</p>}
      {cert && <Certificate c={cert} onClose={() => setCert(null)} />}
      <table>
        <thead><tr><th>Employee</th><th>PAN</th><th>Months</th><th>Gross salary</th><th>Taxable income</th><th>Tax payable</th><th>Tax deducted</th><th>Difference</th><th /></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.employeeId}>
            <td>{e.name} <span className="muted">{e.code}</span>{e.incomplete && <div style={{ color: '#b91c1c', fontSize: 12 }}>payroll incomplete for the year</div>}</td><td>{e.pan ?? <span className="err">missing</span>}</td><td>{e.months}</td><td>{inr(e.grossSalary)}</td><td>{inr(e.taxableIncome)}</td>
            <td>{inr(e.totalTax)}</td><td>{inr(e.tdsDeducted)}</td>
            <td style={{ color: e.shortfall ? '#b91c1c' : undefined }}>{e.shortfall ? `${e.shortfall > 0 ? 'short ' : 'excess '}${inr(Math.abs(e.shortfall))}` : '—'}</td>
            <td><button onClick={() => open(e.employeeId)}>View Part B</button></td>
          </tr>))}
        </tbody>
      </table>
      {!rows.length && <p className="muted">No finalized payroll in this year.</p>}
    </>
  );
}

/** Print only the certificate (the stylesheet hides the rest while this class is on the page). */
function printCertificate() {
  document.body.classList.add('print-form16');
  window.print();
  setTimeout(() => document.body.classList.remove('print-form16'), 500);
}

const Line = ({ n, label, v, bold }) => <tr><td style={{ width: 40 }}>{n}</td><td style={{ fontWeight: bold ? 700 : 400 }}>{label}</td><td style={{ textAlign: 'right', fontWeight: bold ? 700 : 400 }}>{inr(v)}</td></tr>;

function Certificate({ c, onClose }) {
  const b = c.partB;
  return (
    <div className="card" id="form16">
      <div className="row"><h3 style={{ margin: 0 }}>Form 16 · Part B</h3><button onClick={printCertificate}>Print</button><button onClick={onClose}>Close</button></div>
      <p className="muted" style={{ margin: '0 0 8px' }}>Annexure to Form 16: details of salary paid and tax deducted · Financial year {c.fy} · Assessment year {c.ay}</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 260 }}><strong>Employer (deductor)</strong><div>{c.deductor.name}</div><div className="muted">{c.deductor.address}</div><div className="muted">TAN {c.deductor.tan ?? '—'} · PAN {c.deductor.pan ?? '—'}</div></div>
        <div style={{ flex: 1, minWidth: 260 }}><strong>Employee</strong><div>{c.employee.name} ({c.employee.code})</div><div className="muted">PAN {c.employee.pan ?? <span className="err">missing</span>} · Period {b.periodFrom} to {b.periodTo} · {b.regime === 'new' ? 'New' : 'Old'} tax regime</div></div>
      </div>
      <table><tbody>
        <Line n="1" label="Gross salary: (a) salary as per section 17(1)" v={b.grossSalary} />
        <Line n="" label="(b) perquisites u/s 17(2) · (c) profits in lieu of salary u/s 17(3) (not tracked)" v={b.perquisites + b.profitsInLieu} />
        <Line n="2" label="Less: allowances exempt under section 10 (not tracked)" v={b.exemptAllowances} />
        <Line n="3" label="Balance (1 − 2)" v={b.grossSalary - b.exemptAllowances} />
        <Line n="4" label="Deductions under section 16: (a) standard deduction" v={b.standardDeduction} />
        <Line n="" label="(c) tax on employment (professional tax)" v={b.taxOnEmployment} />
        <Line n="5" label="Aggregate of deductions under section 16" v={b.deductions16} />
        <Line n="6" label="Income chargeable under the head 'Salaries' (3 − 5)" v={b.incomeFromSalary} bold />
        <Line n="7" label="Add: any other income reported by the employee" v={b.otherIncome} />
        <Line n="8" label="Gross total income" v={b.grossTotalIncome} />
        <Line n="9" label="Deductions under Chapter VI-A (declared total)" v={b.chapterViA} />
        <Line n="10" label="Total taxable income (8 − 9)" v={b.taxableIncome} bold />
        <Line n="11" label="Tax on total income" v={b.taxOnIncome} />
        <Line n="12" label="Rebate under section 87A" v={b.rebate87a} />
        <Line n="13" label="Surcharge" v={b.surcharge} />
        <Line n="14" label="Health and education cess @ 4%" v={b.cess} />
        <Line n="15" label="Tax payable (11 − 12 + 13 + 14)" v={b.totalTax} />
        <Line n="16" label="Less: relief under section 89" v={b.relief89} />
        <Line n="17" label="Net tax payable (15 − 16)" v={b.netTaxPayable} bold />
        <Line n="" label="Tax deducted at source" v={b.tdsDeducted} bold />
      </tbody></table>
      {b.shortfall !== 0 && <p className="err">{b.shortfall > 0 ? `Tax deducted is ${inr(b.shortfall)} less than the tax payable.` : `Tax deducted is ${inr(-b.shortfall)} more than the tax payable: the employee can claim it as a refund.`}</p>}

      <h4>Tax deducted and deposited, by month</h4>
      <table>
        <thead><tr><th>Month</th><th>Salary</th><th>Tax deducted</th><th>Deposited on</th><th>BSR code</th><th>Challan serial</th></tr></thead>
        <tbody>{c.monthly.map((m) => <tr key={m.month}><td>{m.month}</td><td>{inr(m.gross)}</td><td>{inr(m.tds)}</td><td>{fmt(m.depositedOn)}</td><td>{m.bsr ?? '—'}</td><td>{m.challanSerial ?? '—'}</td></tr>)}</tbody>
      </table>
      <h4>Summary of tax deducted and deposited, by quarter (for Part A)</h4>
      <table>
        <thead><tr><th>Quarter</th><th>Deducted</th><th>Deposited</th><th>24Q token number</th></tr></thead>
        <tbody>{c.partASummary.map((q) => <tr key={q.quarter}><td>Q{q.quarter}</td><td>{inr(q.tdsDeducted)}</td><td>{inr(q.tdsDeposited)}</td><td>{q.tokenNo ?? '—'}</td></tr>)}</tbody>
      </table>

      <p style={{ marginTop: 14 }}>I, {c.deductor.responsiblePerson ?? '____________'}{c.deductor.responsibleDesignation ? `, ${c.deductor.responsibleDesignation}` : ''}, certify that the information given above is true and correct based on the books of account and other records.</p>
      <p className="muted">Signature: ____________________ &nbsp; Place: ____________ &nbsp; Date: ____________</p>
      {c.warnings.length > 0 && <details className="no-print"><summary style={{ color: '#92400e', cursor: 'pointer' }}>{c.warnings.length} note(s) on this certificate</summary><ul style={{ paddingLeft: 18 }}>{c.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></details>}
    </div>
  );
}
