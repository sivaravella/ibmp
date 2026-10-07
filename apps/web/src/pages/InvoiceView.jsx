import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Badge, PageHeader, Panel, Skeleton } from '../ui/kit.jsx';
import { Drawer, Notice, StatusBadge } from '../ui/forms.jsx';
import { fmtDate, inr } from '../ui/format.js';
import InvoiceDocument from './InvoiceDocument.jsx';
import PayForm from './PayForm.jsx';
import ReturnForm from './ReturnForm.jsx';
import { COPIES, ScaledPage, usePrintInvoice } from './invoice-parts.jsx';

const today = () => new Date().toISOString().slice(0, 10);

/** One invoice: the document itself with the actions around it (print, record a receipt, return, duplicate, e-invoice). */
export default function InvoiceView({ go, params }) {
  const [doc, setDoc] = useState(null);
  const [drawer, setDrawer] = useState(null);       // 'pay' | 'return'
  const [flash, setFlash] = useState(params?.created ? 'Invoice created.' : '');
  const [copy, setCopy] = useState(COPIES[0]);
  const [err, setErr] = useState('');
  const load = () => api('GET', `/invoices/${params.id}/document`).then(setDoc).catch((e) => setErr(e.message));
  useEffect(() => { setDoc(null); load(); }, [params?.id]);
  const printing = usePrintInvoice(doc);

  if (err) return <><PageHeader title="Invoice" /><Notice>{err}</Notice><button onClick={() => go('invoices')}>‹ All invoices</button></>;
  if (!doc) return <><PageHeader title="Invoice" /><Skeleton rows={6} height={44} /></>;

  const inv = doc.invoice;
  const balance = inv.balance;
  const overdue = inv.dueDate && String(inv.dueDate).slice(0, 10) < today() && balance > 0.005 && inv.status !== 'returned';
  const einv = doc.einvoice;
  const done = (msg) => { setDrawer(null); setFlash(msg); load(); };
  const forModals = { id: inv.id, number: inv.number, date: String(inv.date).slice(0, 10), total: inv.total, paid: inv.paid, returned: inv.returned, tds: 0 };

  return (
    <>
      <PageHeader title={inv.number} subtitle={`${doc.party.name} · ${fmtDate(inv.date)}`}>
        <button onClick={() => go('invoices')}>‹ All invoices</button>
        <StatusBadge status={inv.status} />{overdue && <Badge tone="bad">Overdue</Badge>}
        {balance > 0.005 && inv.status !== 'returned' && <button className="primary" onClick={() => { setFlash(''); setDrawer('pay'); }}><Icon name="wallet" size={14} /> Record receipt</button>}
        <button onClick={() => printing.print(copy)}><Icon name="file" size={14} /> Print / PDF</button>
      </PageHeader>
      {flash && <Notice tone="ok">{flash}</Notice>}

      <div className="inv-view">
        <div style={{ minWidth: 0 }}><ScaledPage><InvoiceDocument doc={doc} copy={copy} /></ScaledPage></div>
        <div className="inv-view-side">
          <Panel title="Payment">
            <div className="mini-stats" style={{ marginTop: 0 }}>
              <div><span>Total</span><b>{inr(inv.total)}</b></div><div><span>Received</span><b>{inr(inv.paid)}</b></div>
              <div><span>Credited</span><b>{inr(inv.returned)}</b></div><div><span>Balance</span><b style={{ color: balance > 0.005 ? 'var(--rose)' : 'var(--green)' }}>{inr(balance)}</b></div>
            </div>
            <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>{inv.dueDate ? <>Due {fmtDate(inv.dueDate)}{overdue && <span className="overdue-tag"> · overdue</span>}</> : 'Payable on receipt'}</p>
          </Panel>
          <Panel title="Print">
            <label className="field"><span className="field-label">Copy shown</span>
              <select value={copy} onChange={(e) => setCopy(e.target.value)}>{COPIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            <div className="row" style={{ marginTop: 10, marginBottom: 0 }}>
              <button onClick={() => printing.print(copy)}>Print this copy</button>
              <button onClick={() => printing.print('all')}>All three copies</button>
            </div>
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Choose “Save as PDF” in the print window for a PDF file.</p>
          </Panel>
          <Panel title="E-invoice">
            {einv?.status === 'generated' ? <p style={{ margin: 0 }}><Badge tone="ok">IRN generated</Badge><br /><span className="muted" style={{ fontSize: 12 }}>It is printed on the invoice with its QR code.</span></p>
              : <p className="muted" style={{ margin: '0 0 10px', fontSize: 12.5 }}>{einv ? 'An e-invoice has been prepared but not generated.' : 'No e-invoice yet. It is only required if your turnover is above the limit.'}</p>}
            <button onClick={() => go('edocs')}>Open e-invoice</button>
          </Panel>
          <Panel title="More">
            <div className="quick" style={{ gridTemplateColumns: '1fr' }}>
              <button onClick={() => go('invoice-new', { from: inv.id })}><Icon name="plus" size={16} /> Duplicate as a new invoice</button>
              {inv.status !== 'returned' && <button onClick={() => { setFlash(''); setDrawer('return'); }}><Icon name="undo" size={16} /> Return goods or adjust</button>}
              <button onClick={() => go('invoice-new')}><Icon name="file" size={16} /> New invoice</button>
            </div>
          </Panel>
        </div>
      </div>

      <Drawer open={drawer === 'pay'} title={`Record a receipt: ${inv.number}`} subtitle={doc.party.name} onClose={() => setDrawer(null)}>
        {drawer === 'pay' && <PayForm base="invoices" doc={forModals} onDone={() => done(`Receipt recorded against ${inv.number}.`)} onClose={() => setDrawer(null)} />}
      </Drawer>
      <Drawer open={drawer === 'return'} wide title={`Sales return (credit note): ${inv.number}`} subtitle={doc.party.name} onClose={() => setDrawer(null)}>
        {drawer === 'return' && <ReturnForm base="invoices" doc={forModals} onDone={(n) => done(`Credit note ${n?.number ?? ''} created.`)} onClose={() => setDrawer(null)} />}
      </Drawer>
      {printing.portal}
    </>
  );
}
