import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';
import ReturnForm from './ReturnForm.jsx';
import PayForm from './PayForm.jsx';

const SLABS = [0, 5, 12, 18, 28];
const blank = { itemId: '', qty: 1, rate: '', gstPct: '' };

export default function Purchases() {
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [items, setItems] = useState([]);
  const [partyId, setPartyId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([blank]);
  const [err, setErr] = useState('');
  const [ret, setRet] = useState(null);
  const [payDoc, setPayDoc] = useState(null);

  const load = () => Promise.all([api('GET', '/purchases').then(setRows), api('GET', '/items').then(setItems)]);
  useEffect(() => { load(); api('GET', '/parties?type=vendor').then(setVendors); }, []);

  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const pickItem = (i, id) => {
    const it = items.find((x) => String(x.id) === id);
    setLines(lines.map((l, j) => (j === i ? { ...l, itemId: id, rate: it ? Number(it.rate) : '', gstPct: it ? Number(it.gstPct) : '' } : l)));
  };

  const taxable = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);
  const gst = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0) * Number(l.gstPct || 0) / 100, 0);

  async function create(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', '/purchases', {
        partyId: Number(partyId), supplierBillNo: billNo, date,
        lines: lines.map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty), rate: Number(l.rate), gstPct: Number(l.gstPct) })),
      });
      setBillNo(''); setLines([blank]);
      load();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <h2>Purchases</h2>
      <form className="card" onSubmit={create}>
        <div className="row">
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">Select vendor?</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <input placeholder="Vendor's bill no." value={billNo} onChange={(e) => setBillNo(e.target.value)} required />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        {lines.map((l, i) => (
          <div className="row" key={i}>
            <select value={l.itemId} onChange={(e) => pickItem(i, e.target.value)} required>
              <option value="">Select item?</option>
              {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
            </select>
            <input type="number" min="0.001" step="any" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} required />
            <input type="number" min="0" step="0.01" placeholder="Cost rate (excl. GST)" value={l.rate} onChange={(e) => setLine(i, 'rate', e.target.value)} required />
            <select value={l.gstPct} onChange={(e) => setLine(i, 'gstPct', e.target.value)} required>
              <option value="">GST %</option>{SLABS.map((s) => <option key={s} value={s}>{s}%</option>)}
            </select>
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setLines([...lines, blank])}>+ Line</button>
          <span className="muted">Taxable {inr(taxable)} + GST {inr(gst)} = <strong>{inr(taxable + gst)}</strong></span>
          <button className="primary">Save bill (adds stock)</button>
        </div>
        {err && <p className="err">{err}</p>}
      </form>
      {payDoc && <PayForm base="purchases" doc={payDoc} onClose={() => setPayDoc(null)} onDone={() => { setPayDoc(null); load(); }} />}
      {ret && <ReturnForm base="purchases" doc={ret} onClose={() => setRet(null)} onDone={() => { setRet(null); load(); }} />}
      <table>
        <thead><tr><th>No.</th><th>Vendor bill</th><th>Date</th><th>Vendor</th><th>Taxable</th><th>Input GST</th><th>Total</th><th>Returned</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((b) => (
          <tr key={b.id}>
            <td>{b.number}</td><td>{b.supplierBillNo}</td><td>{String(b.date).slice(0, 10)}</td><td>{b.partyName}</td>
            <td>{inr(b.taxable)}</td><td>{inr(Number(b.cgst) + Number(b.sgst) + Number(b.igst))}</td>
            <td>{inr(b.total)}</td><td>{Number(b.returned) ? inr(b.returned) : "—"}</td><td>{b.status}</td>
            <td>{b.status !== 'paid' && b.status !== 'returned' && <button onClick={() => setPayDoc(b)}>Record payment</button>}{b.status !== 'returned' && <button onClick={() => setRet(b)}>↩ Return</button>}</td>
          </tr>))}
        </tbody>
      </table>
    </>
  );
}
