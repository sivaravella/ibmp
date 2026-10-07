import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Drawer, Field, Notice } from '../ui/forms.jsx';
import InvoiceDocument from './InvoiceDocument.jsx';

export const COPIES = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];

/** The A4 page shown on a grey desk, scaled down to the space it has so the whole invoice is always visible. */
export function ScaledPage({ children, pageWidth = 794 }) {
  const desk = useRef(null), page = useRef(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(1123);
  useEffect(() => {
    const fit = () => { const w = desk.current?.clientWidth ?? pageWidth; setScale(Math.min(1.2, Math.max(0.3, (w - 36) / pageWidth))); };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(fit), ph = new ResizeObserver(() => page.current && setHeight(page.current.offsetHeight));
    ro.observe(desk.current); ph.observe(page.current);
    return () => { ro.disconnect(); ph.disconnect(); };
  }, []);
  return (
    <div className="inv-desk" ref={desk}>
      <div style={{ height: height * scale, width: pageWidth * scale, margin: '0 auto' }}>
        <div className="inv-scale" ref={page} style={{ transform: `scale(${scale})`, width: pageWidth }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Print the invoice as one copy or all three (original for the recipient, duplicate for the transporter, triplicate for the
 * supplier). The copies are drawn on <body>, outside the app, so the browser prints only them, one per page; "Save as PDF" in the
 * print dialog gives the PDF.
 */
export function usePrintInvoice(doc) {
  const [labels, setLabels] = useState(null);
  useEffect(() => {
    if (!labels) return undefined;
    const done = () => { document.body.classList.remove('print-invoice'); setLabels(null); };
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => { document.body.classList.add('print-invoice'); window.print(); }, 500);     // let the QR codes finish drawing
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); };
  }, [labels]);
  let root = typeof document !== 'undefined' ? document.getElementById('print-root') : null;
  if (!root && typeof document !== 'undefined') { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  const portal = labels && doc ? createPortal(<>{labels.map((c) => <InvoiceDocument key={c} doc={doc} copy={c} />)}</>, root) : null;
  return { print: (which) => setLabels(which === 'all' ? COPIES : [which ?? COPIES[0]]), portal };
}

const FIELDS = ['legalName', 'tradeName', 'addr1', 'addr2', 'loc', 'pin', 'phone', 'email', 'bankName', 'bankAccount', 'bankIfsc', 'bankBranch', 'upiId', 'signatory', 'invoiceTerms', 'invoiceFooter'];

/** Everything about the business that is printed on an invoice: address, bank and UPI details, terms, signatory and the usual credit period. */
export function InvoiceSettings({ profile, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ ...Object.fromEntries(FIELDS.map((k) => [k, profile?.[k] ?? ''])), paymentDays: String(profile?.paymentDays ?? 0) }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { onSaved(await api('PUT', '/company/profile', { ...f, paymentDays: Number(f.paymentDays || 0) })); } catch (e2) { setErr(e2.issues?.map((i) => i.message).join(' ') || e2.message); setBusy(false); }
  }
  return (
    <Drawer open wide title="Invoice settings" subtitle="What is printed on every invoice. The GSTIN and state come from your registration." onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" form="inv-settings" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></>}>
      <form id="inv-settings" onSubmit={save} style={{ display: 'contents' }}>
        <Notice>{err}</Notice>
        <div className="form-section">Business</div>
        <div className="form-grid">
          <Field label="Legal name" hint="As on your GST registration"><input value={f.legalName} onChange={set('legalName')} /></Field>
          <Field label="Trade name"><input value={f.tradeName} onChange={set('tradeName')} /></Field>
          <Field label="Address line 1" className="span2"><input value={f.addr1} onChange={set('addr1')} /></Field>
          <Field label="Address line 2" className="span2"><input value={f.addr2} onChange={set('addr2')} /></Field>
          <Field label="Town / city"><input value={f.loc} onChange={set('loc')} /></Field>
          <Field label="PIN code"><input value={f.pin} onChange={set('pin')} maxLength={6} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <div className="form-section">Getting paid</div>
        <div className="form-grid">
          <Field label="Bank"><input value={f.bankName} onChange={set('bankName')} /></Field>
          <Field label="Branch"><input value={f.bankBranch} onChange={set('bankBranch')} /></Field>
          <Field label="Account number"><input value={f.bankAccount} onChange={set('bankAccount')} inputMode="numeric" /></Field>
          <Field label="IFSC"><input value={f.bankIfsc} onChange={set('bankIfsc')} maxLength={11} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="UPI ID" hint="Adds a pay-by-UPI QR code to unpaid invoices"><input value={f.upiId} onChange={set('upiId')} placeholder="name@bank" /></Field>
          <Field label="Usual credit period (days)" hint="Sets the due date on new invoices"><input type="number" min="0" max="365" value={f.paymentDays} onChange={set('paymentDays')} /></Field>
        </div>
        <div className="form-section">Terms and sign-off</div>
        <div className="form-grid">
          <Field label="Terms and conditions" className="span2"><textarea rows={4} value={f.invoiceTerms} onChange={set('invoiceTerms')} placeholder="For example: Goods once sold will not be taken back. Interest at 18% a year on overdue payments." style={{ width: '100%', padding: 10, border: '1px solid #d5d9e8', borderRadius: 10, font: 'inherit' }} /></Field>
          <Field label="Authorised signatory"><input value={f.signatory} onChange={set('signatory')} /></Field>
          <Field label="Footer line"><input value={f.invoiceFooter} onChange={set('invoiceFooter')} placeholder="Thank you for your business." /></Field>
        </div>
      </form>
    </Drawer>
  );
}
