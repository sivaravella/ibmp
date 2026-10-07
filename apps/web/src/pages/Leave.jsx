import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => (d ? d.split('-').reverse().join('-') : '—');
const STATUS = { pending: ['Pending', '#92400e', '#fef3c7'], approved: ['Approved', '#15803d', '#dcfce7'], rejected: ['Rejected', '#b91c1c', '#fee2e2'], cancelled: ['Cancelled', '#475569', '#f1f5f9'] };
const Badge = ({ s }) => <span style={{ background: STATUS[s][2], color: STATUS[s][1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{STATUS[s][0]}</span>;
const days = (n) => (n === null ? '∞' : Number(n));

export default function Leave() {
  const [tab, setTab] = useState('applications');
  return (
    <>
      <h2>Leave management</h2>
      <div className="row">
        {[['applications', 'Applications'], ['balances', 'Balances'], ['types', 'Leave types']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'applications' && <Applications />}
      {tab === 'balances' && <Balances />}
      {tab === 'types' && <Types />}
    </>
  );
}

function Applications() {
  const [emps, setEmps] = useState([]);
  const [types, setTypes] = useState([]);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [f, setF] = useState({ employeeId: '', leaveTypeId: '', fromDate: today(), toDate: today(), half: false, halfDay: 'first', reason: '' });
  const [avail, setAvail] = useState(null);
  const [err, setErr] = useState('');
  const [rowErr, setRowErr] = useState(null);       // { id, message, convertible }

  const load = () => api('GET', '/leave/applications' + (filter ? `?status=${filter}` : '')).then(setRows);
  useEffect(() => { api('GET', '/payroll/employees').then((e) => setEmps(e.filter((x) => !x.exitDate))); api('GET', '/leave/types').then((t) => setTypes(t.filter((x) => x.active))); }, []);
  useEffect(() => { load(); }, [filter]);

  // Show what the selected employee has left of the selected type.
  useEffect(() => {
    setAvail(null);
    if (!f.employeeId || !f.leaveTypeId) return;
    api('GET', `/leave/balances?employeeId=${f.employeeId}&asOf=${f.fromDate}`).then((b) => {
      const t = types.find((x) => x.id === Number(f.leaveTypeId));
      const bal = b.employees[0]?.balances[t.code];
      setAvail(bal ? { code: t.code, ...bal } : null);
    }).catch(() => {});
  }, [f.employeeId, f.leaveTypeId, f.fromDate]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const single = f.fromDate === f.toDate;

  async function submit(e) {
    e.preventDefault(); setErr('');
    try {
      await api('POST', '/leave/applications', {
        employeeId: Number(f.employeeId), leaveTypeId: Number(f.leaveTypeId), fromDate: f.fromDate, toDate: f.toDate,
        halfDay: single && f.half ? f.halfDay : null, reason: f.reason || undefined,
      });
      setF({ ...f, reason: '', half: false }); setFilter('pending'); load();
    } catch (e2) { setErr(e2.message); }
  }

  async function decide(a, what, body = {}) {
    setRowErr(null);
    try { await api('POST', `/leave/applications/${a.id}/${what}`, body); load(); }
    catch (e) { setRowErr({ id: a.id, message: e.message, convertible: /Insufficient/.test(e.message) }); }
  }
  const unpaid = types.find((t) => !t.paid);

  return (
    <>
      <form className="card" onSubmit={submit}>
        <div className="row">
          <select value={f.employeeId} onChange={set('employeeId')} required><option value="">Employee…</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}</select>
          <select value={f.leaveTypeId} onChange={set('leaveTypeId')} required><option value="">Leave type…</option>{types.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}{t.paid ? '' : ' (unpaid)'}</option>)}</select>
          <label className="muted">From <input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: e.target.value > f.toDate ? e.target.value : f.toDate })} required /></label>
          <label className="muted">To <input type="date" value={f.toDate} min={f.fromDate} onChange={set('toDate')} required /></label>
          {single && <label><input type="checkbox" checked={f.half} onChange={set('half')} /> Half day</label>}
          {single && f.half && <select value={f.halfDay} onChange={set('halfDay')}><option value="first">First half</option><option value="second">Second half</option></select>}
        </div>
        <div className="row">
          <input placeholder="Reason" value={f.reason} onChange={set('reason')} style={{ flex: 1, minWidth: 240 }} />
          <button className="primary">Apply</button>
          {avail && <span className="muted">{avail.unlimited ? `${avail.code}: unlimited` : `${avail.code} available: ${days(avail.available)} (balance ${days(avail.balance)}${avail.pending ? `, ${avail.pending} pending` : ''})`}</span>}
        </div>
        <p className="muted" style={{ margin: 0 }}>Week offs and holidays inside the dates are not counted.</p>
        {err && <p className="err">{err}</p>}
      </form>

      <div className="row">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All applications</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((a) => (
          <React.Fragment key={a.id}>
            <tr>
              <td>{a.employeeName}<div className="muted" style={{ fontSize: 12 }}>{a.employeeCode}</div></td>
              <td>{a.typeCode}{a.paid ? '' : ' (unpaid)'}</td>
              <td>{fmt(a.fromDate)}{a.fromDate !== a.toDate && ` → ${fmt(a.toDate)}`}{a.halfDay && <span className="muted"> ({a.halfDay} half)</span>}</td>
              <td>{Number(a.days)}</td>
              <td>{a.reason || '—'}{a.decisionNote && <div className="muted" style={{ fontSize: 12 }}>Note: {a.decisionNote}</div>}</td>
              <td><Badge s={a.status} /></td>
              <td>
                {a.status === 'pending' && <><button className="primary" onClick={() => decide(a, 'approve')}>Approve</button> <button onClick={() => decide(a, 'reject')}>Reject</button> </>}
                {(a.status === 'pending' || a.status === 'approved') && <button onClick={() => decide(a, 'cancel')}>Cancel</button>}
              </td>
            </tr>
            {rowErr?.id === a.id && (
              <tr><td colSpan={7}><span className="err">{rowErr.message}</span>{' '}
                {rowErr.convertible && unpaid && <button onClick={() => decide(a, 'approve', { leaveTypeId: unpaid.id, note: 'Approved as unpaid leave' })}>Approve as {unpaid.code} (unpaid)</button>}</td></tr>
            )}
          </React.Fragment>
        ))}</tbody>
      </table>
      {!rows.length && <p className="muted">No applications{filter ? ` with status “${filter}”` : ''}.</p>}
    </>
  );
}

