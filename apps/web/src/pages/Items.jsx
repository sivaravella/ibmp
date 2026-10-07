import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, EmptyState, KpiCard, PageHeader, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, Toolbar, useTable } from '../ui/forms.jsx';
import { inr, inrCompact, num } from '../ui/format.js';

const SLABS = [0, 5, 12, 18, 28, 40];
const LOW = 5;                                              // at or below this many units an item is flagged as low
const level = (i) => (Number(i.stock) <= 0 ? 'out' : Number(i.stock) <= LOW ? 'low' : 'ok');

/** What you sell or stock: rate, GST slab and quantity on hand, with the stock that needs attention called out. */
export default function Items() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('GET', '/items').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const table = useTable(rows ?? [], { filter: level, match: (i, q) => [i.name, i.hsn].some((x) => String(x ?? '').toLowerCase().includes(q)) });
  const counts = useMemo(() => { const c = { all: 0, ok: 0, low: 0, out: 0 }; for (const i of rows ?? []) { c.all++; c[level(i)]++; } return c; }, [rows]);
  if (!rows) return <><PageHeader title="Items" subtitle="Products and services" /><Skeleton rows={5} height={44} /></>;

  const stockValue = rows.reduce((s, i) => s + Math.max(0, Number(i.stock)) * Number(i.rate), 0);
  const avgGst = rows.length ? rows.reduce((s, i) => s + Number(i.gstPct), 0) / rows.length : 0;

  return (
    <>
      <PageHeader title="Items" subtitle="What you sell or stock, and the stock that needs attention">
        <button className="primary" onClick={() => { setFlash(''); setOpen(true); }}><Icon name="plus" size={15} /> Add item</button>
      </PageHeader>
      <div className="kpi-grid">
        <KpiCard label="Items" value={num(rows.length)} icon="package" tone="brand" hint={`${counts.ok} well stocked`} />
        <KpiCard label="Stock value (at sale rate)" value={inrCompact(stockValue)} icon="wallet" tone="green" hint="Quantity on hand times rate" />
        <KpiCard label="Low or out of stock" value={num(counts.low + counts.out)} icon="alert" tone={counts.low + counts.out ? 'amber' : 'green'} hint={`${counts.out} out of stock, ${counts.low} at ${LOW} or fewer`} onClick={counts.low + counts.out ? () => table.setActive(counts.out ? 'out' : 'low') : undefined} />
        <KpiCard label="Average GST rate" value={`${avgGst.toFixed(1)}%`} icon="percent" tone="teal" hint="Across all items" />
      </div>
      {flash && <Notice tone="ok">{flash}</Notice>}
      {err && <Notice>{err}</Notice>}
      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search name or HSN" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All', count: counts.all }, { value: 'low', label: 'Low stock', count: counts.low }, { value: 'out', label: 'Out of stock', count: counts.out }]} />
      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon="package" title="No items yet" text="Add what you sell: its rate, GST slab and opening stock."><button className="primary" onClick={() => setOpen(true)}>Add an item</button></EmptyState></div>
      ) : (
        <>
          <table>
            <thead><tr><th>Item</th><th className="num">Rate</th><th className="num">GST</th><th className="num">In stock</th><th className="num">Stock value</th><th>Level</th></tr></thead>
            <tbody>
              {table.visible.map((i) => (
                <tr key={i.id}>
                  <td><Cell main={i.name} sub={i.hsn ? `HSN ${i.hsn}` : undefined} /></td>
                  <td className="num">{inr(i.rate)}</td><td className="num">{Number(i.gstPct)}%</td>
                  <td className="num"><b>{num(i.stock)}</b> <span className="muted">{i.unit}</span></td>
                  <td className="num">{inr(Math.max(0, Number(i.stock)) * Number(i.rate))}</td>
                  <td>{{ ok: <Badge tone="ok">Good</Badge>, low: <Badge tone="warn">Low</Badge>, out: <Badge tone="bad">Out</Badge> }[level(i)]}</td>
                </tr>))}
              {!table.visible.length && <tr><td colSpan={6} className="table-empty">Nothing matches your search or filter.</td></tr>}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}
      {open && <NewItem onClose={() => setOpen(false)} onDone={(i) => { setOpen(false); setFlash(`${i.name} added.`); load(); }} />}
    </>
  );
}

function NewItem({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', hsn: '', rate: '', gstPct: 18, stock: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { onDone(await api('POST', '/items', { name: f.name, hsn: f.hsn || undefined, rate: Number(f.rate), gstPct: Number(f.gstPct), stock: Number(f.stock || 0) })); } catch (e2) { setErr(e2.message); setBusy(false); }
  }
  return (
    <Drawer open title="Add an item" subtitle="A product or service you sell" onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="item-form" disabled={busy}>{busy ? 'Saving…' : 'Add item'}</button></>}>
      <form id="item-form" onSubmit={submit} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-grid">
          <Field label="Name" className="span2"><input value={f.name} onChange={set('name')} required /></Field>
          <Field label="HSN / SAC" hint="Needed on GST returns"><input value={f.hsn} onChange={set('hsn')} /></Field>
          <Field label="GST rate"><select value={f.gstPct} onChange={set('gstPct')}>{SLABS.map((s) => <option key={s} value={s}>{s}%</option>)}</select></Field>
          <Field label="Rate (₹, excluding GST)"><input type="number" step="0.01" min="0" value={f.rate} onChange={set('rate')} required /></Field>
          <Field label="Opening stock" hint="Units on hand today"><input type="number" min="0" value={f.stock} onChange={set('stock')} /></Field>
        </div>
      </form>
    </Drawer>
  );
}
