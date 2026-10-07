import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

/** Return form for a sales invoice (credit note) or vendor bill (debit note). base = 'invoices' | 'purchases'. */
export default function ReturnForm({ base, doc, onDone, onClose }) {
  const [data, setData] = useState(null);
  const [type, setType] = useState('goods');
  const [vals, setVals] = useState({});
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const credit = base === 'invoices';

  useEffect(() => { api('GET', `/${base}/${doc.id}/returnable`).then(setData).catch((e) => setErr(e.message)); }, []);
  if (!data) return <div className="card">{err || 'Loading…'}</div>;

  const lines = data.lines;
  const picks = lines.filter((l) => Number(vals[l.id]) > 0)
    .map((l) => ({ lineId: l.id, [type === 'goods' ? 'qty' : 'amount']: Number(vals[l.id]) }));
  const est = lines.reduce((s, l) => {
    const v = Number(vals[l.id] || 0);
    const taxable = type === 'goods' ? (v >= l.remainingQty ? l.remainingTaxable : v * Number(l.rate)) : v;
    return s + taxable * (1 + Number(l.gstPct) / 100);
  }, 0);
  const nothing = lines.every((l) => l.remainingQty <= 0 && l.remainingTaxable <= 0);

  async function submit(body) {
    setErr('');
    try {
      const n = await api('POST', `/${base}/${doc.id}/returns`, { date, reason: reason || undefined, type, ...body });
      onDone(n);
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{credit ? 'Sales return (credit note)' : 'Purchase return (debit note)'} — {doc.number}</h3>
        <button onClick={onClose}>Close</button>
      </div>
      {nothing ? <p className="muted">This document is fully returned.</p> : <>
        <div className="row">
          <select value={type} onChange={(e) => { setType(e.target.value); setVals({}); }}>
            <option value="goods">Goods return (stock moves)</option>
            <option value="value">Value only (price / discount)</option>
          </select>
          <input type="date" value={date} min={String(doc.date).slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <table>
          <thead><tr><th>Item</th><th>Qty billed</th><th>Left to return</th><th>Rate</th><th>GST</th><th>{type === 'goods' ? 'Return qty' : 'Amount (excl. GST)'}</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td><td>{Number(l.qty)}</td>
              <td>{type === 'goods' ? l.remainingQty : inr(l.remainingTaxable)}</td>
              <td>{inr(l.rate)}</td><td>{Number(l.gstPct)}%</td>
              <td><input type="number" min="0" step="any" style={{ width: 110 }} value={vals[l.id] ?? ''}
                max={type === 'goods' ? l.remainingQty : l.remainingTaxable}
                onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })} /></td>
            </tr>))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Note value (incl. GST): <strong>{inr(est)}</strong></span>
          {type === 'goods' && <button onClick={() => submit({ full: true })}>Full return</button>}
          <button className="primary" disabled={!picks.length} onClick={() => submit({ lines: picks })}>
            Create {credit ? 'credit' : 'debit'} note
          </button>
        </div>
      </>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
