import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, EmptyState, KpiCard, PageHeader, Segmented, Skeleton } from '../ui/kit.jsx';
import { Cell, Drawer, Field, Notice, Pager, Toolbar, useTable } from '../ui/forms.jsx';
import { num } from '../ui/format.js';

const hasAddress = (p) => !!(p.addr1 && p.loc && p.pin);
const panOf = (p) => p.pan || (p.gstin ? p.gstin.slice(2, 12) : null);

/** Customers and vendors: who you trade with, what is missing for e-invoicing and TDS, and drawers to add or complete a party. */
export default function Parties() {
  const [rows, setRows] = useState(null);
  const [drawer, setDrawer] = useState(null);       // { type: 'new' } | { type: 'edit', party }
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('GET', '/parties').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const table = useTable(rows ?? [], {
    filter: (p) => p.type,
    match: (p, q) => [p.name, p.gstin, p.pan, p.phone, p.email].some((x) => String(x ?? '').toLowerCase().includes(q)),
  });
  const counts = useMemo(() => ({ all: rows?.length ?? 0, customer: (rows ?? []).filter((p) => p.type === 'customer').length, vendor: (rows ?? []).filter((p) => p.type === 'vendor').length }), [rows]);

  if (!rows) return <><PageHeader title="Parties" subtitle="Customers and vendors" /><Skeleton rows={5} height={44} /></>;
  const registered = rows.filter((p) => p.gstin).length;
  const noAddress = rows.filter((p) => !hasAddress(p)).length;
  const vendorsNoPan = rows.filter((p) => p.type === 'vendor' && !panOf(p)).length;
  const done = (msg) => { setDrawer(null); setFlash(msg); load(); };

  return (
    <>
      <PageHeader title="Parties" subtitle="Everyone you sell to or buy from, and what is still missing for e-invoices and TDS">
        <button className="primary" onClick={() => { setFlash(''); setDrawer({ type: 'new' }); }}><Icon name="plus" size={15} /> Add party</button>
      </PageHeader>

      <div className="kpi-grid">
        <KpiCard label="Customers" value={num(counts.customer)} icon="users" tone="brand" hint={`${num(counts.vendor)} vendors`} />
        <KpiCard label="GST registered" value={rows.length ? `${Math.round((registered / rows.length) * 100)}%` : '—'} icon="shield" tone="green" hint={`${registered} of ${rows.length} have a GSTIN`} />
        <KpiCard label="Address missing" value={num(noAddress)} icon="alert" tone={noAddress ? 'amber' : 'green'} hint="Needed on e-invoices and e-way bills" />
        <KpiCard label="Vendors without a PAN" value={num(vendorsNoPan)} icon="receipt" tone={vendorsNoPan ? 'rose' : 'green'} hint="TDS is deducted at 20% without one" />
      </div>

      {flash && <Notice tone="ok">{flash}</Notice>}
      {err && <Notice>{err}</Notice>}

      <Toolbar search={table.q} onSearch={table.setQ} placeholder="Search name, GSTIN, PAN, phone" active={table.active} onFilter={table.setActive}
        filters={[{ value: 'all', label: 'All', count: counts.all }, { value: 'customer', label: 'Customers', count: counts.customer }, { value: 'vendor', label: 'Vendors', count: counts.vendor }]} />

      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon="users" title="No customers or vendors yet" text="Add the people and businesses you invoice or buy from. Pick a GSTIN and we can fetch their details."><button className="primary" onClick={() => setDrawer({ type: 'new' })}>Add a party</button></EmptyState></div>
      ) : (
        <>
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>State</th><th>PAN</th><th>Contact</th><th>Address</th><th /></tr></thead>
            <tbody>
              {table.visible.map((p) => (
                <tr key={p.id}>
                  <td><Cell main={p.name} sub={p.gstin || 'Unregistered'} /></td>
                  <td><Badge tone={p.type === 'vendor' ? 'info' : 'brand'}>{p.type === 'vendor' ? 'Vendor' : 'Customer'}</Badge></td>
                  <td>{p.stateCode}</td>
                  <td>{p.type === 'vendor' ? (panOf(p) ?? <Badge tone="warn">none</Badge>) : <span className="dim">—</span>}</td>
                  <td><Cell main={p.phone || p.email || '—'} sub={p.phone && p.email ? p.email : undefined} /></td>
                  <td>{hasAddress(p) ? <Cell main={p.loc} sub={p.pin} /> : <Badge tone="warn">Incomplete</Badge>}</td>
                  <td className="actions"><button className="row-btn" onClick={() => { setFlash(''); setDrawer({ type: 'edit', party: p }); }}>Edit</button></td>
                </tr>))}
              {!table.visible.length && <tr><td colSpan={7} className="table-empty">Nothing matches your search or filter.</td></tr>}
            </tbody>
          </table>
          <Pager page={table.page} pages={table.pages} total={table.total} size={table.size} onPage={table.setPage} />
        </>
      )}

      {drawer?.type === 'new' && <NewParty onClose={() => setDrawer(null)} onDone={(p) => done(`${p.name} added.`)} />}
      {drawer?.type === 'edit' && <EditParty party={drawer.party} onClose={() => setDrawer(null)} onDone={() => done(`${drawer.party.name} updated.`)} />}
    </>
  );
}

