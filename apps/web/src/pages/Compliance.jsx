import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Reminders from './Reminders.jsx';

const STATUS = {
  overdue: { label: 'Overdue', color: '#b91c1c', bg: '#fee2e2' },
  due_soon: { label: 'Due soon', color: '#92400e', bg: '#fef3c7' },
  upcoming: { label: 'Upcoming', color: '#475569', bg: '#f1f5f9' },
  completed: { label: 'Completed', color: '#15803d', bg: '#dcfce7' },
};
const CATEGORIES = ['GST', 'TDS', 'PF', 'ESI', 'Income Tax', 'Custom'];
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => { const [y, m, dd] = d.split('-'); return `${dd}-${m}-${y}`; };
const fyShift = (fy, n) => { const s = Number(fy.slice(0, 4)) + n; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const keyOf = (i) => `${i.ruleCode}|${i.periodKey}`;

function when(i) {
  if (i.status === 'completed') return `${i.filedLate ? 'Filed late' : 'Filed'} ${fmt(i.completedOn)}`;
  const d = i.daysToDue;
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`;
  return d === 0 ? 'Due today' : `in ${d} day${d === 1 ? '' : 's'}`;
}

export default function Compliance({ go }) {
  const [fy, setFy] = useState(null);
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [cat, setCat] = useState('all');
  const [edit, setEdit] = useState(null);       // { key, mode: 'file' | 'extend', ... }
  const [showSettings, setShowSettings] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api('GET', '/compliance' + (fy ? `?fy=${fy}` : '')).then((d) => { setData(d); if (!fy) setFy(d.fy); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [fy]);

  async function save(item, body) {
    setErr('');
    try { await api('PUT', '/compliance/records', { fy: data.fy, ruleCode: item.ruleCode, periodKey: item.periodKey, ...body }); setEdit(null); load(); }
    catch (e) { setErr(e.message); }
  }

  if (!data) return <p>{err || 'Loading…'}</p>;
  const items = data.items.filter((i) => (filter === 'all' || i.status === filter) && (cat === 'all' || i.category === cat));

  return (
    <>
      <h2>Compliance calendar</h2>
      <div className="row">
        <button onClick={() => setFy(fyShift(data.fy, -1))}>‹</button>
        <strong>FY {data.fy}</strong>
        <button onClick={() => setFy(fyShift(data.fy, 1))}>›</button>
        <button onClick={() => setShowCustom(!showCustom)}>+ Custom item</button>
        <button onClick={() => setShowSettings(!showSettings)}>Applicability settings</button>
        <button onClick={() => setShowReminders(!showReminders)}>Reminders</button>
      </div>

      {showSettings && <Settings onSaved={() => { setShowSettings(false); load(); }} />}
      {showReminders && <Reminders />}
      {showCustom && <Custom onSaved={() => { setShowCustom(false); load(); }} />}

      <div className="row">
        {['overdue', 'due_soon', 'upcoming', 'completed'].map((s) => (
          <button key={s} onClick={() => setFilter(filter === s ? 'all' : s)}
            style={{ background: STATUS[s].bg, color: STATUS[s].color, borderColor: filter === s ? STATUS[s].color : 'transparent' }}>
            {STATUS[s].label}: <strong>{data.summary[s]}</strong>
          </button>
        ))}
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <p className="muted">
        Due dates are the statutory defaults. When the government extends one, use "Extend" so it is tracked against the revised date.
        Filing itself happens on the government portal; mark items filed here once done.
      </p>
      {err && <p className="err">{err}</p>}

      {items.map((i) => {
        const st = STATUS[i.status];
        const open = edit?.key === keyOf(i);
        return (
          <div className="card" key={keyOf(i)} style={{ borderLeft: `4px solid ${st.color}`, marginBottom: 8 }}>
            <div className="row" style={{ marginBottom: 0 }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong>{i.name}</strong> <span className="muted">· {i.category}</span>
                {i.note && <div className="muted" style={{ fontSize: 12 }}>{i.note}</div>}
                {i.reference && <div className="muted" style={{ fontSize: 12 }}>Ref: {i.reference}</div>}
              </div>
              <div style={{ minWidth: 190 }}>
                Due {fmt(i.due)}{i.overridden && <span className="muted"> (was {fmt(i.statutoryDue)})</span>}
                <div style={{ color: st.color, fontSize: 12 }}>{when(i)}</div>
                {i.overridden && i.overrideNote && <div className="muted" style={{ fontSize: 12 }}>{i.overrideNote}</div>}
              </div>
              <span style={{ background: st.bg, color: st.color, padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{st.label}</span>
              {i.link && <button onClick={() => go('gst', { period: i.link.period })}>View report</button>}
              {i.status === 'completed'
                ? <button onClick={() => save(i, { completedOn: null })}>Undo</button>
                : <button className="primary" onClick={() => setEdit({ key: keyOf(i), mode: 'file', date: today(), ref: '' })}>Mark filed</button>}
              {i.status !== 'completed' && i.ruleCode !== 'CUSTOM' &&
                <button onClick={() => setEdit({ key: keyOf(i), mode: 'extend', date: i.due, note: i.overrideNote || '' })}>Extend</button>}
              {i.ruleCode === 'CUSTOM' &&
                <button onClick={async () => { await api('DELETE', `/compliance/custom/${i.periodKey}`); load(); }}>Delete</button>}
            </div>
            {open && edit.mode === 'file' && (
              <div className="row" style={{ marginTop: 10 }}>
                <input type="date" value={edit.date} max={today()} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
                <input placeholder="ARN / challan no. (optional)" value={edit.ref} onChange={(e) => setEdit({ ...edit, ref: e.target.value })} />
                <button className="primary" onClick={() => save(i, { completedOn: edit.date, reference: edit.ref || null })}>Save</button>
                <button onClick={() => setEdit(null)}>Cancel</button>
              </div>
            )}
            {open && edit.mode === 'extend' && (
              <div className="row" style={{ marginTop: 10 }}>
                <input type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
                <input placeholder="Reason, e.g. notification no." value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                <button className="primary" onClick={() => save(i, { dueOverride: edit.date === i.statutoryDue ? null : edit.date, overrideNote: edit.note || null })}>Save</button>
                {i.overridden && <button onClick={() => save(i, { dueOverride: null })}>Restore statutory date</button>}
                <button onClick={() => setEdit(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
      {!items.length && <p className="muted">Nothing to show for this filter.</p>}
    </>
  );
}

function Settings({ onSaved }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/compliance/settings').then(setS); }, []);
  if (!s) return null;
  const tick = (k, label) => <label><input type="checkbox" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /> {label}</label>;
  async function save() {
    try {
      await api('PUT', '/compliance/settings', {
        gstFrequency: s.gstFrequency, tdsDeductor: s.tdsDeductor, tdsNonsalary: !!s.tdsNonsalary, pf: s.pf, esi: s.esi, advanceTax: s.advanceTax, taxAudit: s.taxAudit,
        trackFrom: s.trackingFrom,
      });
      onSaved();
    } catch (e) { setErr(e.message); }
  }
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Which compliances apply?</h3>
      {!s.gstRegistered && <p className="muted">No GSTIN on the company profile, so GST items are not generated.</p>}
      <div className="row">
        <label>GST filing{' '}
          <select value={s.gstFrequency} onChange={(e) => setS({ ...s, gstFrequency: e.target.value })} disabled={!s.gstRegistered}>
            <option value="monthly">Monthly (GSTR-1 + GSTR-3B)</option>
            <option value="quarterly">Quarterly (QRMP)</option>
          </select>
        </label>
        {tick('tdsDeductor', 'Deduct TDS on salary (24Q)')}{tick('tdsNonsalary', 'TDS on other payments (26Q)')}{tick('pf', 'PF')}{tick('esi', 'ESI')}{tick('advanceTax', 'Advance tax')}{tick('taxAudit', 'Tax audit applies')}
      </div>
      <div className="row">
        <label>Track items due from{' '}
          <input type="date" value={s.trackingFrom} onChange={(e) => setS({ ...s, trackingFrom: e.target.value })} />
        </label>
        <span className="muted">Earlier periods are hidden. Move this back to record past filings.</span>
      </div>
      {err && <p className="err">{err}</p>}
      <button className="primary" onClick={save}>Save settings</button>
    </div>
  );
}

function Custom({ onSaved }) {
  const [f, setF] = useState({ name: '', category: 'Custom', dueDate: '' });
  const [err, setErr] = useState('');
  async function add(e) {
    e.preventDefault();
    try { await api('POST', '/compliance/custom', f); onSaved(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="card row" onSubmit={add}>
      <input placeholder="What needs doing?" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
      <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} required />
      <button className="primary">Add</button>
      {err && <span className="err">{err}</span>}
    </form>
  );
}
