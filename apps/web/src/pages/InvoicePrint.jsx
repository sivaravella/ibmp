import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import InvoiceDocument from './InvoiceDocument.jsx';

/**
 * Only the invoice, for the server's headless browser to turn into a PDF (see apps/api/src/pdf.js). It uses the same print mode as the
 * Print button: the app is hidden and the document is drawn in #print-root. window.__invoiceReady tells the browser when it is drawn.
 */
export default function InvoicePrint({ params }) {
  const [doc, setDoc] = useState(null);
  useEffect(() => { api('GET', `/invoices/${params?.id}/document`).then(setDoc).catch(() => { window.__invoiceFailed = true; }); }, [params?.id]);
  useEffect(() => {
    if (!doc) return undefined;
    document.body.classList.add('print-invoice');
    let stop = false, tries = 0;
    const settled = () => { const imgs = [...document.querySelectorAll('#print-root img')]; return imgs.every((i) => i.complete); };
    const wait = () => { if (stop) return; if ((settled() && tries > 6) || tries > 40) { window.__invoiceReady = true; return; } tries += 1; setTimeout(wait, 150); };       // the QR codes are drawn a moment after the page
    wait();
    return () => { stop = true; document.body.classList.remove('print-invoice'); };
  }, [doc]);
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  return doc ? createPortal(<InvoiceDocument doc={doc} copy="Original for Recipient" />, root) : <p style={{ padding: 20 }}>Preparing the invoice…</p>;
}
