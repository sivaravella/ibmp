import React, { useState } from 'react';
import { api, inr } from '../api.js';

/** Record a receipt (base = 'invoices') or a vendor payment (base = 'purchases'). */
export default function PayForm({ base, doc, onDone, onClose }) {
  const due = Number(doc.total) - Number(doc.returned) - Number(doc.paid);
  const [amount, setAmount] = useState(due.toFixed(2));
  const [mode, setMode] = useState('cash');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');
  const receipt = base === 'invoices';

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', `/${base}/${doc.id}/payments`, { amount: Number(amount), mode, date });
      onDone();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{receipt ? 'Receipt' : 'Payment'} — {doc.number}</h3>
        <span className="muted">Balance due {inr(due)}</span>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="row">
        <input type="number" min="0.01" step="0.01" max={due} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="cash">Cash</option><option value="bank">Bank</option>
        </select>
        <input type="date" value={date} min={String(doc.date).slice(0, 10)} onChange={(e) => setDate(e.target.value)} required />
        <button className="primary">{receipt ? 'Record receipt' : 'Record payment'}</button>
      </div>
      {err && <p className="err">{err}</p>}
    </form>
  );
}
