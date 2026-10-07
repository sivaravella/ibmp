import React, { useEffect, useState } from 'react';
import { api, download, inr } from '../api.js';

const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const fyOf = (m) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); const s = mo >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

export default function Statutory({ go }) {
  const [month, setMonth] = useState(lastMonth());
  const [pf, setPf] = useState(null);
  const [esi, setEsi] = useState(null);
  const [ov, setOv] = useState([]);
  const [err, setErr] = useState('');
  const load = () => {
    api('GET', `/statutory/pf?month=${month}`).then(setPf).catch((e) => setErr(e.message));
    api('GET', `/statutory/esi?month=${month}`).then(setEsi).catch((e) => setErr(e.message));
    api('GET', `/statutory/overview?fy=${fyOf(month)}`).then((d) => setOv(d.months)).catch(() => {});
  };
  useEffect(() => { setPf(null); setEsi(null); load(); }, [month]);

  return (
    <>
      <h2>PF &amp; ESI</h2>
      <div className="row">
        <input type="month" value={month} max={lastMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <strong>{monthName(month)}</strong>
        <span className="muted">Both files are built from the finalized payroll for the month.</span>
      </div>
      {err && <p className="err">{err}</p>}
      {pf && esi && <>
        <div className="tiles" style={{ alignItems: 'start' }}>
          <Pf d={pf} month={month} onChange={load} go={go} />
          <Esi d={esi} month={month} onChange={load} go={go} />
        </div>
        <h3>Year at a glance (FY {fyOf(month)})</h3>
        <table>
          <thead><tr><th>Month</th><th>Due</th><th>PF amount</th><th>PF paid</th><th>TRRN</th><th>ESI amount</th><th>ESI paid</th><th>Challan</th></tr></thead>
          <tbody>{ov.map((m) => (
            <tr key={m.month} style={m.month === month ? { background: '#f8fafc' } : undefined}>
              <td>{m.month}</td><td>{fmt(m.dueDate)}</td>
              <td>{inr(m.pf.amount)}</td><td>{m.pf.remittedOn ? <>{fmt(m.pf.remittedOn)}{m.pf.late && <span style={{ color: '#b91c1c' }}> late</span>}</> : <span style={{ color: '#92400e' }}>not paid</span>}</td><td>{m.pf.trrn ?? '—'}</td>
              <td>{inr(m.esi.amount)}</td><td>{m.esi.remittedOn ? <>{fmt(m.esi.remittedOn)}{m.esi.late && <span style={{ color: '#b91c1c' }}> late</span>}</> : m.esi.amount ? <span style={{ color: '#92400e' }}>not paid</span> : '—'}</td><td>{m.esi.challan ?? '—'}</td>
            </tr>))}
          </tbody>
        </table>
      </>}
    </>
  );
}

function Issues({ d, go }) {
  return (
    <>
      {d.errors.map((e) => <p key={e} className="err">✗ {e}</p>)}
      {d.errors.some((e) => /finalize|finalized payroll/i.test(e)) && <button onClick={() => go('payroll')}>Open payroll</button>}
      {d.errors.some((e) => /UAN|ESI insurance|ESI number/.test(e)) && <button onClick={() => go('payroll')}>Fix in Payroll → Employees</button>}
      {d.warnings.length > 0 && <details style={{ margin: '8px 0' }}><summary style={{ color: '#92400e', cursor: 'pointer' }}>{d.warnings.length} warning(s)</summary><ul style={{ margin: '6px 0', paddingLeft: 18 }}>{d.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></details>}
    </>
  );
}

/** Where the money stands and the references the portal gave back. */
function Refs({ d, field, label, placeholder, onChange }) {
  const [v, setV] = useState(d.run?.reference ?? '');
  const [err, setErr] = useState('');
  useEffect(() => setV(d.run?.reference ?? ''), [d.run?.reference]);
  if (!d.run) return null;
  async function save(e) {
    e.preventDefault(); setErr('');
    try { await api('PUT', `/statutory/runs/${d.run.id}/refs`, { [field]: v || null }); onChange(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      <p className="muted" style={{ margin: '8px 0 4px' }}>
        Due {fmt(d.run.dueDate)} · {d.run.remittedOn ? <>paid {fmt(d.run.remittedOn)}{d.run.late && <span style={{ color: '#b91c1c' }}> (late)</span>}</> : <span style={{ color: '#92400e' }}>payment not recorded on the payroll run</span>}
      </p>
      <form className="row" onSubmit={save} style={{ marginBottom: 0 }}>
        <input placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        <button>Save {label}</button>
        {err && <span className="err">{err}</span>}
      </form>
    </>
  );
}

function Pf({ d, month, onChange, go }) {
  const [err, setErr] = useState('');
  const get = (format, name) => download(`/statutory/pf/export?month=${month}&format=${format}`, name).catch((e) => setErr(e.message));
  const blocked = d.errors.length > 0 || !d.rows.length;
  const c = d.challan;
  return (
    <div className="card">
      <h3 style={{ margin: 0 }}>EPF: ECR</h3>
      <p className="muted" style={{ margin: '0 0 8px' }}>Electronic challan cum return for the EPFO unified portal</p>
      <Issues d={d} go={go} />
      {d.totals && <p>{d.totals.members} member(s) · gross wages {inr(d.totals.gross)} · EPF wages {inr(d.totals.epfWages)}</p>}
      {c && (
        <table style={{ maxWidth: 420 }}><tbody>
          <tr><td>A/c 01: members' share</td><td>{inr(c.ac01Employee)}</td></tr><tr><td>A/c 01: employer's EPF share</td><td>{inr(c.ac01Employer)}</td></tr>
          <tr><td>A/c 10: pension (EPS)</td><td>{inr(c.ac10Eps)}</td></tr><tr><td>A/c 02: admin charges</td><td>{inr(c.ac02Admin)}</td></tr>
          <tr><td>A/c 21: EDLI</td><td>{inr(c.ac21Edli)}</td></tr><tr><td><strong>Total to pay</strong></td><td><strong>{inr(c.total)}</strong></td></tr>
        </tbody></table>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={blocked} onClick={() => get('ecr', d.fileName)}>Download ECR (.txt)</button>
        <button disabled={blocked} onClick={() => get('csv', d.fileName.replace('.txt', '.csv'))}>Download as CSV</button>
      </div>
      {err && <p className="err">{err}</p>}
      {d.rows.length > 0 && (
        <details><summary className="muted" style={{ cursor: 'pointer' }}>Members in the file</summary>
          <table><thead><tr><th>UAN</th><th>Name</th><th>EPF wages</th><th>Member</th><th>EPS</th><th>ER diff</th><th>NCP</th></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.employeeCode}><td>{r.uan || <span className="err">missing</span>}</td><td>{r.name}</td><td>{inr(r.epfWages)}</td><td>{inr(r.epfEe)}</td><td>{inr(r.eps)}</td><td>{inr(r.epfErDiff)}</td><td>{r.ncpDays}</td></tr>)}</tbody></table></details>
      )}
      <Refs d={d} field="pfTrrn" label="TRRN" placeholder="13-digit TRRN from the portal" onChange={onChange} />
    </div>
  );
}

function Esi({ d, month, onChange, go }) {
  const [err, setErr] = useState('');
  const blocked = d.errors.length > 0 || !d.rows.length;
  const s = d.summary;
  return (
    <div className="card">
      <h3 style={{ margin: 0 }}>ESI: monthly contribution</h3>
      <p className="muted" style={{ margin: '0 0 8px' }}>Rows for the ESIC portal's monthly contribution template</p>
      <Issues d={d} go={go} />
      {s && <table style={{ maxWidth: 420 }}><tbody>
        <tr><td>Members</td><td>{s.members}</td></tr><tr><td>Total wages</td><td>{inr(s.wages)}</td></tr>
        <tr><td>Employee's share (0.75%)</td><td>{inr(s.employeeContribution)}</td></tr><tr><td>Employer's share (3.25%)</td><td>{inr(s.employerContribution)}</td></tr>
        <tr><td><strong>Total to pay</strong></td><td><strong>{inr(s.total)}</strong></td></tr>
      </tbody></table>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={blocked} onClick={() => download(`/statutory/esi/export?month=${month}`, d.fileName).catch((e) => setErr(e.message))}>Download CSV</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Open it in Excel and save it in the format the ESIC portal accepts (its template), or paste the rows into the template.</p>
      {err && <p className="err">{err}</p>}
      {d.rows.length > 0 && (
        <details><summary className="muted" style={{ cursor: 'pointer' }}>Rows in the file</summary>
          <table><thead><tr><th>IP number</th><th>Name</th><th>Days</th><th>Wages</th><th>Reason</th><th>Last day</th></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.employeeCode}><td>{r.ipNumber || <span className="err">missing</span>}</td><td>{r.name}</td><td>{r.days}</td><td>{inr(r.wages)}</td><td>{r.reasonCode}</td><td>{r.lastWorkingDay || '—'}</td></tr>)}</tbody></table></details>
      )}
      <Refs d={d} field="esiChallan" label="challan" placeholder="ESIC challan number" onChange={onChange} />
    </div>
  );
}
