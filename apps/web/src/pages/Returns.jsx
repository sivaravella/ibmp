import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, EmptyState, KpiCard, PageHeader, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Notice, Pager, Toolbar, useTable } from '../ui/forms.jsx';
import { fmtDate, inr, inrCompact, num } from '../ui/format.js';

const gst = (n) => Number(n.cgst) + Number(n.sgst) + Number(n.igst);

/** Credit notes (sales returns) and debit notes (purchase returns), with a drawer to read and print any note. */
export default function Returns({ go }) {
  const [rows, setRows] = useState(null);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/returns').then(setRows).catch((e) => setErr(e.message)); }, []);

  const table = useTable(rows ?? [], { filter: (n) => n.kind, match: (n, q) => [n.number, n.docNumber, n.partyName].some((x) => String(x ?? '').toLowerCase().includes(q)) });
  const counts = useMemo(() => ({ all: rows?.length ?? 0, credit: (rows ?? []).filter((n) => n.kind === 'credit').length, debit: (rows ?? []).filter((n) => n.kind === 'debit').length }), [rows]);
  if (!rows) return <><PageHeader title="Returns" subtitle="Credit and debit notes" /><Skeleton rows={4} height={44} /></>;

  const sum = (kind) => rows.filter((n) => n.kind === kind).reduce((s, n) => s + Number(n.total), 0);
  const gstBack = rows.reduce((s, n) => s + (n.kind === 'credit' ? -gst(n) : gst(n)), 0);

  async function view(n) { try { setNote(await api('GET', `/returns/${n.id}`)); } catch (e) { setErr(e.message); } }

  return (
    <>
      <PageHeader title="Returns" subtitle="Goods sent back and price adjustments, as credit notes (sales) and debit notes (purchases)" />
      <div className="kpi-grid">
        <KpiCard label="Credit notes (sales returns)" value={inrCompact(sum('credit'))} icon="undo" tone="rose" hint={`${counts.credit} notes, incl. GST`} />
        <KpiCard label="Debit notes (purchase returns)" value={inrCompact(sum('debit'))} icon="undo" tone="teal" hint={`${counts.debit} notes, incl. GST`} />
        <KpiCard label="Net GST effect" value={inrCompact(Math.abs(gstBack))} icon="percent" tone="amber" hint={gstBack <= 0 ? 'Reduces the GST you owe' : 'Increases the GST you owe'} />
        <KpiCard label="Goods returns" value={num(rows.filter((n) => n.returnType === 'goods').length)} icon="package" tone="brand" hint={`${rows.filter((n) => n.returnType !== 'goods').length} value-only adjustments`} />
      </div>
      {err && <Notice>{err}</Notice>}
      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search note, invoice or party" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All', count: counts.all }, { value: 'credit', label: 'Credit notes', count: counts.credit }, { value: 'debit', label: 'Debit notes', count: counts.debit }]} />
      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon="undo" title="No returns yet" text="Return goods or adjust a price from an invoice or a bill and the note appears here.">
          <div className="row"><button onClick={() => go?.('invoices')}>Go to invoices</button><button onClick={() => go?.('purchases')}>Go to purchases</button></div></EmptyState></div>
      ) : (
        <>
          <table>
            <thead><tr><th>Note</th><th>Type</th><th>Against</th><th>Party</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {table.visible.map((n) => (
                <tr key={n.id}>
                  <td><Cell main={n.number} sub={fmtDate(n.date)} /></td>
                  <td><Badge tone={n.kind === 'credit' ? 'bad' : 'info'}>{n.kind === 'credit' ? 'Credit note' : 'Debit note'}</Badge></td>
                  <td>{n.docNumber}</td><td>{n.partyName}</td>
                  <td className="num">{inr(n.taxable)}</td><td className="num">{inr(gst(n))}</td><td className="num"><b>{inr(n.total)}</b></td>
                  <td className="actions"><button className="row-btn" onClick={() => view(n)}>View</button></td>
                </tr>))}
              {!table.visible.length && <tr><td colSpan={8} className="table-empty">Nothing matches your search or filter.</td></tr>}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}

      <Drawer open={!!note} wide title={note ? `${note.kind === 'credit' ? 'Credit note' : 'Debit note'} ${note.number}` : ''} subtitle={note ? `${note.partyName} · ${fmtDate(note.date)}` : ''} onClose={() => setNote(null)}
        footer={<><span className="total">Total <b>{note ? inr(note.total) : ''}</b></span><button onClick={() => window.print()}>Print</button><button className="primary" onClick={() => setNote(null)}>Close</button></>}>
        {note && <>
          <p className="muted">{note.reason || 'No reason given'} · {note.returnType === 'goods' ? 'Goods returned' : 'Value-only adjustment'} · against {note.docNumber}</p>
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Taxable</th></tr></thead>
            <tbody>{note.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty ?? '—'}</td><td className="num">{inr(l.rate)}</td><td className="num">{Number(l.gstPct)}%</td><td className="num">{inr(l.taxable)}</td></tr>)}</tbody>
          </table>
          <div className="totals">
            <div><span>Taxable value</span><span>{inr(note.taxable)}</span></div>
            {Number(note.cgst) > 0 && <div><span>CGST</span><span>{inr(note.cgst)}</span></div>}{Number(note.sgst) > 0 && <div><span>SGST</span><span>{inr(note.sgst)}</span></div>}{Number(note.igst) > 0 && <div><span>IGST</span><span>{inr(note.igst)}</span></div>}
            <div className="grand"><span>Total</span><span>{inr(note.total)}</span></div>
          </div>
        </>}
      </Drawer>
    </>
  );
}
