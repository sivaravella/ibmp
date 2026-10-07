import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

export default function Returns() {
  const [rows, setRows] = useState([]);
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { api('GET', '/returns' + (kind ? `?kind=${kind}` : '')).then(setRows); }, [kind]);

  return (
    <>
      <h2>Returns</h2>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All notes</option><option value="credit">Credit notes (sales)</option><option value="debit">Debit notes (purchase)</option>
        </select>
      </div>
      {open && (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>{open.number} — {open.partyName}</h3><button onClick={() => setOpen(null)}>Close</button></div>
          <p className="muted">{open.reason || 'No reason given'} · {open.returnType === 'goods' ? 'Goods return' : 'Value only'}</p>
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST</th><th>Taxable</th></tr></thead>
            <tbody>{open.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td>{l.qty ?? '—'}</td><td>{inr(l.rate)}</td><td>{Number(l.gstPct)}%</td><td>{inr(l.taxable)}</td></tr>)}</tbody>
          </table>
          <p>Taxable {inr(open.taxable)} · CGST {inr(open.cgst)} · SGST {inr(open.sgst)} · IGST {inr(open.igst)} · <strong>Total {inr(open.total)}</strong></p>
          <button onClick={() => window.print()}>Print</button>
        </div>
      )}
      <table>
        <thead><tr><th>Note</th><th>Type</th><th>Date</th><th>Against</th><th>Party</th><th>Taxable</th><th>GST</th><th>Total</th><th /></tr></thead>
        <tbody>{rows.map((n) => (
          <tr key={n.id}>
            <td>{n.number}</td><td>{n.kind === 'credit' ? 'Credit note' : 'Debit note'}</td><td>{String(n.date).slice(0, 10)}</td>
            <td>{n.docNumber}</td><td>{n.partyName}</td><td>{inr(n.taxable)}</td>
            <td>{inr(Number(n.cgst) + Number(n.sgst) + Number(n.igst))}</td><td>{inr(n.total)}</td>
            <td><button onClick={() => api('GET', `/returns/${n.id}`).then(setOpen)}>View</button></td>
          </tr>))}
        </tbody>
      </table>
    </>
  );
}
