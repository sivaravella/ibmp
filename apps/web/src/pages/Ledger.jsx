import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, EmptyState, KpiCard, PageHeader, Panel, Segmented, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, Toolbar, useTable } from '../ui/forms.jsx';
import { fmtDate, inr, inrCompact } from '../ui/format.js';

const SUBTABS = [['accounts', 'Chart of accounts'], ['journal', 'Journal'], ['tb', 'Trial balance'], ['party', 'Party statements']];
const SOURCE = { invoice: 'Invoice', purchase: 'Purchase', credit_note: 'Credit note', debit_note: 'Debit note', receipt: 'Receipt', payment: 'Payment', payroll: 'Payroll', manual: 'Manual', tds_deduction: 'TDS', tds_expense: 'Expense', tds_challan: 'TDS deposit', tds_reversal: 'Reversal', tds_challan_reversal: 'Reversal' };
const TYPE_TONE = { asset: 'info', liability: 'warn', equity: 'brand', income: 'ok', expense: 'bad' };
const N = (v) => Number(v) || 0;

export default function Ledger() {
  const [tab, setTab] = useState('accounts');
  return (
    <>
      <PageHeader title="Ledger" subtitle="Every invoice, bill, payment and payroll posts here: accounts, journal, trial balance and party statements">
        <Segmented label="Ledger section" value={tab} onChange={setTab} options={SUBTABS} />
      </PageHeader>
      {tab === 'accounts' && <Accounts />}
      {tab === 'journal' && <Journal />}
      {tab === 'tb' && <TrialBalance />}
      {tab === 'party' && <PartyStatement />}
    </>
  );
}

/** A running statement (account or party): opening balance, each line, closing balance. */
function Statement({ rows, opening, closing }) {
  return (
    <table>
      <thead><tr><th>Date</th><th>Particulars</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
      <tbody>
        {opening !== undefined && <tr style={{ background: 'var(--surface-2)' }}><td colSpan={5}><em>Opening balance</em></td><td className="num">{inr(opening)}</td></tr>}
        {rows.map((l, i) => (
          <tr key={i}><td>{fmtDate(l.date)}</td><td>{l.narration}</td><td><Badge tone="neutral">{SOURCE[l.sourceType] ?? l.sourceType}</Badge></td>
            <td className="num">{N(l.debit) ? inr(l.debit) : ''}</td><td className="num">{N(l.credit) ? inr(l.credit) : ''}</td><td className="num">{inr(l.balance)}</td></tr>
        ))}
        {!rows.length && <tr><td colSpan={6} className="table-empty">No entries yet.</td></tr>}
        <tr style={{ background: 'var(--surface-2)', fontWeight: 650 }}><td colSpan={5}>Closing balance</td><td className="num">{inr(closing)}</td></tr>
      </tbody>
    </table>
  );
}

function Accounts() {
  const [rows, setRows] = useState(null);
  const [st, setSt] = useState(null);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState('');
  const load = () => api('GET', '/accounts').then(setRows);
  useEffect(() => { load(); }, []);

  const table = useTable(rows ?? [], { filter: (a) => a.type, match: (a, q) => [a.code, a.name].some((x) => String(x).toLowerCase().includes(q)), size: 30 });
  const by = useMemo(() => { const t = { asset: 0, liability: 0, equity: 0, income: 0, expense: 0 }; const c = { all: rows?.length ?? 0 }; for (const a of rows ?? []) { t[a.type] += N(a.balance); c[a.type] = (c[a.type] ?? 0) + 1; } return { t, c }; }, [rows]);
  if (!rows) return <Skeleton rows={6} height={40} />;
  const profit = by.t.income - by.t.expense;

  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Assets" value={inrCompact(by.t.asset)} icon="wallet" tone="sky" hint="Cash, bank, receivables, input GST" />
        <KpiCard label="Liabilities" value={inrCompact(by.t.liability)} icon="landmark" tone="amber" hint="Payables, output GST, TDS, payroll dues" />
        <KpiCard label="Income" value={inrCompact(by.t.income)} icon="trend" tone="green" hint="Sales and other income" />
        <KpiCard label="Expenses" value={inrCompact(by.t.expense)} icon="cart" tone="rose" hint={`${profit >= 0 ? 'Surplus' : 'Deficit'} of ${inrCompact(Math.abs(profit))} so far`} />
      </div>
      {flash && <Notice tone="ok">{flash}</Notice>}
      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search code or account" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All', count: by.c.all }, ...['asset', 'liability', 'equity', 'income', 'expense'].filter((t) => by.c[t]).map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1), count: by.c[t] }))]}>
        <button className="primary" onClick={() => { setFlash(''); setAdding(true); }}><Icon name="plus" size={15} /> Add account</button>
      </Toolbar>
      <table>
        <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th><th /></tr></thead>
        <tbody>{table.visible.map((a) => (
          <tr key={a.id}>
            <td><b>{a.code}</b></td><td>{a.name}{a.isSystem && <span className="muted"> · system</span>}</td><td><Badge tone={TYPE_TONE[a.type]}>{a.type}</Badge></td>
            <td className="num">{inr(a.debit)}</td><td className="num">{inr(a.credit)}</td>
            <td className="num"><b>{inr(a.balance)}</b> <span className="muted">{a.normal === 'debit' ? 'Dr' : 'Cr'}</span></td>
            <td className="actions"><button className="row-btn" onClick={() => api('GET', `/accounts/${a.id}/statement`).then(setSt)}>Statement</button></td>
          </tr>))}
          {!table.visible.length && <tr><td colSpan={7} className="table-empty">Nothing matches your search or filter.</td></tr>}
        </tbody>
      </table>
      <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />

      <Drawer open={!!st} wide title={st ? `${st.account.code} ${st.account.name}` : ''} subtitle="Account statement" onClose={() => setSt(null)}>
        {st && <Statement rows={st.lines} opening={st.opening} closing={st.closing} />}
      </Drawer>
      {adding && <NewAccount onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); setFlash(`Account ${n} added.`); load(); }} />}
    </>
  );
}

