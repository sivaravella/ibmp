import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import PartyDetails from './PartyDetails.jsx';

export default function Parties() {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ type: 'customer', name: '', gstin: '', stateCode: '', pan: '' });
  const [err, setErr] = useState('');
  const [found, setFound] = useState(null);       // GSTIN lookup result
  const [editing, setEditing] = useState(null);     // party whose address is being edited
  const load = () => api('GET', '/parties').then(setRows);
  useEffect(() => { load(); }, []);

  async function setPan(p) {
    const pan = window.prompt(`PAN of ${p.name} (used for TDS). Leave empty to clear.`, p.pan || '');
    if (pan === null) return;
    try { await api('PUT', `/parties/${p.id}/pan`, { pan: pan.trim() ? pan.trim().toUpperCase() : null }); load(); } catch (e2) { setErr(e2.message); }
  }

  async function add(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', '/parties', {
        type: f.type, name: f.name,
        ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : { stateCode: f.stateCode }),
        ...(f.type === 'vendor' && f.pan ? { pan: f.pan.toUpperCase() } : {}),
      });
      setF({ ...f, name: '', gstin: '', stateCode: '', pan: '' });
      setFound(null);
      load();
    } catch (e2) { setErr(e2.message); }
  }

  // Look the GSTIN up with the GSP and fill the name. The user can still edit it before saving.
  async function fetchGstin() {
    setErr(''); setFound(null);
    try {
      const g = await api('GET', `/filing/gstin/${f.gstin.trim()}`);
      setFound(g);
      setF({ ...f, gstin: g.gstin, name: f.name || g.tradeName || g.legalName });
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <h2>Parties</h2>
      <form className="card row" onSubmit={add}>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option>customer</option><option>vendor</option>
        </select>
        <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <input placeholder="GSTIN" value={f.gstin} onChange={(e) => { setF({ ...f, gstin: e.target.value }); setFound(null); }} />
        {f.gstin.length === 15 && <button type="button" onClick={fetchGstin}>Fetch details</button>}
        {!f.gstin && <input placeholder="State code" maxLength={2} value={f.stateCode}
          onChange={(e) => setF({ ...f, stateCode: e.target.value })} required />}
        {f.type === 'vendor' && <input placeholder="PAN (for TDS)" maxLength={10} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} style={{ width: 120 }} />}
        <button className="primary">Add</button>
      </form>
      {found && (
        <p className="muted" style={{ marginTop: -8 }}>
          {found.simulated && <strong style={{ color: '#92400e' }}>SIMULATED: not real taxpayer data. </strong>}
          {found.legalName} · {found.status} · state {found.stateCode}{found.status !== 'Active' && <span className="err"> ⚠ This GSTIN is not active.</span>}
        </p>
      )}
      {err && <p className="err">{err}</p>}
      {editing && <PartyDetails party={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>GSTIN</th><th>PAN</th><th>State</th><th>Address</th><th /></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.type}</td><td>{p.gstin || '—'}</td><td>{p.type === 'vendor' ? <>{p.pan || (p.gstin ? <span className="muted">{p.gstin.slice(2, 12)}</span> : <span style={{ color: '#92400e' }}>none</span>)} <button onClick={() => setPan(p)}>Set</button></> : '—'}</td><td>{p.stateCode}</td><td>{p.addr1 && p.loc && p.pin ? <span className="muted">{p.loc} {p.pin}</span> : <span style={{ color: '#92400e' }}>incomplete</span>}</td><td><button onClick={() => { setEditing(p); window.scrollTo(0, 0); }}>Details</button></td></tr>)}</tbody>
      </table>
    </>
  );
}
