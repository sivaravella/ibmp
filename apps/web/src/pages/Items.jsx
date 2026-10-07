import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

const SLABS = [0, 5, 12, 18, 28, 40];

export default function Items() {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ name: '', hsn: '', rate: '', gstPct: 18, stock: '' });
  const [err, setErr] = useState('');
  const load = () => api('GET', '/items').then(setRows);
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', '/items', { name: f.name, hsn: f.hsn || undefined, rate: Number(f.rate),
        gstPct: Number(f.gstPct), stock: Number(f.stock || 0) });
      setF({ name: '', hsn: '', rate: '', gstPct: 18, stock: '' });
      load();
    } catch (e2) { setErr(e2.message); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <h2>Items</h2>
      <form className="card row" onSubmit={add}>
        <input placeholder="Name" value={f.name} onChange={set('name')} required />
        <input placeholder="HSN/SAC" value={f.hsn} onChange={set('hsn')} />
        <input type="number" step="0.01" min="0" placeholder="Rate (₹)" value={f.rate} onChange={set('rate')} required />
        <select value={f.gstPct} onChange={set('gstPct')}>{SLABS.map((s) => <option key={s} value={s}>{s}% GST</option>)}</select>
        <input type="number" min="0" placeholder="Opening stock" value={f.stock} onChange={set('stock')} />
        <button className="primary">Add</button>
      </form>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>Name</th><th>HSN</th><th>Rate</th><th>GST</th><th>Stock</th></tr></thead>
        <tbody>{rows.map((i) => <tr key={i.id}><td>{i.name}</td><td>{i.hsn || '—'}</td><td>{inr(i.rate)}</td><td>{Number(i.gstPct)}%</td><td>{Number(i.stock)}</td></tr>)}</tbody>
      </table>
    </>
  );
}