function NewAccount({ onClose, onDone }) {
  const [f, setF] = useState({ code: '', name: '', type: 'expense' });
  const [err, setErr] = useState('');
  async function add(e) {
    e.preventDefault(); setErr('');
    try { await api('POST', '/accounts', f); onDone(`${f.code} ${f.name}`); } catch (e2) { setErr(e2.message); }
  }
  return (
    <Drawer open title="Add an account" subtitle="A new account in your chart of accounts" onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="acct-form">Add account</button></>}>
      <form id="acct-form" onSubmit={add} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-grid">
          <Field label="Code" hint="Four digits"><input maxLength={4} pattern="[0-9]{4}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></Field>
          <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['asset', 'liability', 'equity', 'income', 'expense'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Account name" className="span2"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        </div>
      </form>
    </Drawer>
  );
}

function Journal() {
  const [entries, setEntries] = useState(null);
  const [accts, setAccts] = useState([]);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const load = () => api('GET', '/journal').then(setEntries);
  useEffect(() => { load(); api('GET', '/accounts').then(setAccts); }, []);
  const table = useTable(entries ?? [], { filter: (e) => (e.sourceType === 'manual' ? 'manual' : 'auto'), match: (e, q) => [e.narration, SOURCE[e.sourceType], ...e.lines.map((l) => l.accountName)].some((x) => String(x ?? '').toLowerCase().includes(q)), size: 15 });
  if (!entries) return <Skeleton rows={6} height={40} />;
  const manual = entries.filter((e) => e.sourceType === 'manual').length;

  return (
    <>
      {flash && <Notice tone="ok">{flash}</Notice>}
      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search narration or account" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All entries', count: entries.length }, { value: 'auto', label: 'From documents', count: entries.length - manual }, { value: 'manual', label: 'Manual', count: manual }]}>
        <button className="primary" onClick={() => { setFlash(''); setOpen(true); }}><Icon name="plus" size={15} /> Manual journal</button>
      </Toolbar>
      {entries.length === 0 ? <div className="panel"><EmptyState icon="book" title="No entries yet" text="Entries appear as you create invoices, bills and payments." /></div> : (
        <>
          <table>
            <thead><tr><th>Date</th><th>Entry</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>{table.visible.flatMap((e) => e.lines.map((l, i) => (
              <tr key={`${e.id}-${l.id}`} style={i === 0 ? { borderTop: '2px solid var(--line)' } : undefined}>
                <td>{i === 0 ? fmtDate(e.date) : ''}</td>
                <td>{i === 0 ? <Cell main={SOURCE[e.sourceType] ?? e.sourceType} sub={e.narration} /> : ''}</td>
                <td style={{ paddingLeft: N(l.credit) ? 32 : 14 }}>{l.code} {l.accountName}</td>
                <td className="num">{N(l.debit) ? inr(l.debit) : ''}</td><td className="num">{N(l.credit) ? inr(l.credit) : ''}</td>
              </tr>)))}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}
      {open && <NewJournal accts={accts} onClose={() => setOpen(false)} onDone={() => { setOpen(false); setFlash('Journal entry posted.'); load(); }} />}
    </>
  );
}

function NewJournal({ accts, onClose, onDone }) {
  const blank = () => ({ accountId: '', debit: '', credit: '' });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState([blank(), blank()]);
  const [err, setErr] = useState('');
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const dr = lines.reduce((s, l) => s + N(l.debit), 0), cr = lines.reduce((s, l) => s + N(l.credit), 0);
  const balanced = Math.abs(dr - cr) < 0.005 && dr > 0;
  async function submit(e) {
    e.preventDefault(); setErr('');
    try {
      await api('POST', '/journal', { date, narration: narration || undefined, lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: Number(l.accountId), debit: N(l.debit), credit: N(l.credit) })) });
      onDone();
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <Drawer open wide title="Manual journal" subtitle="Debits must equal credits" onClose={onClose}
      footer={<><span className="total">Dr <b>{inr(dr)}</b> · Cr <b>{inr(cr)}</b>{!balanced && dr + cr > 0 && <span style={{ color: 'var(--rose)' }}> · out by {inr(Math.abs(dr - cr))}</span>}</span><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="je-form" disabled={!balanced}>Post entry</button></>}>
      <form id="je-form" onSubmit={submit} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-grid"><Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field><Field label="Narration"><input value={narration} onChange={(e) => setNarration(e.target.value)} /></Field></div>
        <div className="form-section">Lines</div>
        <div className="lines">
          {lines.map((l, i) => (
            <div className="line" key={i} style={{ gridTemplateColumns: 'minmax(0,1fr) 120px 120px 28px' }}>
              <select value={l.accountId} onChange={(e) => setLine(i, 'accountId', e.target.value)} aria-label="Account"><option value="">Select account…</option>{accts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
              <input type="number" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} aria-label="Debit" />
              <input type="number" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} aria-label="Credit" />
              <button type="button" className="icon-btn" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Icon name="x" size={15} /></button>
            </div>))}
        </div>
        <div><button type="button" onClick={() => setLines([...lines, blank()])}><Icon name="plus" size={14} /> Add line</button></div>
      </form>
    </Drawer>
  );
}

