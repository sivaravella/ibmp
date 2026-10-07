import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';
import ReturnForm from './ReturnForm.jsx';
import PayForm from './PayForm.jsx';

export default function Invoices() {
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [partyId, setPartyId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ itemId: '', qty: 1 }]);
  const [err, setErr] = useState('');
  const [ret, setRet] = useState(null);
  const [payDoc, setPayDoc] = useState(null);

  const load = () => Promise.all([
    api('GET', '/invoices').then(setRows),
    api('GET', '/items').then(setItems),
  ]);
  useEffect(() => { load(); api('GET', '/parties?type=customer').then(setCustomers); }, []);

  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  async function create(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', '/invoices', {
        partyId: Number(partyId), date,
        lines: lines.map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty) })),
      });
      setLines([{ itemId: '', qty: 1 }]);
      load();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <h2>Invoices</h2>
      <form className="card" onSubmit={create}>
        <div className="row">
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">Select customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        {lines.map((l, i) => (
          <div className="row" key={i}>
            <select value={l.itemId} onChange={(e) => setLine(i, 'itemId', e.target.value)} required>
              <option value="">Select item…</option>
              {items.map((it) => <option key={it.id} value={it.id}>{it.name} (stock {Number(it.stock)})</option>)}
            </select>
            <input type="number" min="0.001" step="any" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} required />
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setLines([...lines, { itemId: '', qty: 1 }])}>+ Line</button>
          <button className="primary">Create invoice</button>
        </div>
        {err && <p className="err">{err}</p>}
      </form>
      {payDoc && <PayForm base="invoices" doc={payDoc} onClose={() => setPayDoc(null)} onDone={() => { setPayDoc(null); load(); }} />}
      {ret && <ReturnForm base="invoices" doc={ret} onClose={() => setRet(null)} onDone={() => { setRet(null); load(); }} />}
      <table>
        <thead><tr><th>No.</th><th>Date</th><th>Customer</th><th>Taxable</th><th>GST</th><th>Total</th><th>Returned</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}>
            <td>{i.number}</td><td>{String(i.date).slice(0, 10)}</td><td>{i.partyName}</td>
            <td>{inr(i.taxable)}</td><td>{inr(Number(i.cgst) + Number(i.sgst) + Number(i.igst))}</td>
            <td>{inr(i.total)}</td><td>{Number(i.returned) ? inr(i.returned) : "—"}</td><td>{i.status}</td>
            <td>{i.status !== 'paid' && i.status !== 'returned' && <button onClick={() => setPayDoc(i)}>Record payment</button>}{i.status !== 'returned' && <button onClick={() => setRet(i)}>↩ Return</button>}</td>
          </tr>))}
        </tbody>
      </table>
    </>
  );
}
