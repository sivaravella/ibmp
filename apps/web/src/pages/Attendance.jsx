import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const monthNow = () => new Date().toISOString().slice(0, 7);
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS = {
  P: ['Present', '#15803d', '#dcfce7'], A: ['Absent (loss of pay)', '#b91c1c', '#fee2e2'], HD: ['Half day', '#92400e', '#fef3c7'],
  L: ['Paid leave', '#1d4ed8', '#dbeafe'], HL: ['Paid half-day leave', '#1d4ed8', '#e0f2fe'], H: ['Holiday', '#6d28d9', '#ede9fe'], WO: ['Week off', '#475569', '#e2e8f0'],
};
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export default function Attendance() {
  const [month, setMonth] = useState(monthNow());
  const [data, setData] = useState(null);
  const [brush, setBrush] = useState('P');            // a status code, or null to clear
  const [presentDefault, setPresentDefault] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const load = () => api('GET', `/attendance?month=${month}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setData(null); load(); }, [month]);

  async function paint(emp, date) {
    setErr(''); setNote('');
    try {
      const r = await api('PUT', '/attendance/mark', { employeeId: emp.id, date, status: brush });
      setData((d) => ({
        ...d, employees: d.employees.map((e) => {
          if (e.id !== emp.id) return e;
          const marks = { ...e.marks };
          if (brush) marks[date] = brush; else delete marks[date];
          return { ...e, marks, summary: r.summary };
        }),
      }));
    } catch (e) { setErr(e.message); }
  }

  async function autofill() {
    setErr(''); setNote('');
    try {
      const r = await api('POST', '/attendance/autofill', { month, presentByDefault: presentDefault });
      setNote(r.filled ? `Filled ${r.filled} cell(s): ${r.WO} week off, ${r.H} holiday, ${r.P} present.` : 'Nothing to fill: every day is already marked.');
      load();
    } catch (e) { setErr(e.message); }
  }

  const locked = data?.locked;
  return (
    <>
      <h2>Attendance register</h2>
      <div className="row">
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <strong>{monthName(month)}</strong>
        <button onClick={() => setShowSettings(!showSettings)}>Week offs &amp; holidays</button>
        <button onClick={autofill} disabled={locked || !data?.employees.length}>Auto-fill</button>
        <label className="muted"><input type="checkbox" checked={presentDefault} onChange={(e) => setPresentDefault(e.target.checked)} /> mark other days present</label>
      </div>

      {locked && <p className="err">Payroll for this month is finalized, so attendance is frozen. Reopen the payroll run to make changes.</p>}
      {err && <p className="err">{err}</p>}
      {note && <p className="muted">{note}</p>}
      {showSettings && data && <Settings data={data} onChanged={load} />}

      <div className="row">
        <span className="muted">Click a cell to apply:</span>
        {Object.entries(STATUS).map(([k, [label, color, bg]]) => (
          <button key={k} title={label} onClick={() => setBrush(k)}
            style={{ background: bg, color, borderColor: brush === k ? color : 'transparent', fontWeight: 600 }}>{k}</button>
        ))}
        <button onClick={() => setBrush(null)} style={{ borderColor: brush === null ? '#0f172a' : undefined }}>Clear</button>
        <span className="muted">{brush ? STATUS[brush][0] : 'Clears the mark'}</span>
      </div>

      {!data ? <p>{err ? '' : 'Loading…'}</p> : !data.employees.length ? <p className="muted">No employees on the books this month. Add employees under Payroll.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: 'auto', minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: '#f8fafc', minWidth: 150 }}>Employee</th>
                {data.days.map((d) => (
                  <th key={d.date} title={d.holiday || (d.weekOff ? 'Week off' : DOW_LONG[d.dow])}
                    style={{ padding: '4px 2px', textAlign: 'center', fontSize: 11, background: d.holiday ? '#ede9fe' : d.weekOff ? '#e2e8f0' : undefined }}>
                    {Number(d.date.slice(8))}<div className="muted">{DOW[d.dow]}</div>
                  </th>
                ))}
                {['P', 'A', 'HD', 'L', 'LOP', 'Unmarked'].map((h) => <th key={h} style={{ textAlign: 'center', fontSize: 12 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.id}>
                  <td style={{ position: 'sticky', left: 0, background: '#fff' }}>{e.name}<div className="muted" style={{ fontSize: 12 }}>{e.code}</div></td>
                  {data.days.map((d) => {
                    const s = e.marks[d.date];
                    const inRange = d.date >= e.range.from && d.date <= e.range.to;
                    const [, color, bg] = s ? STATUS[s] : [0, '#94a3b8', 'transparent'];
                    return (
                      <td key={d.date} style={{ padding: 1, textAlign: 'center' }}>
                        <button disabled={!inRange || locked} onClick={() => paint(e, d.date)} title={s ? STATUS[s][0] : inRange ? 'Not marked' : 'Not employed'}
                          style={{ width: 30, height: 28, padding: 0, fontSize: 11, color, background: inRange ? bg : '#f1f5f9', border: inRange && !s ? '1px dashed #cbd5e1' : '1px solid transparent', opacity: inRange ? 1 : 0.4 }}>
                          {s ?? ''}
                        </button>
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'center' }}>{e.summary.P}</td><td style={{ textAlign: 'center' }}>{e.summary.A}</td>
                  <td style={{ textAlign: 'center' }}>{e.summary.HD}</td><td style={{ textAlign: 'center' }}>{e.summary.L}</td>
                  <td style={{ textAlign: 'center' }}><strong style={{ color: e.summary.lop ? '#b91c1c' : undefined }}>{e.summary.lop}</strong></td>
                  <td style={{ textAlign: 'center', color: e.summary.unmarked ? '#92400e' : '#94a3b8' }}>{e.summary.unmarked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 10 }}>
        Loss of pay = absent days + half a day per half-day. Unmarked days are paid as present, and payroll flags them.
        Payroll picks up these figures when a run is started, or when you press "Sync attendance" on a draft run.
      </p>
    </>
  );
}

function Settings({ data, onChanged }) {
  const [offs, setOffs] = useState(data.settings.weekOffs);
  const [h, setH] = useState({ date: '', name: '' });
  const [err, setErr] = useState('');
  const toggle = async (i) => {
    const next = offs.includes(i) ? offs.filter((x) => x !== i) : [...offs, i];
    try { const r = await api('PUT', '/attendance/settings', { weekOffs: next }); setOffs(r.weekOffs); onChanged(); } catch (e) { setErr(e.message); }
  };
  async function add(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/attendance/holidays', h); setH({ date: '', name: '' }); onChanged(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="card">
      <strong>Weekly offs</strong>
      <div className="row">{DOW_LONG.map((n, i) => <label key={n}><input type="checkbox" checked={offs.includes(i)} onChange={() => toggle(i)} /> {n.slice(0, 3)}</label>)}</div>
      <strong>Holidays in {monthName(data.month)}</strong>
      {data.holidays.map((x) => (
        <div className="row" key={x.id}><span>{x.date.split('-').reverse().join('-')} · {x.name}</span>
          <button onClick={async () => { await api('DELETE', `/attendance/holidays/${x.id}`); onChanged(); }}>Remove</button></div>
      ))}
      <form className="row" onSubmit={add}>
        <input type="date" value={h.date} min={`${data.month}-01`} max={`${data.month}-31`} onChange={(e) => setH({ ...h, date: e.target.value })} required />
        <input placeholder="Holiday name" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} required />
        <button className="primary">Add holiday</button>
      </form>
      {err && <p className="err">{err}</p>}
      <p className="muted">Changes apply the next time you press Auto-fill; days already marked are never overwritten.</p>
    </div>
  );
}
