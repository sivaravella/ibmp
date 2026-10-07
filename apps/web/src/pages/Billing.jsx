import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

const fmt = (d) => (d ? d.split('-').reverse().join('-') : '—');
const STATUS = {
  trialing: ['Free trial', '#1d4ed8', '#dbeafe'], active: ['Active', '#15803d', '#dcfce7'],
  grace: ['Payment overdue', '#92400e', '#fef3c7'], expired: ['Expired (read-only)', '#b91c1c', '#fee2e2'],
};
const KIND = { new: 'New subscription', renewal: 'Renewal', upgrade: 'Upgrade' };

export default function Billing({ refreshSub, params }) {
  const [tab, setTab] = useState('plans');
  const [sub, setSub] = useState(null);
  const [months, setMonths] = useState(1);
  const [quote, setQuote] = useState(null);       // { plan, ...quote }
  const [pay, setPay] = useState(null);           // checkout result awaiting payment
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = () => api('GET', '/billing/subscription').then(setSub).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const changed = () => { load(); refreshSub?.(); };

  if (!sub) return <p>{err || 'Loading…'}</p>;
  const st = STATUS[sub.status];

  async function choose(plan) {
    setErr(''); setMsg(''); setPay(null);
    try { setQuote({ plan, ...(await api('POST', '/billing/quote', { plan, months })) }); } catch (e) { setQuote(null); setErr(e.message); }
  }

  async function startCheckout() {
    setErr('');
    try {
      const c = await api('POST', '/billing/checkout', { plan: quote.plan, months: quote.months });
      if (c.order.provider === 'razorpay') return openRazorpay(c);
      setPay(c);                               // simulated gateway: shown inline below
    } catch (e) { setErr(e.message); }
  }

  async function openRazorpay(c) {
    try { await loadScript('https://checkout.razorpay.com/v1/checkout.js'); } catch { return setErr('Could not load the payment window. Check your connection and try again.'); }
    const rz = new window.Razorpay({
      key: c.order.keyId, amount: c.order.amount, currency: c.order.currency, orderId: c.order.orderId, name: 'IBMP', description: c.order.description,
      handler: async (r) => {
        try {
          await api('POST', '/billing/verify', { orderId: r.razorpayOrderId, paymentId: r.razorpayPaymentId, signature: r.razorpaySignature });
          done(c.invoice);
        } catch (e) { setErr(`${e.message} If money was debited it will be applied automatically within a few minutes.`); }
      },
      modal: { ondismiss: () => setMsg('Payment window closed. Nothing was charged.') },
    });
    rz.on('payment.failed', (r) => setErr(r.error?.description || 'The payment failed. Please try again.'));
    rz.open();
  }

  async function simulate(outcome) {
    setErr('');
    try {
      const r = await api('POST', '/billing/dev/simulate', { orderId: pay.order.orderId, outcome });
      if (r.ok) done(pay.invoice); else { setPay(null); setErr('The simulated payment failed. Nothing was charged.'); }
    } catch (e) { setErr(e.message); }
  }

  function done() { setQuote(null); setPay(null); setMsg('Payment received. Your subscription is updated, and the tax invoice is under Invoices.'); changed(); }

  return (
    <>
      <h2>Billing</h2>
      <div className="row">
        <button className={tab === 'plans' ? 'primary' : ''} onClick={() => setTab('plans')}>Plans</button>
        <button className={tab === 'invoices' ? 'primary' : ''} onClick={() => setTab('invoices')}>Invoices</button>
      </div>

      {sub.billedViaOtherCompany && <p className="muted">This company is covered by the subscription of <strong>{sub.billingCompany.name}</strong>, so payments and invoices are in that account.</p>}
      <div className="card" style={{ borderLeft: `4px solid ${st[1]}` }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 16 }}>{sub.planName}</strong>
          <span style={{ background: st[2], color: st[1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{st[0]}</span>
          {sub.cancelAtPeriodEnd && sub.status !== 'expired' && <span className="muted">Will not renew</span>}
        </div>
        <div className="muted">
          {sub.status === 'trialing' && `Trial ends ${fmt(sub.trialEnds)} · ${sub.daysLeft} day(s) left`}
          {sub.status === 'active' && `Paid until ${fmt(sub.periodEnd)} · ${sub.daysLeft} day(s) left`}
          {sub.status === 'grace' && `Your plan ended ${fmt(sub.periodEnd)}. Access continues for ${sub.graceDays} days after that; renew now to avoid read-only mode.`}
          {sub.status === 'expired' && `Your ${sub.planCode === 'trial' ? 'trial' : 'plan'} has ended. You can still view and export your data; renew to make changes.`}
        </div>
        {(sub.status === 'active' || sub.status === 'grace') && (
          <div className="row" style={{ marginTop: 8, marginBottom: 0 }}>
            {sub.cancelAtPeriodEnd
              ? <button onClick={async () => { await api('POST', '/billing/resume'); changed(); }}>Keep my plan</button>
              : <button onClick={async () => window.confirm('Stop renewing? You keep access until the end of the paid period.') && (await api('POST', '/billing/cancel'), changed())}>Don't renew</button>}
          </div>
        )}
      </div>
      {msg && <p style={{ color: '#15803d' }}>{msg}</p>}
      {err && <p className="err">{err}</p>}

      {tab === 'plans' ? (
        <>
          <div className="row">
            <label className="muted">Billing period{' '}
              <select value={months} onChange={(e) => { setMonths(Number(e.target.value)); setQuote(null); setPay(null); }}>
                {sub.months.map((m) => <option key={m} value={m}>{m === 12 ? '12 months' : `${m} month${m > 1 ? 's' : ''}`}</option>)}
              </select>
            </label>
            <span className="muted">Prices are per month, excluding {sub.gstPct}% GST.</span>
          </div>
          <div className="tiles">
            {sub.plans.map((p) => {
              const current = p.code === sub.planCode && sub.status !== 'expired';
              return (
                <div className="card" key={p.code} style={{ borderTop: current ? '3px solid #2563eb' : undefined }}>
                  <h3 style={{ margin: 0 }}>{p.name}</h3>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{inr(p.monthly)}<span className="muted" style={{ fontSize: 13, fontWeight: 400 }}> / month</span></div>
                  <ul style={{ paddingLeft: 18, margin: '10px 0' }}>{p.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
                  <button className="primary" disabled={!sub.gateway} onClick={() => choose(p.code)}>
                    {current ? 'Renew' : sub.status === 'active' && p.tier > (sub.plans.find((x) => x.code === sub.planCode)?.tier ?? 0) ? 'Upgrade' : 'Choose'}
                  </button>
                </div>
              );
            })}
          </div>
          {!sub.gateway && <p className="err">Online payments are not configured on this server.</p>}

          {quote && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>{KIND[quote.kind]}: {sub.plans.find((p) => p.code === quote.plan).name}, {quote.months} month(s)</h3>
              <p className="muted">Covers {fmt(quote.periodStart)} to {fmt(quote.periodEnd)}</p>
              <table style={{ maxWidth: 420 }}><tbody>
                <tr><td>Plan charge</td><td>{inr(quote.base)}</td></tr>
                {quote.credit > 0 && <tr><td>Credit for unused time on your current plan</td><td>− {inr(quote.credit)}</td></tr>}
                <tr><td>Taxable value</td><td>{inr(quote.taxable)}</td></tr>
                {quote.igst > 0 ? <tr><td>IGST @ {quote.gstPct}%</td><td>{inr(quote.igst)}</td></tr>
                  : <><tr><td>CGST @ {quote.gstPct / 2}%</td><td>{inr(quote.cgst)}</td></tr><tr><td>SGST @ {quote.gstPct / 2}%</td><td>{inr(quote.sgst)}</td></tr></>}
                <tr><td><strong>Total</strong></td><td><strong>{inr(quote.total)}</strong></td></tr>
              </tbody></table>
              {!pay && <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={startCheckout}>Pay {inr(quote.total)}</button><button onClick={() => setQuote(null)}>Cancel</button></div>}
              {pay && (
                <div className="card" style={{ background: '#f8fafc', marginTop: 10 }}>
                  <strong>Simulated payment gateway</strong>
                  <p className="muted">Development mode: no money moves. Order {pay.order.orderId}, amount {inr(pay.order.amount / 100)}.</p>
                  <div className="row" style={{ marginBottom: 0 }}>
                    <button className="primary" onClick={() => simulate('success')}>Pay successfully</button>
                    <button onClick={() => simulate('failure')}>Make the payment fail</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : <Invoices focus={params?.invoice} />}
    </>
  );
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.body.appendChild(s);
  });
}

const BADGE = { paid: ['Paid', '#15803d', '#dcfce7'], pending: ['Awaiting payment', '#92400e', '#fef3c7'], void: ['Abandoned', '#475569', '#f1f5f9'] };

function Invoices() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => { api('GET', '/billing/invoices').then(setRows); }, []);
  return (
    <>
      {open && <InvoiceView inv={open} onClose={() => setOpen(null)} />}
      <table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Plan</th><th>Period</th><th>Total</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}>
            <td>{i.number || '—'}</td><td>{fmt(i.paidOn)}</td><td>{i.planCode} · {i.months} mo</td><td>{fmt(i.periodStart)} → {fmt(i.periodEnd)}</td>
            <td>{inr(i.total)}</td>
            <td><span style={{ background: BADGE[i.status][2], color: BADGE[i.status][1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{BADGE[i.status][0]}</span></td>
            <td>{i.status === 'paid' && <button onClick={() => api('GET', `/billing/invoices/${i.id}`).then(setOpen)}>View</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="muted">No invoices yet.</p>}
    </>
  );
}

function InvoiceView({ inv, onClose }) {
  const s = inv.seller;
  return (
    <div className="card">
      <div className="row"><h3 style={{ margin: 0 }}>Tax invoice {inv.number}</h3><button onClick={() => window.print()}>Print</button><button onClick={onClose}>Close</button></div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 240 }}><strong>{s.name}</strong><div className="muted">{s.address || ''}</div><div className="muted">GSTIN {s.gstin || 'not set'} · State {s.stateCode}</div></div>
        <div style={{ flex: 1, minWidth: 240 }}><strong>Billed to</strong><div>{inv.customerName}</div><div className="muted">GSTIN {inv.customerGstin || 'unregistered'} · Place of supply {inv.customerState}</div></div>
        <div className="muted">Date {fmt(inv.paidOn)}<br />Payment ref {inv.paymentId}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th>SAC</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>IBMP {inv.planName} subscription, {inv.months} month(s), {fmt(inv.periodStart)} to {fmt(inv.periodEnd)}</td><td>998431</td><td>{inr(inv.base)}</td></tr>
          {inv.credit > 0 && <tr><td>Less: credit for unused time on previous plan</td><td /><td>− {inr(inv.credit)}</td></tr>}
          <tr><td><strong>Taxable value</strong></td><td /><td>{inr(inv.taxable)}</td></tr>
          {inv.igst > 0 ? <tr><td>IGST @ {inv.gstPct}%</td><td /><td>{inr(inv.igst)}</td></tr>
            : <><tr><td>CGST @ {inv.gstPct / 2}%</td><td /><td>{inr(inv.cgst)}</td></tr><tr><td>SGST @ {inv.gstPct / 2}%</td><td /><td>{inr(inv.sgst)}</td></tr></>}
          <tr><td><strong>Total</strong></td><td /><td><strong>{inr(inv.total)}</strong></td></tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12 }}>This is a computer-generated invoice. SAC 998431 (software as a service) is shown for reference: confirm it with your tax adviser.</p>
    </div>
  );
}
