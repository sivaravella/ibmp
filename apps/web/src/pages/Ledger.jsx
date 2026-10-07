import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

const SUBTABS = [['accounts', 'Chart of accounts'], ['journal', 'Journal'], ['tb', 'Trial balance'], ['party', 'Party statements']];
const SOURCE = { invoice: 'Invoice', purchase: 'Purchase', credit_note: 'Credit note', debit_note: 'Debit note', receipt: 'Receipt', payment: 'Payment', payroll: 'Payroll', manual: 'Manual' };

export default function Ledger() {
  const [tab, setTab] = useState('accounts');
  return (
    <>
      <h2>Ledger</h2>
      <div className="row">
        {SUBTABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'primary' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'accounts' && <Accounts />}
      {tab === 'journal' && <Journal />}
      {tab === 'tb' && <TrialBalance />}
      {tab === 'party' && <PartyStatement />}
    </>
  );
}

function Statement({ rows, opening, closing, onClose, title }) {
  return (
    <div className="card">
      <div className="row"><h3 style={{ margin: 0 }}>{title}</h3><button onClick={onClose}>Close</button></div>
      <table>
        <thead><tr><th>Date</th><th>Particulars</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
        <tbody>
          {opening !== undefined && <tr><td colSpan={5}><em>Opening balance</em></td><td>{inr(opening)}</td></tr>}
          {rows.map((l, i) => (
            <tr key={i}><td>{l.date}</td><td>{l.narration}</td><td>{SOURCE[l.sourceType]}</td>
              <td>{Number(l.debit) ? inr(l.debit) : ''}</td><td>{Number(l.credit) ? inr(l.credit) : ''}</td><td>{inr(l.balance)}</td></tr>
          ))}
          <tr><td colSpan={5}><strong>Closing balance</strong></td><td><strong>{inr(closing)}</strong></td></tr>
        </tbody>
      </table>
    </div>
  );
}

function Accounts() {
  const [rows, setRows] = useState([]);
  const [st, setSt] = useState(null);
  const [f, setF] = useState({ code: '', name: '', type: 'expense' });
  const [err, setErr] = useState('');
  const load = () => api('GET', '/accounts').then(setRows);
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/accounts', f); setF({ code: '', name: '', type: 'expense' }); load(); }
    catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      {st && <Statement title={`${st.account.code} ${st.account.name}`} rows={st.lines} opening={st.opening} closing={st.closing} onClose={() => setSt(null)} />}
      <form className="card row" onSubmit={add}>
        <input placeholder="Code (4 digits)" maxLength={4} pattern="\d{4}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required />
        <input placeholder="New account name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="primary">Add account</button>
        {err && <span className="err">{err}</span>}
      </form>
      <table>
        <thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th><th /></tr></thead>
        <tbody>{rows.map((a) => (
          <tr key={a.id}><td>{a.code}</td><td>{a.name}</td><td>{a.type}</td><td>{inr(a.debit)}</td><td>{inr(a.credit)}</td>
            <td>{inr(a.balance)} <span className="muted">{a.normal === 'debit' ? 'Dr' : 'Cr'}</span></td>
            <td><button onClick={() => api('GET', `/accounts/${a.id}/statement`).then(setSt)}>Statement</button></td></tr>
        ))}</tbody>
      </table>
    </>
  );
}

function Journal() {
  const [entries, setEntries] = useState([]);
  const [accts, setAccts] = useState([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }]);
  const [err, setErr] = useState('');
  const load = () => api('GET', '/journal').then(setEntries);
  useEffect(() => { load(); api('GET', '/accounts').then(setAccts); }, []);

  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);

  async function submit(e) {
    e.preventDefault(); setErr('');
    try {
      await api('POST', '/journal', {
        date, narration: narration || undefined,
        lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: Number(l.accountId), debit: Number(l.debit || 0), credit: Number(l.credit || 0) })),
      });
      setNarration(''); setLines(lines.map(() => ({ accountId: '', debit: '', credit: '' }))); load();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <form className="card" onSubmit={submit}>
        <div className="row">
          <strong>Manual journal</strong>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <input placeholder="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} />
        </div>
        {lines.map((l, i) => (
          <div className="row" key={i}>
            <select value={l.accountId} onChange={(e) => setLine(i, 'accountId', e.target.value)}>
              <option value="">Select account…</option>
              {accts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <input type="number" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} />
            <input type="number" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} />
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setLines([...lines, { accountId: '', debit: '', credit: '' }])}>+ Line</button>
          <span className={Math.abs(dr - cr) < 0.005 && dr > 0 ? 'muted' : 'err'}>Dr {inr(dr)} · Cr {inr(cr)}</span>
          <button className="primary" disabled={Math.abs(dr - cr) >= 0.005 || dr === 0}>Post entry</button>
        </div>
        {err && <p className="err">{err}</p>}
      </form>
      <table>
        <thead><tr><th>Date</th><th>Entry</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
        <tbody>{entries.flatMap((e) => e.lines.map((l, i) => (
          <tr key={`${e.id}-${l.id}`} style={i === 0 ? { borderTop: '2px solid #cbd5e1' } : undefined}>
            <td>{i === 0 ? e.date : ''}</td>
            <td>{i === 0 ? <>{SOURCE[e.sourceType]}<br /><span className="muted">{e.narration}</span></> : ''}</td>
            <td style={{ paddingLeft: Number(l.credit) ? 32 : 12 }}>{l.code} {l.accountName}</td>
            <td>{Number(l.debit) ? inr(l.debit) : ''}</td><td>{Number(l.credit) ? inr(l.credit) : ''}</td>
          </tr>)))}
        </tbody>
      </table>
    </>
  );
}

function TrialBalance() {
  const [asOf, setAsOf] = useState('');
  const [tb, setTb] = useState(null);
  useEffect(() => { api('GET', '/trial-balance' + (asOf ? `?asOf=${asOf}` : '')).then(setTb); }, [asOf]);
  if (!tb) return <p>Loading…</p>;
  return (
    <>
      <div className="row"><label className="muted">As of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <strong className={tb.balanced ? '' : 'err'}>{tb.balanced ? '✓ Balanced' : '✗ Out of balance'}</strong></div>
      <table>
        <thead><tr><th>Code</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
        <tbody>
          {tb.rows.map((r) => <tr key={r.id}><td>{r.code}</td><td>{r.name}</td><td>{r.debit ? inr(r.debit) : ''}</td><td>{r.credit ? inr(r.credit) : ''}</td></tr>)}
          <tr><td /><td><strong>Total</strong></td><td><strong>{inr(tb.totalDebit)}</strong></td><td><strong>{inr(tb.totalCredit)}</strong></td></tr>
        </tbody>
      </table>
    </>
  );
}

function PartyStatement() {
  const [parties, setParties] = useState([]);
  const [data, setData] = useState(null);
  useEffect(() => { api('GET', '/parties').then(setParties); }, []);
  return (
    <>
      <div className="row">
        <select defaultValue="" onChange={(e) => e.target.value && api('GET', `/parties/${e.target.value}/ledger`).then(setData)}>
          <option value="">Select party…</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
        </select>
      </div>
      {data && <Statement title={`${data.party.name} — ${data.label}`} rows={data.lines} closing={data.closing} onClose={() => setData(null)} />}
    </>
  );
}