function Balances() {
  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState(null);
  const [adj, setAdj] = useState([]);
  const [f, setF] = useState({ employeeId: '', leaveTypeId: '', days: '', reason: '', date: today() });
  const [err, setErr] = useState('');
  const load = () => { api('GET', `/leave/balances?asOf=${asOf}`).then(setData); api('GET', '/leave/adjustments').then(setAdj); };
  useEffect(() => { load(); }, [asOf]);
  if (!data) return <p>Loading…</p>;
  const quota = data.types.filter((t) => t.quota !== null);

  async function submit(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/leave/adjustments', { employeeId: Number(f.employeeId), leaveTypeId: Number(f.leaveTypeId), days: Number(f.days), reason: f.reason, date: f.date }); setF({ ...f, days: '', reason: '' }); load(); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      <div className="row">
        <label className="muted">Balances as of <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <span className="muted">Leave year {data.year} (April–March)</span>
      </div>
      <table>
        <thead><tr><th>Employee</th>{data.types.map((t) => <th key={t.id}>{t.code}</th>)}</tr></thead>
        <tbody>{data.employees.map((e) => (
          <tr key={e.id}>
            <td>{e.name}<div className="muted" style={{ fontSize: 12 }}>{e.code}</div></td>
            {data.types.map((t) => {
              const b = e.balances[t.code];
              return (
                <td key={t.id} title={b.unlimited ? 'Unlimited' : `Carried ${b.carried} + accrued ${b.accrued} + adjustments ${b.adjustments} − taken ${b.taken}`}>
                  {b.unlimited ? <span className="muted">taken {b.taken}</span> : <><strong>{days(b.balance)}</strong>{b.pending > 0 && <span className="muted"> ({b.pending} pending)</span>}</>}
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table>
      <p className="muted">Hover a figure for its breakdown. Monthly types accrue as the year goes on; annual types are credited up front.</p>

      <h3>Adjust a balance</h3>
      <form className="card row" onSubmit={submit}>
        <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} required><option value="">Employee…</option>{data.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })} required><option value="">Leave type…</option>{quota.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</select>
        <input type="number" step="0.5" placeholder="Days (+ or −)" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} required style={{ width: 130 }} />
        <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />
        <input placeholder="Reason (required)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required style={{ flex: 1, minWidth: 200 }} />
        <button className="primary">Record</button>
        {err && <span className="err">{err}</span>}
      </form>
      {adj.length > 0 && (
        <table>
          <thead><tr><th>Date</th><th>Employee</th><th>Type</th><th>Days</th><th>Reason</th></tr></thead>
          <tbody>{adj.map((a) => <tr key={a.id}><td>{fmt(a.date)}</td><td>{a.employeeName}</td><td>{a.typeCode}</td><td>{a.days > 0 ? '+' : ''}{a.days}</td><td>{a.reason}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

const BLANK = { code: '', name: '', paid: true, quota: '12', accrual: 'monthly', carryForwardMax: '0', active: true };

function Types() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('GET', '/leave/types').then(setRows);
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault(); setErr('');
    const body = { name: form.name, paid: form.paid, quota: form.paid && form.quota !== '' ? Number(form.quota) : null, accrual: form.accrual, carryForwardMax: Number(form.carryForwardMax || 0), active: form.active };
    try {
      if (editId) await api('PUT', `/leave/types/${editId}`, body); else await api('POST', '/leave/types', { code: form.code.toUpperCase(), ...body });
      setForm(null); setEditId(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      <div className="row"><button className="primary" onClick={() => { setForm({ ...BLANK }); setEditId(null); }}>+ New leave type</button></div>
      <p className="muted">The defaults (CL, SL, EL, LWP) are starting points, not statutory entitlements. Edit them to match your policy and your state's Shops &amp; Establishments rules.</p>
      {form && (
        <form className="card row" onSubmit={save}>
          {!editId && <input placeholder="Code, e.g. PL" maxLength={8} value={form.code} onChange={set('code')} required style={{ width: 110 }} />}
          <input placeholder="Name" value={form.name} onChange={set('name')} required />
          <label><input type="checkbox" checked={form.paid} onChange={set('paid')} /> Paid</label>
          {form.paid && <input type="number" min="0" step="0.5" placeholder="Days per year (blank = unlimited)" value={form.quota} onChange={set('quota')} style={{ width: 230 }} />}
          <select value={form.accrual} onChange={set('accrual')}><option value="monthly">Accrues monthly</option><option value="annual">Credited up front</option></select>
          <input type="number" min="0" step="0.5" placeholder="Max carry forward" value={form.carryForwardMax} onChange={set('carryForwardMax')} style={{ width: 160 }} />
          {editId && <label><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</label>}
          <button className="primary">{editId ? 'Save' : 'Create'}</button><button type="button" onClick={() => { setForm(null); setEditId(null); }}>Cancel</button>
          {err && <span className="err">{err}</span>}
        </form>
      )}
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Pay</th><th>Days / year</th><th>Accrual</th><th>Carry forward</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((t) => (
          <tr key={t.id}><td>{t.code}</td><td>{t.name}</td><td>{t.paid ? 'Paid' : 'Unpaid'}</td><td>{t.quota === null ? 'Unlimited' : t.quota}</td>
            <td>{t.quota === null ? '—' : t.accrual === 'monthly' ? 'Monthly' : 'Up front'}</td><td>{t.quota === null ? '—' : t.carryForwardMax || 'None'}</td>
            <td>{t.active ? 'Active' : 'Inactive'}</td>
            <td><button onClick={() => { setForm({ code: t.code, name: t.name, paid: t.paid, quota: t.quota === null ? '' : String(t.quota), accrual: t.accrual, carryForwardMax: String(t.carryForwardMax), active: t.active }); setEditId(t.id); }}>Edit</button></td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
