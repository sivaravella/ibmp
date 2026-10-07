import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { fmtDate, inr } from '../ui/format.js';
import { amountInWords } from '../ui/words.js';
import { isBillOfSupply } from '../ui/invoice-math.js';

/** A QR code as an image URL, or null while it is made (or when there is nothing to encode). */
function useQr(text, width = 132) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    if (!text) { setUrl(null); return undefined; }
    QRCode.toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' }).then((u) => live && setUrl(u)).catch(() => live && setUrl(null));
    return () => { live = false; };
  }, [text, width]);
  return url;
}

const addressLines = (p) => [p.addr1, p.addr2, [p.loc, p.pin].filter(Boolean).join(' '), p.stateName ? `${p.stateName} (${p.stateCode})` : null].filter(Boolean);
const num = (v) => Number(v) || 0;
const qty = (v) => String(Number(Number(v).toFixed(3)));
const pct = (v) => `${String(Number(Number(v).toFixed(2)))}%`;

/**
 * The GST tax invoice (rule 46 of the CGST Rules): supplier and recipient with GSTIN and state, serial number and date, HSN/SAC,
 * description, quantity and unit, value, discount, taxable value, rate and amount of CGST, SGST or IGST, place of supply, whether tax is
 * payable on reverse charge, the total in words and a signature. It also carries a tax summary by HSN and rate, the bank and UPI
 * details, the terms, and the e-invoice IRN and QR code or the e-way bill when there are any. Printed as it is shown, on A4.
 *
 * doc: { invoice, company, party, taxSummary, einvoice, ewaybill } (what GET /invoices/:id/document returns, or a draft built the same way).
 */