export function NewParty({ onClose, onDone }) {
  const [f, setF] = useState({ type: 'customer', name: '', gstin: '', stateCode: '', pan: '', phone: '', email: '' });
  const [found, setFound] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function fetchGstin() {
    setErr(''); setFound(null);
    try {
      const g = await api('GET', `/filing/gstin/${f.gstin.trim()}`);
      setFound(g);
      setF({ ...f, gstin: g.gstin, name: f.name || g.tradeName || g.legalName });
    } catch (e) { setErr(e.message); }
  }
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      onDone(await api('POST', '/parties', {
        type: f.type, name: f.name,
        ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : { stateCode: f.stateCode }),
        ...(f.type === 'vendor' && f.pan ? { pan: f.pan.toUpperCase() } : {}),
        ...(f.phone ? { phone: f.phone } : {}), ...(f.email ? { email: f.email } : {}),
      }));
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <Drawer open title="Add a party" subtitle="A customer you invoice or a vendor you buy from" onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="party-form" disabled={busy}>{busy ? 'Saving…' : 'Add party'}</button></>}>
      <form id="party-form" onSubmit={submit} style={{ display: 'contents' }}>
        <Segmented wide label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={[['customer', 'Customer'], ['vendor', 'Vendor']]} />
        <Notice>{err}</Notice>
        <Field label="GSTIN" hint="Leave empty for an unregistered party and give the state instead">
          <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
            <input value={f.gstin} onChange={(e) => { setF({ ...f, gstin: e.target.value }); setFound(null); }} placeholder="29ABCDE1234F1Z5" maxLength={15} style={{ textTransform: 'uppercase' }} />
            {f.gstin.length === 15 && <button type="button" onClick={fetchGstin}>Fetch details</button>}
          </div>
        </Field>
        {found && <Notice tone={found.status === 'Active' ? 'info' : 'warn'}>{found.simulated && <b>SIMULATED, not real taxpayer data. </b>}{found.legalName} · {found.status} · state {found.stateCode}{found.status !== 'Active' && ' · this GSTIN is not active'}</Notice>}
        <div className="form-grid">
          <Field label="Name" className="span2"><input value={f.name} onChange={set('name')} required /></Field>
          {!f.gstin && <Field label="State code" hint="Two digits, for example 29 for Karnataka"><input value={f.stateCode} onChange={set('stateCode')} maxLength={2} required /></Field>}
          {f.type === 'vendor' && <Field label="PAN" hint="Used for TDS; taken from the GSTIN if you leave it empty"><input value={f.pan} onChange={set('pan')} maxLength={10} style={{ textTransform: 'uppercase' }} /></Field>}
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
      </form>
    </Drawer>
  );
}

/** Postal and contact details (required for e-invoices and e-way bills) and, for a vendor, the PAN used for TDS. */
function EditParty({ party, onClose, onDone }) {
  const [f, setF] = useState({ addr1: party.addr1 ?? '', addr2: party.addr2 ?? '', loc: party.loc ?? '', pin: party.pin ?? '', phone: party.phone ?? '', email: party.email ?? '' });
  const [pan, setPan] = useState(party.pan ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api('PUT', `/parties/${party.id}`, f);
      if (party.type === 'vendor' && pan !== (party.pan ?? '')) await api('PUT', `/parties/${party.id}/pan`, { pan: pan.trim() ? pan.trim().toUpperCase() : null });
      onDone();
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }
  return (
    <Drawer open title={party.name} subtitle={`${party.type === 'vendor' ? 'Vendor' : 'Customer'} · ${party.gstin || 'unregistered'}`} onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="edit-party" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="edit-party" onSubmit={save} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-section">Address</div>
        <div className="form-grid">
          <Field label="Address line 1" className="span2"><input value={f.addr1} onChange={set('addr1')} /></Field>
          <Field label="Address line 2" className="span2"><input value={f.addr2} onChange={set('addr2')} /></Field>
          <Field label="Town / city"><input value={f.loc} onChange={set('loc')} /></Field>
          <Field label="PIN code"><input value={f.pin} onChange={set('pin')} maxLength={6} /></Field>
        </div>
        <div className="form-section">Contact</div>
        <div className="form-grid">
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        {party.type === 'vendor' && <>
          <div className="form-section">Tax</div>
          <Field label="PAN" hint={party.gstin ? `Falls back to ${party.gstin.slice(2, 12)} from the GSTIN` : 'Without a PAN, TDS is deducted at the higher rate'}><input value={pan} onChange={(e) => setPan(e.target.value)} maxLength={10} style={{ textTransform: 'uppercase' }} /></Field>
        </>}
      </form>
    </Drawer>
  );
}
