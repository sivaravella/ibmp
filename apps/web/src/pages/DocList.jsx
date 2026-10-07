import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { COLORS } from '../ui/charts.jsx';
import { EmptyState, KpiCard, PageHeader, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, StatusBadge, Toolbar, useTable } from '../ui/forms.jsx';
import { fmtDate, inr, inrCompact, monthLabel } from '../ui/format.js';
import PayForm from './PayForm.jsx';
import ReturnForm from './ReturnForm.jsx';

const SLABS = [0, 5, 12, 18, 28];
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => Number(v) || 0;
const isoDay = (d) => d.toISOString().slice(0, 10);
const RANGES = [['all', 'All time'], ['month', 'This month'], ['last', 'Last month'], ['quarter', 'This quarter'], ['fy', 'This financial year'], ['custom', 'Custom…']];
/** [from, to] (inclusive ISO dates) for a preset; the Indian financial year starts in April. */
function rangeOf(r, from, to) {
  const n = new Date(), y = n.getUTCFullYear(), m = n.getUTCMonth(), u = (yy, mm, dd) => isoDay(new Date(Date.UTC(yy, mm, dd)));
  if (r === 'month') return [u(y, m, 1), u(y, m + 1, 0)];
  if (r === 'last') return [u(y, m - 1, 1), u(y, m, 0)];
  if (r === 'quarter') { const q = m - (m % 3); return [u(y, q, 1), u(y, q + 3, 0)]; }
  if (r === 'fy') { const s0 = m >= 3 ? y : y - 1; return [u(s0, 3, 1), u(s0 + 1, 2, 31)]; }
  if (r === 'custom') return [from || '0000-01-01', to || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
const SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['high', 'Highest amount'], ['due', 'Highest balance'], ['duedate', 'Due date']];
const csvCell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const due = (r) => Math.max(0, num(r.total) - num(r.paid) - num(r.returned) - num(r.tds));
const gst = (r) => num(r.cgst) + num(r.sgst) + num(r.igst);

const KINDS = {
  sales: {
    base: 'invoices', title: 'Invoices', subtitle: 'What you have billed, what has been collected and what is still owed to you',
    partyType: 'customer', partyLabel: 'Customer', newLabel: 'New invoice', docLabel: 'Invoice', gstLabel: 'GST', dueLabel: 'Balance due',
    kpi: ['Billed', 'Collected', 'Outstanding'], open: 'open invoices', payTitle: 'Record a receipt', created: 'created',
  },
  purchase: {
    base: 'purchases', title: 'Purchases', subtitle: 'Vendor bills, what you have paid and what you still owe',
    partyType: 'vendor', partyLabel: 'Vendor', newLabel: 'New bill', docLabel: 'Bill', gstLabel: 'Input GST', dueLabel: 'Payable',
    kpi: ['Billed by vendors', 'Paid', 'Payable'], open: 'open bills', payTitle: 'Record a payment', created: 'recorded',
  },
};

/** Totals of `field` by month for the last six months, oldest first, for a KPI trend line. */
function monthly(rows, field) {
  const now = new Date(), keys = Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - i), 1)); return d.toISOString().slice(0, 7); });
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) { const k = String(r.date).slice(0, 7); if (k in sums) sums[k] += field(r); }
  return keys.map((k) => sums[k]);
}

/** The month so far against the same days of last month, from the rows themselves. */
function monthToDate(rows, field) {
  const now = new Date(), dom = now.getUTCDate();
  const cur = now.toISOString().slice(0, 7), prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  let a = 0, b = 0;
  for (const r of rows) {
    const d = String(r.date);
    if (d.slice(0, 7) === cur) a += field(r); else if (d.slice(0, 7) === prev && Number(d.slice(8, 10)) <= dom) b += field(r);
  }
  return { value: a, pct: b > 0 ? ((a - b) / b) * 100 : null, label: monthLabel(cur) };
}

