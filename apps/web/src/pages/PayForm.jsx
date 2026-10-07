import React, { useState } from 'react';
import { api } from '../api.js';
import { Field, Notice } from '../ui/forms.jsx';
import { fmtDate, inr } from '../ui/format.js';

/** Record a receipt (base = 'invoices') or a vendor payment (base = 'purchases'). Rendered inside a drawer. */
export default function PayForm({ base, doc, onDone, onClose }) {
  const due = Math.max(0, Number(doc.total) - Number(doc.returned) - Number(doc.paid) - Number(doc.tds || 0));
  const [amount, setAmount] = useState(due.toFixed(2));
  const [mode, setMode] = useState('bank');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const receipt = base === 'invoices';

  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('POST', `/${base}/${doc.id}/payments`, { amount: Number(amount), mode, date }); onDone(); } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ display: 'contents' }}>
      <div className="totals">
        <div><span>Document total</span><span>{inr(doc.total)}</span></div>
        {Number(doc.returned) > 0 && <div><span>Returned</span><span>− {inr(doc.returned)}</span></div>}
        {Number(doc.tds) > 0 && <div><span>TDS deducted</span><span>− {inr(doc.tds)}</span></div>}
        {Number(doc.paid) > 0 && <div><span>{receipt ? 'Received' : 'Paid'} so far</span><span>− {inr(doc.paid)}</span></div>}
        <div className="grand"><span>Balance due</span><span>{inr(due)}</span></div>
      </div>
      <Notice>{err}</Notice>
      <div className="form-grid">
        <Field label="Amount" hint={Number(amount) < due - 0.005 ? `Part payment: ${inr(due - Number(amount))} will remain` : undefined}><input type="number" min="0.01" step="0.01" max={due} value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Paid through"><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="bank">Bank</option><option value="cash">Cash</option></select></Field>
        <Field label="Date" className="span2" hint={`Not before the document date, ${fmtDate(doc.date)}`}><input type="date" value={date} min={String(doc.date).slice(0, 10)} onChange={(e) => setDate(e.target.value)} required /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : receipt ? 'Record receipt' : 'Record payment'}</button>
      </div>
    </form>
  );
}