function TrialBalance() {
  const [asOf, setAsOf] = useState('');
  const [tb, setTb] = useState(null);
  useEffect(() => { api('GET', '/trial-balance' + (asOf ? `?asOf=${asOf}` : '')).then(setTb); }, [asOf]);
  if (!tb) return <Skeleton rows={6} height={40} />;
  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Total debits" value={inrCompact(tb.totalDebit)} icon="book" tone="brand" />
        <KpiCard label="Total credits" value={inrCompact(tb.totalCredit)} icon="book" tone="teal" />
        <KpiCard label="Books" value={tb.balanced ? 'Balanced' : 'Out of balance'} icon={tb.balanced ? 'check' : 'alert'} tone={tb.balanced ? 'green' : 'rose'} hint={tb.balanced ? 'Debits equal credits' : `Difference ${inr(Math.abs(tb.totalDebit - tb.totalCredit))}`} />
      </div>
      <Toolbar><label className="muted">As of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>{asOf && <button onClick={() => setAsOf('')}>Today</button>}</Toolbar>
      <table>
        <thead><tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {tb.rows.map((r) => <tr key={r.id}><td><b>{r.code}</b></td><td>{r.name}</td><td className="num">{r.debit ? inr(r.debit) : ''}</td><td className="num">{r.credit ? inr(r.credit) : ''}</td></tr>)}
          <tr style={{ background: 'var(--surface-2)', fontWeight: 650 }}><td /><td>Total</td><td className="num">{inr(tb.totalDebit)}</td><td className="num">{inr(tb.totalCredit)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function PartyStatement() {
  const [parties, setParties] = useState([]);
  const [id, setId] = useState('');
  const [data, setData] = useState(null);
  useEffect(() => { api('GET', '/parties').then(setParties); }, []);
  useEffect(() => { if (id) api('GET', `/parties/${id}/ledger`).then(setData); else setData(null); }, [id]);
  return (
    <>
      <Toolbar>
        <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Party" style={{ minWidth: 280 }}>
          <option value="">Select a customer or vendor…</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
        </select>
      </Toolbar>
      {!data ? <div className="panel"><EmptyState icon="users" title="Choose a party" text="See every invoice, payment and note for one customer or vendor, with a running balance." /></div> : (
        <>
          <div className="kpi-grid">
            <KpiCard label={data.label} value={inr(data.closing)} icon="wallet" tone={N(data.closing) > 0 ? 'amber' : 'green'} hint={data.party.name} />
            <KpiCard label="Entries" value={data.lines.length} icon="file" tone="brand" />
          </div>
          <Statement rows={data.lines} closing={data.closing} />
        </>
      )}
    </>
  );
}
