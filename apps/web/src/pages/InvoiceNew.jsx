import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { PageHeader, Panel, Segmented, Skeleton } from '../ui/kit.jsx';
import { Field, Notice } from '../ui/forms.jsx';
import { inr } from '../ui/format.js';
import { addDaysIso, computeDraft, taxSummary } from '../ui/invoice-math.js';
import InvoiceDocument from './InvoiceDocument.jsx';
import { InvoiceSettings, ScaledPage } from './invoice-parts.jsx';
import { NewParty } from './Parties.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const blankLine = () => ({ itemId: '', description: '', qty: '1', rate: '', discountPct: '' });
const N = (v) => Number(v) || 0;

/**
 * Create an invoice on its own screen: the form on the left and the invoice, exactly as it will print, on the right, updating as you type.
 * The totals come from the same maths the server uses (a test keeps them identical).
 */
export default function InvoiceNew({ go, params }) {
  const [profile, setProfile] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [states, setStates] = useState([]);
  const [f, setF] = useState({ partyId: '', date: today(), dueDate: '', reference: '', notes: '', shipDiff: false, shipTo: '', pos: '', dispatchedThrough: '', destination: '', paymentTerms: '', otherRefs: '', discountPct: '' });
  const [dueTouched, setDueTouched] = useState(false);
  const [lines, setLines] = useState([blankLine()]);
  const [charges, setCharges] = useState([]);          // additional charges: [{ label, amount }]
  const [pane, setPane] = useState('form');
  const [settings, setSettings] = useState(false);
  const [newParty, setNewParty] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const loadParties = () => api('GET', '/parties?type=customer').then(setCustomers);
  useEffect(() => {
    api('GET', '/company/profile').then(setProfile);
    loadParties(); api('GET', '/items').then(setItems); api('GET', '/meta/states').then(setStates);
  }, []);

  // "Duplicate" opens this screen with the lines and details of an earlier invoice.
  useEffect(() => {
    if (!params?.from) return;
    api('GET', `/invoices/${params.from}/document`).then((d) => {
      const i = d.invoice;
      setF((x) => ({ ...x, partyId: String(i.partyId), reference: i.reference ?? '', notes: i.notes ?? '', dispatchedThrough: i.dispatchedThrough ?? '', destination: i.destination ?? '', paymentTerms: i.paymentTerms ?? '', otherRefs: i.otherRefs ?? '', discountPct: Number(i.discountPct) > 0 ? String(Number(i.discountPct)) : '', shipDiff: !!i.shipTo, shipTo: i.shipTo ?? '', pos: i.placeOfSupply !== d.party.stateCode ? i.placeOfSupply : '' }));
      setCharges(i.lines.filter((l) => l.itemId == null).map((l) => ({ label: l.description, amount: String(Number(l.taxable)), hsn: l.hsn && l.hsn !== '9965' ? l.hsn : '' })));
      setLines(i.lines.filter((l) => l.itemId != null).map((l) => ({ itemId: String(l.itemId), description: l.description, qty: String(Number(l.qty)), rate: String(Number(l.rate)), discountPct: Number(l.discountPct) ? String(Number(l.discountPct)) : '' })));
    }).catch((e) => setErr(e.message));
  }, [params?.from]);

  // The due date follows the invoice date and the usual credit period until it is set by hand.
  useEffect(() => {
    if (dueTouched || !profile) return;
    setF((x) => ({ ...x, dueDate: profile.paymentDays > 0 ? addDaysIso(x.date, profile.paymentDays) : '' }));
  }, [f.date, profile?.paymentDays, dueTouched]);

  const stateName = (c) => states.find((s) => s.code === c)?.name ?? '';
  const party = customers.find((c) => String(c.id) === String(f.partyId));
  const posCode = f.pos || party?.stateCode || profile?.stateCode || '';
  const itemOf = (id) => items.find((x) => String(x.id) === String(id));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = (i, id) => { const it = itemOf(id); setLine(i, { itemId: id, description: it?.name ?? '', rate: it ? String(Number(it.rate)) : '' }); };

  const calcInput = lines.map((l) => { const it = itemOf(l.itemId); return { itemId: l.itemId, description: l.description || it?.name || '', hsn: it?.hsn ?? '', unit: it?.unit ?? 'Nos', qty: N(l.qty), rate: l.rate === '' ? N(it?.rate) : N(l.rate), gstPct: N(it?.gstPct), discountPct: N(l.discountPct), stock: it ? N(it.stock) : null }; });
  // Additional charges follow the highest GST rate on the invoice; they are never discounted.
  const chargeInput = charges.filter((c) => N(c.amount) > 0).map((c) => ({ charge: true, itemId: '', description: c.label || 'Additional charge', hsn: (c.hsn && c.hsn.length >= 4) ? c.hsn : '9965', unit: 'OTH', qty: 1, rate: N(c.amount), gstPct: 0, stock: null }));
  const topRate = Math.max(0, ...calcInput.map((l) => l.gstPct));
  const calc = useMemo(() => computeDraft([...calcInput, ...chargeInput], profile?.stateCode, posCode, N(f.discountPct)), [JSON.stringify(calcInput), JSON.stringify(chargeInput), profile?.stateCode, posCode, f.discountPct]);

  const doc = useMemo(() => profile && ({
    invoice: {
      number: null, date: f.date, dueDate: f.dueDate || null, reference: f.reference, notes: f.notes, dispatchedThrough: f.dispatchedThrough, destination: f.destination, paymentTerms: f.paymentTerms, otherRefs: f.otherRefs, discountPct: N(f.discountPct), shipTo: f.shipDiff ? f.shipTo : '',
      placeOfSupply: posCode, placeOfSupplyName: stateName(posCode), intra: calc.intra, lines: calc.lines,
      taxable: calc.taxable, discount: calc.discount, cgst: calc.cgst, sgst: calc.sgst, igst: calc.igst, total: calc.total, paid: 0, returned: 0, balance: calc.total,
    },
    company: {
      name: profile.legalName || profile.name, tradeName: profile.tradeName, gstin: profile.gstin, pan: profile.pan || (profile.gstin ? profile.gstin.slice(2, 12) : null), stateCode: profile.stateCode, stateName: stateName(profile.stateCode),
      addr1: profile.addr1, addr2: profile.addr2, loc: profile.loc, pin: profile.pin, phone: profile.phone, email: profile.email,
      logo: profile.logo, bankName: profile.bankName, bankAccount: profile.bankAccount, bankIfsc: profile.bankIfsc, bankBranch: profile.bankBranch, upiId: profile.upiId, terms: profile.invoiceTerms, footer: profile.invoiceFooter, signatory: profile.signatory,
    },
    party: party ? { name: party.name, gstin: party.gstin, pan: party.pan, stateCode: party.stateCode, stateName: stateName(party.stateCode), addr1: party.addr1, addr2: party.addr2, loc: party.loc, pin: party.pin, phone: party.phone, email: party.email } : { name: '', stateCode: posCode, stateName: stateName(posCode) },
    taxSummary: taxSummary(calc.lines), einvoice: null, ewaybill: null,
  }), [profile, f, party, calc, posCode, states]);

  const short = calcInput.filter((l) => l.stock !== null && l.qty > l.stock);
  const missing = profile ? [!profile.addr1 && 'address', !profile.loc && 'town', !profile.pin && 'PIN code', !profile.gstin && 'GSTIN'].filter(Boolean) : [];
  const ready = !!f.partyId && lines.every((l) => l.itemId && N(l.qty) > 0);

  function reset(msg) { setF({ partyId: '', date: today(), dueDate: '', reference: '', notes: '', shipDiff: false, shipTo: '', pos: '', dispatchedThrough: '', destination: '', paymentTerms: '', otherRefs: '', discountPct: '' }); setDueTouched(false); setLines([blankLine()]); setCharges([]); setFlash(msg); setPane('form'); window.scrollTo(0, 0); }
  async function save(another) {
    setErr(''); setBusy(true);
    try {
      const inv = await api('POST', '/invoices', {
        partyId: Number(f.partyId), date: f.date, dueDate: f.dueDate || null, reference: f.reference || undefined, notes: f.notes || undefined, dispatchedThrough: f.dispatchedThrough || undefined, destination: f.destination || undefined, paymentTerms: f.paymentTerms || undefined, otherRefs: f.otherRefs || undefined, ...(N(f.discountPct) > 0 ? { discountPct: N(f.discountPct) } : {}), shipTo: f.shipDiff && f.shipTo ? f.shipTo : undefined, placeOfSupply: f.pos || undefined,
        ...(chargeInput.length ? { charges: chargeInput.map((c) => ({ label: c.description, amount: c.rate, ...(c.hsn !== '9965' ? { hsn: c.hsn } : {}) })) } : {}),
        lines: lines.map((l, i) => ({ itemId: Number(l.itemId), qty: N(l.qty), rate: calcInput[i].rate, ...(N(l.discountPct) > 0 ? { discountPct: N(l.discountPct) } : {}), ...(l.description && l.description !== itemOf(l.itemId)?.name ? { description: l.description } : {}) })),
      });
      if (another) { reset(`Invoice ${inv.number} created.`); setBusy(false); } else go('invoice', { id: inv.id, created: true });
    } catch (e) { setErr(e.issues?.map((i) => i.message).join(' ') || e.message); setBusy(false); }
  }

  if (!profile) return <><PageHeader title="New invoice" /><Skeleton rows={6} height={44} /></>;

  return (
    <>
      <PageHeader title="New invoice" subtitle="Fill in the details and check the invoice on the right: this is exactly what the customer will receive">
        <button onClick={() => go('invoices')}>‹ All invoices</button>
        <button onClick={() => setSettings(true)}><Icon name="panel" size={14} /> Invoice settings</button>
      </PageHeader>
      {flash && <Notice tone="ok">{flash}</Notice>}
      {missing.length > 0 && <Notice tone="warn">Your invoice header is missing your {missing.join(', ')}. A GST invoice needs them. <a href="#" onClick={(e) => { e.preventDefault(); setSettings(true); }}>Complete it now</a>.</Notice>}
      <Notice>{err}</Notice>

      <div className="inv-panes"><Segmented label="Show" value={pane} onChange={setPane} options={[['form', 'Details'], ['preview', 'Preview']]} /></div>
      <div className="inv-layout" style={{ marginTop: 8 }}>
        <div className={`inv-side${pane === 'preview' ? ' hide-narrow' : ''}`}>
          <Panel title="Customer and dates" className="mb">
            <div className="form-grid">
              <Field label="Customer" className="span2">
                <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
                  <select value={f.partyId} onChange={set('partyId')} required><option value="">Select a customer…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <button type="button" onClick={() => setNewParty(true)} style={{ whiteSpace: 'nowrap' }}><Icon name="plus" size={14} /> New</button>
                </div>
              </Field>
              {party && <div className="span2 muted" style={{ fontSize: 12.5, marginTop: -6 }}>{party.gstin ? `GSTIN ${party.gstin}` : 'Unregistered buyer'} · {stateName(party.stateCode)} ({party.stateCode}){!(party.addr1 && party.loc) && <span style={{ color: 'var(--amber)' }}> · address incomplete: add it under Parties so it prints</span>}</div>}
              <Field label="Invoice date"><input type="date" value={f.date} onChange={set('date')} required /></Field>
              <Field label="Due date" hint={profile.paymentDays > 0 && !dueTouched ? `${profile.paymentDays} days from the invoice date` : 'Leave empty if payable on receipt'}><input type="date" value={f.dueDate} min={f.date} onChange={(e) => { setDueTouched(true); setF({ ...f, dueDate: e.target.value }); }} /></Field>
              <Field label="Buyer's reference / PO number" className="span2"><input value={f.reference} onChange={set('reference')} maxLength={60} placeholder="Optional" /></Field>
              <Field label="Place of supply" className="span2" hint={calc.intra ? `Within ${stateName(profile.stateCode)}: CGST + SGST` : 'Outside your state: IGST'}>
                <select value={f.pos} onChange={set('pos')}>
                  <option value="">{party ? `Buyer's state: ${stateName(party.stateCode)} (${party.stateCode})` : 'The buyer\'s state'}</option>
                  {states.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
                </select>
              </Field>
            </div>
          </Panel>

          <Panel title="Items" hint="Discounts come off before GST" className="mb">
            <div className="lines">
              {lines.map((l, i) => {
                const c = calc.lines[i], it = itemOf(l.itemId);
                return (
                  <div className="inv-line-card" key={i}>
                    <div className="full"><label>Item</label>
                      <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
                        <select value={l.itemId} onChange={(e) => pickItem(i, e.target.value)} required><option value="">Select an item…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.hsn ? ` · HSN ${x.hsn}` : ''}</option>)}</select>
                        <button type="button" className="icon-btn" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove item"><Icon name="x" size={15} /></button>
                      </div></div>
                    <div className="full"><label>Description on the invoice</label><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder={it?.name ?? 'Defaults to the item name'} /></div>
                    <div className="c2"><label>Quantity{it ? ` (${it.unit})` : ''}</label><input type="number" min="0.001" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} required /></div>
                    <div className="c2"><label>Rate (₹)</label><input type="number" min="0" step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} placeholder={it ? String(Number(it.rate)) : ''} /></div>
                    <div><label>Disc. %</label><input type="number" min="0" max="100" step="0.01" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} /></div>
                    <div><label>GST</label><input value={it ? `${Number(it.gstPct)}%` : '—'} readOnly tabIndex={-1} /></div>
                    <div className="full tot"><span>{it && N(l.qty) > N(it.stock) ? <span style={{ color: 'var(--amber)', fontWeight: 600 }}>Only {N(it.stock)} in stock</span> : it ? `In stock: ${N(it.stock)}` : ' '}</span><span>Line total <b>{inr(c.taxable + c.cgst + c.sgst + c.igst)}</b></span></div>
                  </div>
                );
              })}
            </div>
            {charges.length > 0 && <div className="charge-rows">
              <div className="form-section" style={{ margin: '14px 0 6px' }}>Additional charges</div>
              {charges.map((c, i) => (
                <div className="row" key={i} style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
                  <input list="charge-names" value={c.label} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Freight, packing, insurance..." maxLength={60} aria-label="Charge" style={{ flex: 1, minWidth: 0 }} />
                  <input value={c.hsn ?? ''} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, hsn: e.target.value.replace(/\D/g, '').slice(0, 8) } : x)))} placeholder="SAC 9965" inputMode="numeric" style={{ width: 92, flex: "none" }} aria-label="SAC code" title="Service accounting code; 9965 (goods transport) if left empty" />
                  <input type="number" min="0" step="0.01" value={c.amount} onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="Amount (₹)" style={{ width: 112, flex: "none" }} aria-label="Charge amount" />
                  <button type="button" className="icon-btn" onClick={() => setCharges(charges.filter((_, j) => j !== i))} aria-label="Remove charge"><Icon name="x" size={15} /></button>
                </div>))}
              <datalist id="charge-names"><option value="Freight" /><option value="Packing" /><option value="Insurance" /><option value="Loading and unloading" /><option value="Installation" /></datalist>
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>GST on these is charged at {topRate}%, the highest rate on this invoice, as the law treats them as part of the supply. They are not discounted.</p>
            </div>}
            <div className="row" style={{ marginTop: 10, marginBottom: 0, justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <span className="row" style={{ marginBottom: 0 }}><button type="button" onClick={() => setLines([...lines, blankLine()])}><Icon name="plus" size={14} /> Add another item</button><button type="button" onClick={() => setCharges([...charges, { label: '', amount: '' }])}><Icon name="plus" size={14} /> Add a charge</button></span>
              <Field label="Discount on the whole invoice (%)" hint="Shared over every item before GST"><input type="number" min="0" max="100" step="0.01" value={f.discountPct} onChange={set('discountPct')} style={{ width: 150 }} /></Field>
            </div>
          </Panel>

          <Panel title="Payment, delivery and notes" className="mb">
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <Field label="Mode / terms of payment" className="span2"><input value={f.paymentTerms} onChange={set('paymentTerms')} maxLength={120} placeholder="e.g. 30 days by bank transfer" /></Field>
              <Field label="Dispatched through"><input value={f.dispatchedThrough} onChange={set('dispatchedThrough')} maxLength={80} placeholder="Courier or transporter" /></Field>
              <Field label="Destination"><input value={f.destination} onChange={set('destination')} maxLength={80} /></Field>
              <Field label="Other references" className="span2"><input value={f.otherRefs} onChange={set('otherRefs')} maxLength={120} /></Field>
            </div>
            <label className="field" style={{ marginBottom: 10 }}><span className="field-label"><input type="checkbox" checked={f.shipDiff} onChange={set('shipDiff')} /> Deliver to a different address</span></label>
            {f.shipDiff && <Field label="Delivery address"><textarea rows={3} value={f.shipTo} onChange={set('shipTo')} maxLength={300} style={{ width: '100%', padding: 10, border: '1px solid #d5d9e8', borderRadius: 10, font: 'inherit' }} /></Field>}
            <Field label="Notes for the customer" hint="Printed on this invoice only" className="" ><textarea rows={3} value={f.notes} onChange={set('notes')} maxLength={500} style={{ width: '100%', padding: 10, border: '1px solid #d5d9e8', borderRadius: 10, font: 'inherit' }} /></Field>
          </Panel>
        </div>

        <div className={`inv-pane${pane === 'form' ? ' hide-narrow' : ''}`}>
          {doc && <ScaledPage><InvoiceDocument doc={doc} draft /></ScaledPage>}
        </div>
      </div>

      <div className="inv-actions">
        <span className="total">{short.length > 0 && <span style={{ color: 'var(--amber)', marginRight: 14 }}>Not enough stock for {short.length} item(s)</span>}Total <b>{inr(calc.total)}</b></span>
        <button onClick={() => go('invoices')}>Cancel</button>
        <button disabled={!ready || busy} onClick={() => save(true)}>Save and add another</button>
        <button className="primary" disabled={!ready || busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save invoice'}</button>
      </div>

      {settings && <InvoiceSettings profile={profile} onClose={() => setSettings(false)} onSaved={(p) => { setProfile((x) => ({ ...x, ...p })); setSettings(false); api('GET', '/company/profile').then(setProfile); }} />}
      {newParty && <NewParty onClose={() => setNewParty(false)} onDone={(p) => { setNewParty(false); loadParties().then(() => setF((x) => ({ ...x, partyId: String(p.id) }))); }} />}
    </>
  );
}