/** Sales invoices and vendor bills share one screen: a summary, a searchable list, and drawers for new documents, payments and returns. */
export default function DocList({ kind, go }) {
  const K = KINDS[kind];
  const purchase = kind === 'purchase';
  const [rows, setRows] = useState(null);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [drawer, setDrawer] = useState(null);       // { type: 'new' } | { type: 'pay', doc } | { type: 'return', doc }
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');

  const load = () => api('GET', `/${K.base}`).then(setRows).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    api('GET', '/items').then(setItems);
    api('GET', `/parties?type=${K.partyType}`).then(setParties);
  }, [kind]);

  const [range, setRange] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [partyF, setPartyF] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [sort, setSort] = useState('new');
  const isOverdue = (r) => !purchase && r.dueDate && String(r.dueDate).slice(0, 10) < today() && due(r) > 0.005 && r.status !== 'returned';
  const pre = useMemo(() => {
    const [a, b] = rangeOf(range, from, to);
    const out = (rows ?? []).filter((r) => { const d = String(r.date).slice(0, 10); return d >= a && d <= b && (!partyF || String(r.partyId) === partyF) && (!overdueOnly || isOverdue(r)); });
    const by = { new: (x, y) => y.id - x.id, old: (x, y) => x.id - y.id, high: (x, y) => num(y.total) - num(x.total), due: (x, y) => due(y) - due(x), duedate: (x, y) => String(x.dueDate ?? '9999').localeCompare(String(y.dueDate ?? '9999')) };
    return out.sort(by[sort]);
  }, [rows, range, from, to, partyF, overdueOnly, sort]);
  const filtered = range !== 'all' || partyF || overdueOnly;
  const table = useTable(pre, {
    filter: (r) => r.status,
    match: (r, q) => [r.number, r.partyName, r.supplierBillNo].some((x) => String(x ?? '').toLowerCase().includes(q)),
  });
  const counts = useMemo(() => { const c = { all: 0, unpaid: 0, partial: 0, paid: 0, returned: 0 }; for (const r of pre) { c.all++; c[r.status] = (c[r.status] ?? 0) + 1; } return c; }, [pre]);
  const overdueCount = useMemo(() => (rows ?? []).filter(isOverdue).length, [rows]);

  if (!rows) return <><PageHeader title={K.title} subtitle={K.subtitle} /><Skeleton rows={5} height={44} /></>;

  const live = rows.filter((r) => r.status !== 'returned');
  const billed = live.reduce((s, r) => s + num(r.total) - num(r.returned), 0);
  const collected = rows.reduce((s, r) => s + num(r.paid), 0);
  const outstanding = rows.reduce((s, r) => s + due(r), 0);
  const openCount = rows.filter((r) => due(r) > 0.005 && r.status !== 'returned').length;
  const mtd = monthToDate(rows, (r) => num(r.taxable));
  const exportCsv = () => {
    const head = [K.docLabel, 'Date', 'Due date', K.partyLabel, 'Taxable', K.gstLabel, 'Total', 'Paid', 'Returned', K.dueLabel, 'Status'];
    const body = pre.map((r) => [r.number, String(r.date).slice(0, 10), r.dueDate ? String(r.dueDate).slice(0, 10) : '', r.partyName, num(r.taxable), gst(r), num(r.total), num(r.paid), num(r.returned), due(r), r.status]);
    const url = URL.createObjectURL(new Blob(['\ufeff' + [head, ...body].map((l) => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${K.base}-${today()}.csv` });
    a.click(); URL.revokeObjectURL(url);
  };
  const newDoc = () => (purchase ? (setFlash(''), setDrawer({ type: 'new' })) : go('invoice-new'));
  const open = (r) => (purchase ? undefined : go('invoice', { id: r.id }));
  const done = (msg) => { setDrawer(null); setFlash(msg); setErr(''); load(); };

  return (
    <>
      <PageHeader title={K.title} subtitle={K.subtitle}>
        <button onClick={exportCsv} disabled={!pre.length}>Export CSV</button>
        <button className="primary" onClick={newDoc}><Icon name="plus" size={15} /> {K.newLabel}</button>
      </PageHeader>

      <div className="kpi-grid">
        <KpiCard label={K.kpi[0]} value={inrCompact(billed)} icon="file" tone="brand" spark={monthly(live, (r) => num(r.total) - num(r.returned))} color={COLORS.brand} hint={`${rows.length} ${purchase ? 'bills' : 'invoices'}, after returns, incl. GST`} />
        <KpiCard label={K.kpi[1]} value={inrCompact(collected)} icon="wallet" tone="green" spark={monthly(rows, (r) => num(r.paid))} color="#059669" hint={billed ? `${Math.min(100, Math.round((collected / billed) * 100))}% of billed` : undefined} />
        <KpiCard label={K.kpi[2]} value={inrCompact(outstanding)} icon="clock" tone={outstanding ? 'amber' : 'green'} spark={monthly(rows, due)} color="#d97706" hint={`${openCount} ${K.open}`} onClick={outstanding ? () => table.setActive('unpaid') : undefined} />
        <KpiCard label={`${mtd.label} so far (excl. GST)`} value={inrCompact(mtd.value)} icon="trend" tone="teal" pct={mtd.pct} good={purchase ? 'down' : 'up'} suffix="vs same days last month" spark={monthly(rows, (r) => num(r.taxable))} color="#0d9488" />
      </div>

      {flash && <Notice tone="ok">{flash}</Notice>}
      {err && <Notice>{err}</Notice>}

      <Toolbar search={table.q} onSearch={table.setQ} placeholder={`Search ${purchase ? 'bills, vendors' : 'invoices, customers'}`}
        active={table.active} onFilter={table.setActive}
        filters={[['all', 'All'], ['unpaid', 'Unpaid'], ['partial', 'Part paid'], ['paid', 'Paid'], ['returned', 'Returned']].filter(([v]) => v === 'all' || counts[v]).map(([value, label]) => ({ value, label, count: counts[value] ?? 0 }))}>
        {!purchase && <button type="button" className={`chip overdue-chip${overdueOnly ? ' on' : ''}`} aria-pressed={overdueOnly} onClick={() => setOverdueOnly(!overdueOnly)}>Overdue<span>{overdueCount}</span></button>}
      </Toolbar>
      <div className="toolbar filter-row">
        <label>Period <select value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {range === 'custom' && <><label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label></>}
        <label>{K.partyLabel} <select value={partyF} onChange={(e) => setPartyF(e.target.value)}><option value="">All</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.filter(([v]) => !purchase || v !== 'duedate').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {filtered && <button type="button" className="row-btn" onClick={() => { setRange('all'); setFrom(''); setTo(''); setPartyF(''); setOverdueOnly(false); }}>Clear filters</button>}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{table.total} of {rows.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon={purchase ? 'cart' : 'file'} title={purchase ? 'No vendor bills yet' : 'No invoices yet'} text={purchase ? 'Record a bill from a supplier and stock, input GST and what you owe are updated for you.' : 'Create your first invoice. GST, stock and the ledger are updated for you.'}>
          <button className="primary" onClick={newDoc}>{K.newLabel}</button></EmptyState></div>
      ) : (
        <>
          <table>
            <thead><tr><th>{K.docLabel}</th><th>{K.partyLabel}</th><th className="num">Taxable</th><th className="num">{K.gstLabel}</th><th className="num">Total</th><th className="num">{K.dueLabel}</th>{!purchase && <th>Due</th>}<th>Status</th><th /></tr></thead>
            <tbody>
              {table.visible.map((r) => (
                <tr key={r.id} className={purchase ? undefined : 'row-click'} onClick={purchase ? undefined : () => open(r)}>
                  <td><Cell main={<>{r.number}{r.reverseCharge && <span className="rcm-tag" title="Reverse charge: you assess and pay the GST">RCM</span>}</>} sub={fmtDate(r.date)} /></td>
                  <td><Cell main={r.partyName} sub={purchase ? `Vendor bill ${r.supplierBillNo}` : undefined} /></td>
                  <td className="num">{inr(r.taxable)}</td><td className="num">{inr(gst(r))}</td>
                  <td className="num"><b>{inr(r.total)}</b>{num(r.returned) > 0 && <div className="muted" style={{ fontSize: 12 }}>returned {inr(r.returned)}</div>}</td>
                  <td className="num">{due(r) > 0.005 ? <span className={r.status === 'unpaid' ? 'due-pos' : ''}>{inr(due(r))}</span> : <span className="dim">—</span>}{num(r.tds) > 0 && <div className="muted" style={{ fontSize: 12 }}>TDS {inr(r.tds)}</div>}</td>
                  {!purchase && <td>{r.dueDate ? <Cell main={fmtDate(r.dueDate)} sub={isOverdue(r) ? <span className="overdue-tag">{Math.max(1, Math.round((Date.parse(today()) - Date.parse(String(r.dueDate).slice(0, 10))) / 86400000))} days overdue</span> : undefined} /> : <span className="dim">On receipt</span>}</td>}
                  <td><StatusBadge status={r.status} /></td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {due(r) > 0.005 && r.status !== 'returned' && <button className="row-btn primary" onClick={() => setDrawer({ type: 'pay', doc: r })}>{purchase ? 'Pay' : 'Receive'}</button>}
                    {r.status !== 'returned' && !r.reverseCharge && <button className="row-btn" onClick={() => setDrawer({ type: 'return', doc: r })}><Icon name="undo" size={13} /> Return</button>}
                  </td>
                </tr>))}
              {!table.visible.length && <tr><td colSpan={purchase ? 8 : 9} className="table-empty">Nothing matches your search or filters.</td></tr>}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}

      {drawer?.type === 'new' && <NewDoc K={K} purchase={purchase} parties={parties} items={items} go={go} onClose={() => setDrawer(null)} onDone={(d) => done(`${K.docLabel} ${d.number} ${K.created}.`)} />}
      <Drawer open={drawer?.type === 'pay'} title={`${K.payTitle}: ${drawer?.doc?.number ?? ''}`} subtitle={drawer?.doc?.partyName} onClose={() => setDrawer(null)}>
        {drawer?.type === 'pay' && <PayForm base={K.base} doc={drawer.doc} onDone={() => done(`${purchase ? 'Payment' : 'Receipt'} recorded against ${drawer.doc.number}.`)} onClose={() => setDrawer(null)} />}
      </Drawer>
      <Drawer open={drawer?.type === 'return'} wide title={`${purchase ? 'Purchase return (debit note)' : 'Sales return (credit note)'}: ${drawer?.doc?.number ?? ''}`} subtitle={drawer?.doc?.partyName} onClose={() => setDrawer(null)}>
        {drawer?.type === 'return' && <ReturnForm base={K.base} doc={drawer.doc} onDone={(n) => done(`${purchase ? 'Debit' : 'Credit'} note ${n?.number ?? ''} created.`)} onClose={() => setDrawer(null)} />}
      </Drawer>
    </>
  );
}

/** The drawer that creates an invoice or a vendor bill, with a live estimate of the totals. */
function NewDoc({ K, purchase, parties, items, go, onClose, onDone }) {
  const blank = () => ({ itemId: '', qty: 1, rate: '', gstPct: '' });
  const [partyId, setPartyId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([blank()]);
  const [rcm, setRcm] = useState(false);              // purchases: the vendor charged no GST, the buyer assesses and pays it
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const itemOf = (id) => items.find((x) => String(x.id) === String(id));
  const set = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i, id) => { const it = itemOf(id); set(i, { itemId: id, ...(purchase ? { rate: it ? num(it.rate) : '', gstPct: it ? num(it.gstPct) : '' } : {}) }); };

  const calc = lines.map((l) => {
    const it = itemOf(l.itemId), rate = purchase ? num(l.rate) : num(it?.rate), pct = purchase ? num(l.gstPct) : num(it?.gstPct);
    const taxable = num(l.qty) * rate;
    return { taxable, tax: (taxable * pct) / 100, pct, rate, it };
  });
  const taxable = calc.reduce((s, c) => s + c.taxable, 0), tax = calc.reduce((s, c) => s + c.tax, 0);

  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body = purchase
        ? { partyId: Number(partyId), supplierBillNo: billNo, date, ...(rcm ? { reverseCharge: true } : {}), lines: lines.map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty), rate: Number(l.rate), gstPct: Number(l.gstPct) })) }
        : { partyId: Number(partyId), date, lines: lines.map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty) })) };
      onDone(await api('POST', `/${K.base}`, body));
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <Drawer open title={K.newLabel} subtitle={purchase ? 'Stock and input GST are updated when you save' : 'GST, stock and the ledger are updated when you save'} onClose={onClose}
      footer={<><span className="total">{rcm ? 'Payable to vendor' : 'Total'} <b>{inr(rcm ? taxable : taxable + tax)}</b></span><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="doc-form" disabled={busy}>{busy ? 'Saving…' : purchase ? 'Save bill' : 'Create invoice'}</button></>}>
      <form id="doc-form" onSubmit={submit} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        {!parties.length && <Notice tone="info">You have no {K.partyLabel.toLowerCase()}s yet. <a href="#" onClick={(e) => { e.preventDefault(); go?.('parties'); }}>Add one in Parties</a> first.</Notice>}
        <div className="form-grid">
          <Field label={K.partyLabel} className="span2"><select value={partyId} onChange={(e) => setPartyId(e.target.value)} required><option value="">Select {K.partyLabel.toLowerCase()}…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          {purchase && <Field label="Vendor's bill number"><input value={billNo} onChange={(e) => setBillNo(e.target.value)} required /></Field>}
          <Field label={`${K.docLabel} date`} className={purchase ? '' : 'span2'}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        {purchase && <label className="field" style={{ marginTop: 6 }}><span className="field-label"><input type="checkbox" checked={rcm} onChange={(e) => setRcm(e.target.checked)} /> Reverse charge: the vendor has not charged GST, I pay it</span>
          {rcm && <small className="muted" style={{ display: 'block', marginTop: 4 }}>For supplies where the law makes the buyer liable, such as goods transport by road, legal services and purchases from unregistered vendors of notified goods. You pay this GST in cash with your GSTR-3B and claim it back as input credit.</small>}</label>}
        <div className="form-section">Items</div>
        <div className="lines">
          {lines.map((l, i) => (
            <div className={`line${purchase ? ' purchase' : ''}`} key={i}>
              <select value={l.itemId} onChange={(e) => pick(i, e.target.value)} required aria-label="Item"><option value="">Select item…</option>{items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
              <input type="number" min="0.001" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} required aria-label="Quantity" placeholder="Qty" />
              {purchase && <input type="number" min="0" step="0.01" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} required aria-label="Cost rate" placeholder="Rate" />}
              {purchase && <select value={l.gstPct} onChange={(e) => set(i, { gstPct: e.target.value })} required aria-label="GST rate"><option value="">GST</option>{SLABS.map((s) => <option key={s} value={s}>{s}%</option>)}</select>}
              <button type="button" className="icon-btn" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Icon name="x" size={15} /></button>
              <div className="sub">
                <span>{calc[i].it ? <>{purchase ? '' : <>{inr(calc[i].rate)} each · GST {calc[i].pct}% · </>}{!purchase && num(l.qty) > num(calc[i].it.stock) ? <span className="warn">only {num(calc[i].it.stock)} in stock</span> : <>stock {num(calc[i].it.stock)}</>}</> : ' '}</span>
                <b>{inr(calc[i].taxable)}</b>
              </div>
            </div>
          ))}
        </div>
        <div><button type="button" onClick={() => setLines([...lines, blank()])}><Icon name="plus" size={14} /> Add item</button></div>
        <div className="totals"><div><span>Taxable value</span><span>{inr(taxable)}</span></div><div><span>{rcm ? 'GST you assess and pay yourself' : `GST${purchase ? '' : ' (estimate: split into CGST/SGST or IGST on save)'}`}</span><span>{inr(tax)}</span></div><div className="grand"><span>{rcm ? 'Payable to the vendor' : 'Total'}</span><span>{inr(rcm ? taxable : taxable + tax)}</span></div></div>
      </form>
    </Drawer>
  );
}
