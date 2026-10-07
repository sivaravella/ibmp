import React, { useState } from 'react';
import { api } from '../api.js';

/** Postal and contact details of a party: required for e-invoices and e-way bills. */
export default function PartyDetails({ party, onSaved, onClose }) {
  const [f, setF] = useState({ addr1: party.addr1 ?? '', addr2: party.addr2 ?? '', loc: party.loc ?? '', pin: party.pin ?? '', phone: party.phone ?? '', email: party.email ?? '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr('');
    try { await api('PUT', `/parties/${party.id}`, f); onSaved(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="card" onSubmit={save}>
      <div className="row"><strong>{party.name}</strong><span className="muted">{party.gstin || 'unregistered'}</span><button type="button" onClick={onClose}>Close</button></div>
      <div className="row">
        <input placeholder="Address line 1" value={f.addr1} onChange={set('addr1')} style={{ minWidth: 260 }} />
        <input placeholder="Address line 2" value={f.addr2} onChange={set('addr2')} />
      </div>
      <div className="row">
        <input placeholder="Town / city" value={f.loc} onChange={set('loc')} />
        <input placeholder="PIN code" maxLength={6} value={f.pin} onChange={set('pin')} style={{ width: 110 }} />
        <input placeholder="Phone" value={f.phone} onChange={set('phone')} />
        <input type="email" placeholder="Email" value={f.email} onChange={set('email')} />
      </div>
      {err && <p className="err">{err}</p>}
      <button className="primary">Save details</button>
    </form>
  );
}