export default function InvoiceDocument({ doc, copy = 'Original for Recipient', draft = false }) {
  const { invoice: inv, company: co, party, taxSummary: summary, einvoice, ewaybill } = doc;
  const lines = inv.lines;
  const bill = isBillOfSupply(lines.filter((l) => !draft || l.itemId));       // a draft line with no item chosen yet says nothing about tax
  const intra = inv.intra;
  const discounted = lines.some((l) => num(l.discount) > 0);
  const registered = !!party.gstin;
  const balance = num(inv.balance ?? inv.total);
  const upi = co.upiId && balance > 0 ? `upi://pay?pa=${encodeURIComponent(co.upiId)}&pn=${encodeURIComponent(co.name)}&am=${balance.toFixed(2)}&cu=INR&tn=${encodeURIComponent(inv.number ?? 'Invoice')}` : null;
  const upiQr = useQr(upi, 120);
  const irn = einvoice?.status === 'generated' ? einvoice : null;
  const irnQr = useQr(irn?.signedQr, 150);
  const taxCols = bill ? 0 : intra ? 2 : 1;
  const hasBank = co.bankName || co.bankAccount || co.upiId;

  return (
    <article className="inv-doc" id="invoice-doc" aria-label={`${bill ? 'Bill of supply' : 'Tax invoice'} ${inv.number ?? ''}`}>
      {draft && <div className="inv-watermark" aria-hidden="true">PREVIEW</div>}

      <header className="inv-head">
        <div className="inv-seller">
          {co.logo ? <img className="inv-logo-img" src={co.logo} alt="" /> : <div className="inv-logo" aria-hidden="true">{(co.tradeName || co.name || '?').trim().charAt(0).toUpperCase()}</div>}
          <div>
            <h1>{co.name}</h1>
            {co.tradeName && co.tradeName !== co.name && <div className="inv-sub">Trading as {co.tradeName}</div>}
            {addressLines(co).map((l) => <div key={l}>{l}</div>)}
            <div className="inv-ids">
              {co.gstin ? <span><b>GSTIN</b> {co.gstin}</span> : <span className="inv-warn">GSTIN not set</span>}
              {co.pan && <span><b>PAN</b> {co.pan}</span>}
            </div>
            {(co.phone || co.email) && <div className="inv-sub">{[co.phone && `Tel ${co.phone}`, co.email].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
        <div className="inv-title">
          <h2>{bill ? 'Bill of Supply' : 'Tax Invoice'}</h2>
          <div className="inv-copy">{copy}</div>
        </div>
      </header>

      <section className="inv-meta">
        <div><span>Invoice no.</span><b>{inv.number ?? 'Assigned when saved'}</b></div>
        <div><span>Invoice date</span><b>{inv.date ? fmtDate(inv.date) : '—'}</b></div>
        <div><span>Due date</span><b>{inv.dueDate ? fmtDate(inv.dueDate) : 'On receipt'}</b></div>
        <div><span>Place of supply</span><b>{inv.placeOfSupply ? `${inv.placeOfSupplyName} (${inv.placeOfSupply})` : '—'}</b></div>
        <div><span>Reverse charge</span><b>No</b></div>
        {inv.paymentTerms && <div><span>Mode / terms of payment</span><b>{inv.paymentTerms}</b></div>}
        {inv.reference && <div><span>Buyer's ref. / order no.</span><b>{inv.reference}</b></div>}
        {inv.otherRefs && <div><span>Other references</span><b>{inv.otherRefs}</b></div>}
        {inv.dispatchedThrough && <div><span>Dispatched through</span><b>{inv.dispatchedThrough}</b></div>}
        {inv.destination && <div><span>Destination</span><b>{inv.destination}</b></div>}
        {ewaybill?.ewbNo && <div><span>E-way bill</span><b>{ewaybill.ewbNo}</b></div>}
      </section>

      <section className="inv-parties">
        <div>
          <h3>Bill to</h3>
          <b className="inv-name">{party.name || 'Select a customer'}</b>
          {party.name && addressLines(party).map((l) => <div key={l}>{l}</div>)}
          <div className="inv-ids">{registered ? <span><b>GSTIN</b> {party.gstin}</span> : party.name ? <span>Unregistered buyer</span> : null}{party.pan && <span><b>PAN</b> {party.pan}</span>}</div>
          {(party.phone || party.email) && <div className="inv-sub">{[party.phone, party.email].filter(Boolean).join(' · ')}</div>}
        </div>
        <div>
          <h3>Ship to</h3>
          {inv.shipTo ? <div className="inv-pre">{inv.shipTo}</div> : <div className="inv-sub">Same as the billing address</div>}
        </div>
      </section>

      <table className="inv-lines">
        <thead>
          <tr>
            <th className="c">#</th><th>Description of goods / services</th><th className="c">HSN / SAC</th><th className="r">Qty</th><th className="c">Unit</th><th className="r">Rate</th>
            {discounted && <th className="r">Discount</th>}<th className="r">{bill ? 'Amount' : 'Taxable value'}</th>
            {!bill && intra && <><th className="r">CGST</th><th className="r">SGST</th></>}{!bill && !intra && <th className="r">IGST</th>}
            {!bill && <th className="r">Total</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="c">{i + 1}</td><td>{l.description || <span className="inv-sub">Select an item</span>}</td><td className="c">{l.hsn || '—'}</td>
              <td className="r">{qty(l.qty)}</td><td className="c">{l.unit || 'Nos'}</td><td className="r">{inr(l.rate)}</td>
              {discounted && <td className="r">{num(l.discount) > 0 ? <>{inr(l.discount)}<small>{pct(l.discountPct)}</small></> : '—'}</td>}
              <td className="r">{inr(l.taxable)}</td>
              {!bill && intra && <><td className="r">{inr(l.cgst)}<small>{pct(num(l.gstPct) / 2)}</small></td><td className="r">{inr(l.sgst)}<small>{pct(num(l.gstPct) / 2)}</small></td></>}
              {!bill && !intra && <td className="r">{inr(l.igst)}<small>{pct(l.gstPct)}</small></td>}
              {!bill && <td className="r"><b>{inr(num(l.taxable) + num(l.cgst) + num(l.sgst) + num(l.igst))}</b></td>}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="inv-totals">
        <div className="inv-words">
          <span>Total in words</span>
          <b>{amountInWords(inv.total)}</b>
          {inv.notes && <><span style={{ marginTop: 10 }}>Notes</span><div className="inv-pre">{inv.notes}</div></>}
        </div>
        <table>
          <tbody>
            {discounted && <tr><td>Total discount</td><td className="r">{inr(inv.discount)}</td></tr>}
            <tr><td>{bill ? 'Total value' : 'Taxable value'}</td><td className="r">{inr(inv.taxable)}</td></tr>
            {!bill && intra && <><tr><td>CGST</td><td className="r">{inr(inv.cgst)}</td></tr><tr><td>SGST</td><td className="r">{inr(inv.sgst)}</td></tr></>}
            {!bill && !intra && <tr><td>IGST</td><td className="r">{inr(inv.igst)}</td></tr>}
            <tr className="grand"><td>Invoice total</td><td className="r">{inr(inv.total)}</td></tr>
            {num(inv.paid) > 0 && <tr><td>Received</td><td className="r">− {inr(inv.paid)}</td></tr>}
            {num(inv.returned) > 0 && <tr><td>Credited (returns)</td><td className="r">− {inr(inv.returned)}</td></tr>}
            {(num(inv.paid) > 0 || num(inv.returned) > 0) && <tr className="due"><td>Balance due</td><td className="r">{inr(balance)}</td></tr>}
          </tbody>
        </table>
      </section>

      {!bill && summary?.length > 0 && (
        <section className="inv-summary">
          <h3>Tax summary</h3>
          <table>
            <thead><tr><th>HSN / SAC</th><th className="r">Taxable value</th>{intra ? <><th className="r">CGST rate</th><th className="r">CGST</th><th className="r">SGST rate</th><th className="r">SGST</th></> : <><th className="r">IGST rate</th><th className="r">IGST</th></>}<th className="r">Total tax</th></tr></thead>
            <tbody>
              {summary.map((x) => (
                <tr key={`${x.hsn}${x.rate}`}>
                  <td>{x.hsn || '—'}</td><td className="r">{inr(x.taxable)}</td>
                  {intra ? <><td className="r">{pct(x.rate / 2)}</td><td className="r">{inr(x.cgst)}</td><td className="r">{pct(x.rate / 2)}</td><td className="r">{inr(x.sgst)}</td></> : <><td className="r">{pct(x.rate)}</td><td className="r">{inr(x.igst)}</td></>}
                  <td className="r"><b>{inr(x.tax)}</b></td>
                </tr>
              ))}
              <tr className="sum"><td>Total</td><td className="r">{inr(summary.reduce((s, x) => s + x.taxable, 0))}</td>{intra ? <><td /><td className="r">{inr(inv.cgst)}</td><td /><td className="r">{inr(inv.sgst)}</td></> : <><td /><td className="r">{inr(inv.igst)}</td></>}<td className="r">{inr(num(inv.cgst) + num(inv.sgst) + num(inv.igst))}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {irn && (
        <section className="inv-irn">
          <div>
            <h3>E-invoice</h3>
            <div><span>IRN</span><code>{irn.irn}</code></div>
            <div><span>Ack no.</span><b>{irn.ackNo}</b> <span style={{ marginLeft: 12 }}>Ack date</span><b>{irn.ackDate ? fmtDate(irn.ackDate) : '—'}</b></div>
          </div>
          {irnQr && <img src={irnQr} alt="Signed e-invoice QR code" width={104} height={104} />}
        </section>
      )}

      <section className="inv-foot">
        <div className="inv-bank">
          {hasBank ? <>
            <h3>Bank details</h3>
            {co.bankName && <div><span>Bank</span><b>{co.bankName}{co.bankBranch ? `, ${co.bankBranch}` : ''}</b></div>}
            {co.bankAccount && <div><span>Account no.</span><b>{co.bankAccount}</b></div>}
            {co.bankIfsc && <div><span>IFSC</span><b>{co.bankIfsc}</b></div>}
            {co.upiId && <div><span>UPI</span><b>{co.upiId}</b></div>}
          </> : <><h3>Payment</h3><div className="inv-sub">Bank details are not set. Add them under invoice settings.</div></>}
          {upiQr && <div className="inv-upi"><img src={upiQr} alt="UPI payment QR code" width={86} height={86} /><small>Scan to pay {inr(balance)}</small></div>}
        </div>
        <div className="inv-terms">
          <h3>Terms and conditions</h3>
          <div className="inv-pre">{co.terms || 'Payment is due by the due date shown above. Please quote the invoice number with your payment.'}</div>
          <p className="inv-decl">We declare that this invoice shows the actual price of the goods or services described and that all particulars are true and correct.{!registered && ' Tax is charged as applicable for a sale to an unregistered buyer.'}</p>
        </div>
        <div className="inv-sign">
          <div>For <b>{co.name}</b></div>
          <div className="inv-sign-box" />
          <div>{co.signatory ? <b>{co.signatory}</b> : null}</div>
          <div className="inv-sub">Authorised signatory</div>
        </div>
      </section>

      <footer className="inv-end">{co.footer || 'Thank you for your business.'} · This is a computer-generated invoice{irn ? ' with a digitally signed e-invoice QR code' : ''}.</footer>
    </article>
  );
}
