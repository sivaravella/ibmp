import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

const monthNow = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => (d ? d.split('-').reverse().join('-') : '—');
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const STATUS = { draft: ['Draft', '#475569', '#f1f5f9'], finalized: ['Finalized', '#92400e', '#fef3c7'], paid: ['Paid', '#15803d', '#dcfce7'] };
const Badge = ({ s }) => <span style={{ background: STATUS[s][2], color: STATUS[s][1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{STATUS[s][0]}</span>;

export default function Payroll() {
  const [tab, setTab] = useState('runs');
  const [openRun, setOpenRun] = useState(null);
  return (
    <>
      <h2>Payroll</h2>
      <div className="row">
        <button className={tab === 'runs' ? 'primary' : ''} onClick={() => { setTab('runs'); setOpenRun(null); }}>Payroll runs</button>
        <button className={tab === 'employees' ? 'primary' : ''} onClick={() => setTab('employees')}>Employees</button>
      </div>
      {tab === 'employees' ? <Employees /> : openRun ? <Run id={openRun} onBack={() => setOpenRun(null)} /> : <Runs onOpen={setOpenRun} />}
    </>
  );
}

// ---------- runs ----------
function Runs({ onOpen }) {
  const [rows, setRows] = useState([]);
  const [month, setMonth] = useState(monthNow());
  const [err, setErr] = useState('');
  const load = () => api('GET', '/payroll/runs').then(setRows);
  useEffect(() => { load(); }, []);

  async function start(e) {
    e.preventDefault(); setErr('');
    try { const r = await api('POST', '/payroll/runs', { month }); onOpen(r.id); } catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      <form className="card row" onSubmit={start}>
        <input type="month" value={month} max={monthNow()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <button className="primary">Start payroll for {monthName(month)}</button>
        {err && <span className="err">{err}</span>}
      </form>
      <table>
        <thead><tr><th>Month</th><th>Status</th><th>Employees</th><th>Gross</th><th>Net pay</th><th>TDS</th><th>PF + ESI</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>{monthName(r.month)}</td><td><Badge s={r.status} /></td><td>{r.employees}</td><td>{inr(r.gross)}</td><td>{inr(r.net)}</td>
            <td>{inr(r.tds)}</td><td>{inr(Number(r.pfEmployee) + Number(r.pfEmployer) + Number(r.edli) + Number(r.pfAdmin) + Number(r.esiEmployee) + Number(r.esiEmployer))}</td>
            <td><button onClick={() => onOpen(r.id)}>Open</button></td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="muted">No payroll runs yet. Add employees, then start a run.</p>}
    </>
  );
}

function Run({ id, onBack }) {
  const [run, setRun] = useState(null);
  const [slip, setSlip] = useState(null);
  const [mode, setMode] = useState('bank');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api('GET', `/payroll/runs/${id}`).then(setRun).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!run) return <p>{err || 'Loading…'}</p>;
  const draft = run.status === 'draft';

  const act = async (fn) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e.message); } };
  const post = (path, body = {}) => act(() => api('POST', `/payroll/runs/${id}/${path}`, body));
  const edit = (s, field, value) => act(() => api('PUT', `/payroll/runs/${id}/payslips/${s.id}`, { [field]: Number(value) }));
  const warnings = run.slips.flatMap((s) => s.warnings.map((w) => `${s.empName}: ${w}`));
  const pfDue = Number(run.pfEmployee) + Number(run.pfEmployer) + Number(run.edli) + Number(run.pfAdmin);
  const employerCost = Number(run.gross) + Number(run.pfEmployer) + Number(run.edli) + Number(run.pfAdmin) + Number(run.esiEmployer);
  const heads = [
    ['pf', 'PF (incl. EDLI & admin)', pfDue, run.remittedPf, run.dueDates.pf],
    ['esi', 'ESI', Number(run.esiEmployee) + Number(run.esiEmployer), run.remittedEsi, run.dueDates.esi],
    ['tds', 'TDS on salary', Number(run.tds), run.remittedTds, run.dueDates.tds],
    ['pt', 'Professional tax', Number(run.professionalTax), run.remittedPt, null],
  ];

  return (
    <>
      <div className="row">
        <button onClick={onBack}>‹ All runs</button>
        <h3 style={{ margin: 0 }}>{monthName(run.month)}</h3><Badge s={run.status} />
        {draft && <>
          <button onClick={() => post('recalculate')}>Recalculate</button>
          <button onClick={() => act(async () => { const r = await api('POST', `/payroll/runs/${id}/sync-attendance`, {}); setNotice(r.changed ? `Loss of pay updated for ${r.changed} employee(s) from the attendance register.` : 'Loss of pay already matches the attendance register.'); })}>Sync attendance</button>
          <button className="primary" onClick={() => post('finalize')}>Finalize payroll</button>
          <button onClick={() => window.confirm('Delete this draft run?') && act(async () => { await api('DELETE', `/payroll/runs/${id}`); onBack(); })}>Delete draft</button>
        </>}
        {run.status === 'finalized' && <>
          <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="bank">Bank</option><option value="cash">Cash</option></select>
          <button className="primary" onClick={() => post('pay', { mode })}>Pay salaries</button>
          {!run.remittedPf && !run.remittedEsi && !run.remittedTds && !run.remittedPt && <button onClick={() => post('reopen')}>Reopen</button>}
        </>}
        {run.status === 'paid' && <span className="muted">Paid {fmt(run.paidOn)} by {run.payMode}</span>}
      </div>
      {err && <p className="err">{err}</p>}
      {notice && <p className="muted">{notice}</p>}
      {!run.taxTable.verified && (
        <p className="err">Tax slabs for FY {run.taxTable.fy} are carried over from the previous year. Confirm them against the current Finance Act before relying on the TDS figures.</p>
      )}
      {warnings.map((w) => <p key={w} className="err">⚠ {w}</p>)}

      <table>
        <thead><tr><th>Employee</th><th>Paid days</th><th>LOP</th><th>Other earn.</th><th>Other ded.</th><th>Gross</th><th>PF</th><th>ESI</th><th>PT</th><th>TDS</th><th>Net pay</th><th /></tr></thead>
        <tbody>
          {run.slips.map((s) => (
            <tr key={s.id}>
              <td>{s.empName}<div className="muted" style={{ fontSize: 12 }}>{s.empCode}</div></td>
              <td>{Number(s.paidDays)}/{s.daysInMonth}</td>
              <td>{draft ? <Num value={s.lopDays} onSave={(v) => edit(s, 'lopDays', v)} /> : Number(s.lopDays)}
                {s.register.marked > 0 && Number(s.lopDays) !== s.register.lop && <div style={{ fontSize: 11, color: '#92400e' }}>register: {s.register.lop}</div>}</td>
              <td>{draft ? <Num value={s.otherEarnings} onSave={(v) => edit(s, 'otherEarnings', v)} /> : inr(s.otherEarnings)}</td>
              <td>{draft ? <Num value={s.otherDeductions} onSave={(v) => edit(s, 'otherDeductions', v)} /> : inr(s.otherDeductions)}</td>
              <td>{inr(s.gross)}</td><td>{inr(s.pfEmployee)}</td><td>{inr(s.esiEmployee)}</td><td>{inr(s.professionalTax)}</td>
              <td>{inr(s.tds)}</td><td><strong>{inr(s.net)}</strong></td>
              <td><button onClick={() => setSlip(s)}>Payslip</button></td>
            </tr>
          ))}
          <tr><td colSpan={5}><strong>Total</strong></td><td><strong>{inr(run.gross)}</strong></td><td>{inr(run.pfEmployee)}</td><td>{inr(run.esiEmployee)}</td>
            <td>{inr(run.professionalTax)}</td><td>{inr(run.tds)}</td><td><strong>{inr(run.net)}</strong></td><td /></tr>
        </tbody>
      </table>

      <div className="tiles" style={{ marginTop: 16 }}>
        <div className="card tile"><span className="muted">Employer contributions</span><strong>{inr(employerCost - Number(run.gross))}</strong></div>
        <div className="card tile"><span className="muted">Total cost to company</span><strong>{inr(employerCost)}</strong></div>
      </div>

      {!draft && (
        <>
          <h3>Statutory payments</h3>
          <table>
            <thead><tr><th>Head</th><th>Amount</th><th>Due by</th><th>Status</th><th /></tr></thead>
            <tbody>{heads.map(([k, label, amt, done, due]) => (
              <tr key={k}><td>{label}</td><td>{inr(amt)}</td><td>{due ? fmt(due) : 'State-specific'}</td>
                <td>{done ? `Paid ${fmt(done)}` : amt > 0 ? 'Pending' : '—'}</td>
                <td>{!done && amt > 0 && <button onClick={() => post('remit', { head: k, mode })}>Mark paid ({mode})</button>}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      {slip && <Payslip run={run} s={slip} onClose={() => setSlip(null)} />}
    </>
  );
}

// Number input that saves on blur (so typing "1" then "5" doesn't fire two requests).
function Num({ value, onSave }) {
  const [v, setV] = useState(String(Number(value)));
  useEffect(() => setV(String(Number(value))), [value]);
  return <input type="number" min="0" step="any" style={{ width: 90 }} value={v} onChange={(e) => setV(e.target.value)}
    onBlur={() => Number(v) !== Number(value) && onSave(v)} />;
}

function Payslip({ run, s, onClose }) {
  const earn = [['Basic', s.earnedBasic], ['HRA', s.earnedHra], ['Special allowance', s.earnedSpecial], ['Travel allowance', s.earnedTravel], ['Medical allowance', s.earnedMedical], ['Other earnings', s.otherEarnings]];
  const ded = [['Provident fund', s.pfEmployee], ['ESI', s.esiEmployee], ['Professional tax', s.professionalTax], ['TDS (income tax)', s.tds], ['Other deductions', s.otherDeductions]];
  return (
    <div className="card">
      <div className="row"><h3 style={{ margin: 0 }}>Payslip</h3><button onClick={() => window.print()}>Print</button><button onClick={onClose}>Close</button></div>
      <div className="row"><strong style={{ fontSize: 16 }}>{run.company.name}</strong><span className="muted">Payslip for {monthName(run.month)}</span></div>
      <p className="muted">
        {s.empName} ({s.empCode}){s.designation ? ` · ${s.designation}` : ''}{s.department ? ` · ${s.department}` : ''}<br />
        PAN {s.pan || '—'} · UAN {s.uan || '—'} · Bank a/c {s.bankAccount ? `xxxx${s.bankAccount.slice(-4)}` : '—'} · Paid days {Number(s.paidDays)} of {s.daysInMonth}
      </p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <table style={{ flex: 1, minWidth: 260 }}><thead><tr><th>Earnings</th><th>₹</th></tr></thead><tbody>
          {earn.filter(([, v]) => Number(v)).map(([k, v]) => <tr key={k}><td>{k}</td><td>{inr(v)}</td></tr>)}
          <tr><td><strong>Gross earnings</strong></td><td><strong>{inr(s.gross)}</strong></td></tr></tbody></table>
        <table style={{ flex: 1, minWidth: 260 }}><thead><tr><th>Deductions</th><th>₹</th></tr></thead><tbody>
          {ded.filter(([, v]) => Number(v)).map(([k, v]) => <tr key={k}><td>{k}</td><td>{inr(v)}</td></tr>)}
          <tr><td><strong>Total deductions</strong></td><td><strong>{inr(Number(s.gross) - Number(s.net))}</strong></td></tr></tbody></table>
      </div>
      <h3>Net pay: {inr(s.net)}</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        Employer contributions (not deducted from pay): PF {inr(Number(s.pfEps) + Number(s.pfEpf))}{Number(s.esiEmployer) ? `, ESI ${inr(s.esiEmployer)}` : ''}.
        This is a computer-generated payslip.
      </p>
    </div>
  );
}

// ---------- employees ----------
const BLANK = { name: '', code: '', designation: '', department: '', doj: today(), exitDate: '', pan: '', uan: '', esiNo: '', bankAccount: '', ifsc: '', mobile: '', email: '',
  basic: '', hra: '', special: '', travel: '', medical: '', pfApplicable: true, pfOnActual: false, esiApplicable: true, ptMonthly: '', taxRegime: 'new', declaredDeductions: '' };
const text = (v) => (v === '' ? null : v);
const num = (v) => Number(v || 0);

function toPayload(f, withCode) {
  const p = {
    name: f.name, designation: text(f.designation), department: text(f.department), doj: f.doj, exitDate: text(f.exitDate),
    pan: text(f.pan.toUpperCase()), uan: text(f.uan), esiNo: text(f.esiNo), bankAccount: text(f.bankAccount), ifsc: text(f.ifsc.toUpperCase()),
    mobile: text(f.mobile), email: text(f.email),
    basic: num(f.basic), hra: num(f.hra), special: num(f.special), travel: num(f.travel), medical: num(f.medical),
    pfApplicable: f.pfApplicable, pfOnActual: f.pfOnActual, esiApplicable: f.esiApplicable, ptMonthly: num(f.ptMonthly),
    taxRegime: f.taxRegime, declaredDeductions: num(f.declaredDeductions),
  };
  if (withCode && f.code) p.code = f.code;
  return p;
}
const fromEmployee = (e) => ({
  name: e.name, code: e.code, designation: e.designation ?? '', department: e.department ?? '', doj: e.doj, exitDate: e.exitDate ?? '', pan: e.pan ?? '', uan: e.uan ?? '',
  esiNo: e.esiNo ?? '', bankAccount: e.bankAccount ?? '', ifsc: e.ifsc ?? '', mobile: e.mobile ?? '', email: e.email ?? '',
  basic: String(Number(e.basic)), hra: String(Number(e.hra)), special: String(Number(e.special)), travel: String(Number(e.travel)), medical: String(Number(e.medical)),
  pfApplicable: e.pfApplicable, pfOnActual: e.pfOnActual, esiApplicable: e.esiApplicable, ptMonthly: String(Number(e.ptMonthly)),
  taxRegime: e.taxRegime, declaredDeductions: String(Number(e.declaredDeductions)),
});

function Employees() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);       // null = hidden
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('GET', '/payroll/employees').then(setRows);
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      if (editId) await api('PUT', `/payroll/employees/${editId}`, toPayload(form, false));
      else await api('POST', '/payroll/employees', toPayload(form, true));
      setForm(null); setEditId(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const gross = (e) => ['basic', 'hra', 'special', 'travel', 'medical'].reduce((s, k) => s + Number(e[k]), 0);

  return (
    <>
      <div className="row"><button className="primary" onClick={() => { setForm({ ...BLANK }); setEditId(null); }}>+ Add employee</button></div>
      {form && (
        <form className="card" onSubmit={save}>
          <h3 style={{ marginTop: 0 }}>{editId ? `Edit ${form.code}` : 'New employee'}</h3>
          <div className="row">
            <input placeholder="Full name *" value={form.name} onChange={set('name')} required />
            {!editId && <input placeholder="Code (auto if blank)" value={form.code} onChange={set('code')} />}
            <input placeholder="Designation" value={form.designation} onChange={set('designation')} />
            <input placeholder="Department" value={form.department} onChange={set('department')} />
            <label className="muted">Joined <input type="date" value={form.doj} onChange={set('doj')} required /></label>
            <label className="muted">Left on <input type="date" value={form.exitDate} onChange={set('exitDate')} /></label>
          </div>
          <div className="row">
            <input placeholder="PAN" maxLength={10} value={form.pan} onChange={set('pan')} />
            <input placeholder="UAN (PF)" value={form.uan} onChange={set('uan')} />
            <input placeholder="ESI no." value={form.esiNo} onChange={set('esiNo')} />
            <input placeholder="Bank account" value={form.bankAccount} onChange={set('bankAccount')} />
            <input placeholder="IFSC" maxLength={11} value={form.ifsc} onChange={set('ifsc')} />
            <input placeholder="Mobile" value={form.mobile} onChange={set('mobile')} />
            <input type="email" placeholder="Email" value={form.email} onChange={set('email')} />
          </div>
          <strong>Monthly salary structure (₹)</strong>
          <div className="row">
            {[['basic', 'Basic *'], ['hra', 'HRA'], ['special', 'Special allowance'], ['travel', 'Travel'], ['medical', 'Medical']].map(([k, l]) => (
              <input key={k} type="number" min="0" step="any" placeholder={l} value={form[k]} onChange={set(k)} required={k === 'basic'} />))}
            <span className="muted">Gross {inr(['basic', 'hra', 'special', 'travel', 'medical'].reduce((s, k) => s + num(form[k]), 0))}</span>
          </div>
          <strong>Statutory</strong>
          <div className="row">
            <label><input type="checkbox" checked={form.pfApplicable} onChange={set('pfApplicable')} /> PF</label>
            <label title="Contribute on actual basic instead of the ₹15,000 ceiling"><input type="checkbox" checked={form.pfOnActual} onChange={set('pfOnActual')} disabled={!form.pfApplicable} /> PF on actual wages</label>
            <label title="Applies only while monthly gross is ₹21,000 or less"><input type="checkbox" checked={form.esiApplicable} onChange={set('esiApplicable')} /> ESI</label>
            <input type="number" min="0" placeholder="Professional tax / month" value={form.ptMonthly} onChange={set('ptMonthly')} />
            <select value={form.taxRegime} onChange={set('taxRegime')}><option value="new">New tax regime</option><option value="old">Old tax regime</option></select>
            {form.taxRegime === 'old' && <input type="number" min="0" placeholder="Declared deductions / year (incl. PF)" value={form.declaredDeductions} onChange={set('declaredDeductions')} style={{ width: 260 }} />}
          </div>
          {err && <p className="err">{err}</p>}
          <div className="row"><button className="primary">{editId ? 'Save changes' : 'Add employee'}</button><button type="button" onClick={() => { setForm(null); setEditId(null); }}>Cancel</button></div>
        </form>
      )}
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Joined</th><th>Monthly gross</th><th>PF</th><th>ESI</th><th>Regime</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.id}><td>{e.code}</td><td>{e.name}</td><td>{e.designation || '—'}</td><td>{fmt(e.doj)}</td><td>{inr(gross(e))}</td>
            <td>{e.pfApplicable ? (e.pfOnActual ? 'Actual' : 'Capped') : '—'}</td>
            <td>{e.esiApplicable && gross(e) <= 21000 ? 'Yes' : '—'}</td><td>{e.taxRegime}</td>
            <td>{e.exitDate ? `Left ${fmt(e.exitDate)}` : 'Active'}</td>
            <td><button onClick={() => { setForm(fromEmployee(e)); setEditId(e.id); window.scrollTo(0, 0); }}>Edit</button></td></tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="muted">No employees yet.</p>}
    </>
  );
}
