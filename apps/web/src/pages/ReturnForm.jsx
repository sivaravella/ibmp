import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Notice } from '../ui/forms.jsx';
import { Skeleton } from '../ui/kit.jsx';
import { inr } from '../ui/format.js';

/** Return form for a sales invoice (credit note) or vendor bill (debit note), rendered inside a drawer. base = 'invoices' | 'purchases'. */
export default function ReturnForm({ base, doc, onDone, onClose }) {
  const [data, setData] = useState(null);
  const [type, setType] = useState('goods');
  const [vals, setVals] = useState({});
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const credit = base === 'invoices';

  useEffect(() => { api('GET', `/${base}/${doc.id}/returnable`).then(setData).catch((e) => setErr(e.message)); }, []);
  if (!data) return err ? <Notice>{err}</Notice> : <Skeleton rows={4} height={40} />;

  const lines = data.lines;
  const picks = lines.filter((l) => Number(vals[l.id]) > 0).map((l) => ({ lineId: l.id, [type === 'goods' ? 'qty' : 'amount']: Number(vals[l.id]) }));
  const est = lines.reduce((s, l) => {
    const v = Number(vals[l.id] || 0);
    const taxable = type === 'goods' ? (v >= l.remainingQty ? l.remainingTaxable : v * Number(l.rate)) : v;
    return s + taxable * (1 + Number(l.gstPct) / 100);
  }, 0);
  const nothing = lines.every((l) => l.remainingQty <= 0 && l.remainingTaxable <= 0);

  async function submit(body) {
    setErr(''); setBusy(true);
    try { onDone(await api('POST', `/${base}/${doc.id}/returns`, { date, reason: reason || undefined, type, ...body })); } catch (e) { setErr(e.message); setBusy(false); }
  }

  if (nothing) return <Notice tone="info">This document has already been returned in full.</Notice>;
  return (
    <>
      <Notice>{err}</Notice>
      <div className="form-grid">
        <Field label="Kind of return"><select value={type} onChange={(e) => { setType(e.target.value); setVals({}); }}><option value="goods">Goods come back (stock moves)</option><option value="value">Value only (price or discount)</option></select></Field>
        <Field label="Date"><input type="date" value={date} min={String(doc.date).slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Reason" className="span2"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional, printed on the note" /></Field>
      </div>
      <table>
        <thead><tr><th>Item</th><th className="num">Billed</th><th className="num">Can return</th><th className="num">Rate</th><th className="num">{type === 'goods' ? 'Return qty' : 'Amount'}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id}>
            <td>{l.description}<div className="muted" style={{ fontSize: 12 }}>GST {Number(l.gstPct)}%</div></td>
            <td className="num">{Number(l.qty)}</td>
            <td className="num">{type === 'goods' ? l.remainingQty : inr(l.remainingTaxable)}</td>
            <td className="num">{inr(l.rate)}</td>
            <td className="num"><input type="number" min="0" step="any" style={{ width: 96, textAlign: 'right' }} value={vals[l.id] ?? ''} max={type === 'goods' ? l.remainingQty : l.remainingTaxable} onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })} aria-label={`Return ${l.description}`} /></td>
          </tr>))}
        </tbody>
      </table>
      <div className="totals"><div className="grand"><span>{credit ? 'Credit' : 'Debit'} note value (incl. GST)</span><span>{inr(est)}</span></div></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>Cancel</button>
        {type === 'goods' && <button disabled={busy} onClick={() => submit({ full: true })}>Return everything</button>}
        <button className="primary" disabled={!picks.length || busy} onClick={() => submit({ lines: picks })}>Create {credit ? 'credit' : 'debit'} note</button>
      </div>
    </>
  );
}
