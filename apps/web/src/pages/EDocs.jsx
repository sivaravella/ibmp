import React, { useEffect, useState } from 'react';
import { KpiCard, PageHeader, Segmented } from '../ui/kit.jsx';
import { Notice } from '../ui/forms.jsx';
import QRCode from 'qrcode';
import { api, inr } from '../api.js';

const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
const fmtTime = (d) => (d ? new Date(d).toLocaleString() : '—');
const STATUS = {
  generated: ['IRN generated', '#15803d', '#dcfce7'], pending: ['Prepared', '#475569', '#f1f5f9'], failed: ['Rejected', '#b91c1c', '#fee2e2'],
  cancelled: ['IRN cancelled', '#92400e', '#fef3c7'], needed: ['Needs IRN', '#b91c1c', '#fee2e2'], none: ['Not required', '#64748b', '#f1f5f9'], b2c: ['B2C', '#64748b', '#f1f5f9'],
};
const Chip = ({ s }) => <span style={{ background: STATUS[s][2], color: STATUS[s][1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{STATUS[s][0]}</span>;
const EWB_STATUS = { draft: ['Prepared', '#475569', '#f1f5f9'], generated: ['Generated', '#15803d', '#dcfce7'], failed: ['Rejected', '#b91c1c', '#fee2e2'], cancelled: ['Cancelled', '#92400e', '#fef3c7'] };

export default function EDocs({ go }) {
  const [tab, setTab] = useState('einvoice');
  return (
    <>
      <PageHeader title="E-invoice and e-way bill" subtitle="Invoice Reference Numbers (IRN) and transport documents, prepared and sent to the government portals">
        <Segmented label="Section" value={tab} onChange={setTab} options={[['einvoice', 'E-invoices'], ['ewb', 'E-way bills'], ['setup', 'Setup']]} />
      </PageHeader>
      {tab === 'einvoice' && <Einvoices go={go} />}
      {tab === 'ewb' && <Ewb go={go} />}
      {tab === 'setup' && <Setup go={go} />}
    </>
  );
}

function useGsp() {
  const [s, setS] = useState(null);
  useEffect(() => { api('GET', '/filing/gsp/session').then(setS).catch(() => {}); }, []);
  return s;
}

function GspNote({ gsp, go }) {
  if (!gsp) return null;
  return (
    <>
      {gsp.gsp?.mode === 'simulated' && <p style={{ background: '#fef3c7', color: '#92400e', padding: '8px 14px', borderRadius: 8 }}><strong>Simulated GSP.</strong> No IRN or e-way bill generated here is real. Do not issue goods or invoices on the strength of them.</p>}
      {!gsp.gsp && <p className="err">No GSP is configured on this server, so documents cannot be sent to the IRP or the e-way bill portal.</p>}
      {gsp.gsp && !gsp.connected && <p className="muted">Not connected to the GST portal. <button onClick={() => go('filing')}>Connect</button></p>}
    </>
  );
}

// ---------------- e-invoices ----------------
function Einvoices({ go }) {
  const [data, setData] = useState(null);
  const [onlyRequired, setOnlyRequired] = useState(false);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const gsp = useGsp();
  const load = () => api('GET', '/einvoice/documents?days=120').then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return <p>{err || 'Loading…'}</p>;

  async function prepare(d) {
    setErr('');
    try { const e = await api('POST', '/einvoice/prepare', { type: d.docType, docId: d.docId }); await load(); setOpen(e.id); } catch (e2) { setErr(e2.message); }
  }
  const docs = data.documents.filter((d) => !onlyRequired || d.required || d.einvoice);
  const state = (d) => d.einvoice?.status ?? (d.required ? 'needed' : d.b2b ? 'none' : 'b2c');
  const needed = data.documents.filter((d) => state(d) === 'needed').length;
  const generated = data.documents.filter((d) => state(d) === 'generated').length;
  const rejected = data.documents.filter((d) => ['failed', 'cancelled'].includes(state(d))).length;

  return (
    <>
      <GspNote gsp={gsp} go={go} />
      <div className="kpi-grid">
        <KpiCard label="Need an IRN" value={needed} icon="alert" tone={needed ? 'rose' : 'green'} hint="Required but not generated yet" onClick={needed ? () => setOnlyRequired(true) : undefined} />
        <KpiCard label="IRN generated" value={generated} icon="check" tone="green" hint="Accepted by the invoice registration portal" />
        <KpiCard label="Rejected or cancelled" value={rejected} icon="undo" tone={rejected ? 'amber' : 'teal'} hint="Fix and prepare again" />
        <KpiCard label="Documents, last 120 days" value={data.documents.length} icon="file" tone="brand" hint={`${data.documents.filter((d) => d.b2b).length} to registered buyers`} />
      </div>
      {!data.enabled && <p className="muted">E-invoicing is switched off for this business. You can still generate an IRN voluntarily; turn it on under Setup if it is mandatory for you.</p>}
      {err && <Notice>{err}</Notice>}
      <div className="row"><label><input type="checkbox" checked={onlyRequired} onChange={(e) => setOnlyRequired(e.target.checked)} /> Only documents that need an IRN</label></div>
      {open && <Detail id={open} gsp={gsp} go={go} onClose={() => setOpen(null)} onChange={load} />}
      <table>
        <thead><tr><th>Date</th><th>Document</th><th>Buyer</th><th>Value</th><th>Status</th><th /></tr></thead>
        <tbody>{docs.map((d) => (
          <tr key={`${d.docType}${d.docId}`}>
            <td>{fmt(d.date)}</td>
            <td>{d.number} <span className="muted">{d.docType === 'CRN' ? `credit note for ${d.against}` : ''}</span></td>
            <td>{d.party}<div className="muted" style={{ fontSize: 12 }}>{d.gstin || 'unregistered'}</div></td>
            <td>{inr(d.total)}</td>
            <td><Chip s={state(d)} /></td>
            <td>
              {d.b2b && d.einvoice?.status !== 'cancelled' && <button onClick={() => (d.einvoice && d.einvoice.status !== 'failed' ? setOpen(d.einvoice.id) : prepare(d))}>{d.einvoice?.status === 'generated' ? 'View' : d.einvoice?.status === 'pending' ? 'Review' : d.einvoice?.status === 'failed' ? 'Retry' : 'Prepare'}</button>}
              {d.einvoice?.status === 'cancelled' && <button onClick={() => setOpen(d.einvoice.id)}>View</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      {!docs.length && <p className="muted">No documents in the last 120 days.</p>}
    </>
  );
}

function Detail({ id, gsp, go, onClose, onChange }) {
  const [d, setD] = useState(null);
  const [qr, setQr] = useState('');
  const [reason, setReason] = useState(2);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api('GET', `/einvoice/${id}`).then(setD);
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (d?.signedQr) QRCode.toDataURL(d.signedQr, { margin: 1, width: 170 }).then(setQr); else setQr(''); }, [d?.signedQr]);
  if (!d) return null;

  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); await load(); onChange(); } catch (e) { setErr(e.message); await load(); } finally { setBusy(false); } };
  const errors = d.validation?.errors ?? [], warnings = d.validation?.warnings ?? [];
  const p = d.payload;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 4 }}><h3 style={{ margin: 0 }}>{d.docType === 'CRN' ? 'Credit note' : 'Invoice'} {d.docNumber}</h3><Chip s={d.status} /><button onClick={onClose}>Close</button></div>
      <p className="muted" style={{ margin: '0 0 8px' }}>To {p.BuyerDtls.LglNm} ({p.BuyerDtls.Gstin}) · taxable ₹{p.ValDtls.AssVal} · tax ₹{(p.ValDtls.CgstVal + p.ValDtls.SgstVal + p.ValDtls.IgstVal).toFixed(2)} · total ₹{p.ValDtls.TotInvVal}</p>
      {errors.map((e) => <p key={e} className="err">✗ {e}</p>)}
      {errors.some((e) => /buyer|Only B2B/i.test(e)) && <button onClick={() => go('parties')}>Open Parties to fix the buyer</button>}{' '}
      {errors.some((e) => /Your business/.test(e)) && <span className="muted">Business details are under the Setup tab of this page.</span>}
      {warnings.length > 0 && <details style={{ margin: '8px 0' }}><summary style={{ color: '#92400e', cursor: 'pointer' }}>{warnings.length} warning(s)</summary><ul style={{ margin: '6px 0', paddingLeft: 18 }}>{warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></details>}
      {d.status === 'failed' && d.gspErrors.map((e) => <p key={e.message} className="err">✗ IRP: {e.message}{e.code ? ` (${e.code})` : ''}</p>)}

      {['pending', 'failed'].includes(d.status) && (
        <div className="row">
          <button onClick={() => run(() => api('POST', '/einvoice/prepare', { type: d.docType, docId: d.docId }))} disabled={busy}>Check again</button>
          <button className="primary" disabled={busy || errors.length > 0 || !gsp?.connected} onClick={() => run(() => api('POST', `/einvoice/${id}/generate`))}>Generate IRN</button>
          {!gsp?.connected && <span className="muted">Connect to the GST portal first.</span>}
        </div>
      )}

      {d.status === 'generated' && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            {d.simulated && <p style={{ color: '#b91c1c', fontWeight: 600, margin: '0 0 6px' }}>SIMULATED: this is not a valid e-invoice.</p>}
            <table><tbody>
              <tr><td>IRN</td><td style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>{d.irn}</td></tr>
              <tr><td>Ack no.</td><td>{d.ackNo}</td></tr><tr><td>Ack date</td><td>{fmtTime(d.ackDate)}</td></tr>
            </tbody></table>
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => window.print()}>Print</button>
              <select value={reason} onChange={(e) => setReason(Number(e.target.value))}><option value={1}>Duplicate</option><option value={2}>Data entry mistake</option><option value={3}>Order cancelled</option><option value={4}>Others</option></select>
              <button disabled={busy} onClick={() => window.confirm('Cancel this IRN? It can only be done within 24 hours of generation, and the same document number cannot be reported again.') && run(() => api('POST', `/einvoice/${id}/cancel`, { reason }))}>Cancel IRN</button>
            </div>
          </div>
          {qr && <div style={{ textAlign: 'center' }}><img src={qr} alt="Signed QR code" width={170} height={170} />{d.simulated && <div style={{ color: '#b91c1c', fontSize: 12 }}>SIMULATED QR</div>}</div>}
        </div>
      )}
      {d.status === 'cancelled' && <p className="muted">IRN cancelled: {d.cancelReason}. This document number cannot be reported again: issue a new document.</p>}
      {err && <p className="err">{err}</p>}
      {d.events?.length > 0 && <details style={{ marginTop: 8 }}><summary className="muted" style={{ cursor: 'pointer' }}>History</summary>
        <table><tbody>{d.events.map((e, i) => <tr key={i}><td className="muted">{fmtTime(e.createdAt)}</td><td>{e.action.replace('_', ' ')}</td><td className="muted">{e.detail}</td></tr>)}</tbody></table></details>}
    </div>
  );
}

// ---------------- e-way bills ----------------
function Ewb({ go }) {
  const [docs, setDocs] = useState([]);
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ invoiceId: '', mode: 1, distance: '', vehicleNo: '', vehicleType: 'R', transporterId: '', transporterName: '', docNo: '', docDate: '' });
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const gsp = useGsp();
  const load = () => { api('GET', '/ewb').then(setRows); api('GET', '/einvoice/documents?days=120').then((d) => setDocs(d.documents.filter((x) => x.docType === 'INV' && (!x.ewb || x.ewb.status === 'cancelled')))); };
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const transport = () => ({
    mode: Number(f.mode), distance: Number(f.distance || 0),
    ...(f.vehicleNo ? { vehicleNo: f.vehicleNo.toUpperCase().replace(/\s/g, ''), vehicleType: f.vehicleType } : {}),
    ...(f.transporterId ? { transporterId: f.transporterId.toUpperCase(), transporterName: f.transporterName || undefined } : {}),
    ...(f.docNo ? { docNo: f.docNo, docDate: f.docDate || undefined } : {}),
  });
  async function prepare(e) {
    e.preventDefault(); setErr('');
    try { setDraft(await api('POST', '/ewb/prepare', { invoiceId: Number(f.invoiceId), transport: transport() })); load(); } catch (e2) { setErr(e2.message); }
  }
  async function generate() {
    setErr('');
    try { await api('POST', `/ewb/${draft.id}/generate`); setDraft(null); load(); } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <GspNote gsp={gsp} go={go} />
      <form className="card" onSubmit={prepare}>
        <strong>New e-way bill</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <select value={f.invoiceId} onChange={set('invoiceId')} required>
            <option value="">Invoice…</option>
            {docs.map((d) => <option key={d.docId} value={d.docId}>{d.number} · {d.party} · {inr(d.total)}{d.ewbSuggested ? ' · above the limit' : ''}</option>)}
          </select>
          <select value={f.mode} onChange={set('mode')}><option value={1}>Road</option><option value={2}>Rail</option><option value={3}>Air</option><option value={4}>Ship</option></select>
          <input type="number" min="0" max="4000" placeholder="Distance (km)" value={f.distance} onChange={set('distance')} style={{ width: 130 }} />
        </div>
        <div className="row">
          <input placeholder="Vehicle no., e.g. KA01AB1234" value={f.vehicleNo} onChange={set('vehicleNo')} />
          <select value={f.vehicleType} onChange={set('vehicleType')}><option value="R">Regular cargo</option><option value="O">Over-dimensional</option></select>
          <input placeholder="Transporter GSTIN (optional)" value={f.transporterId} onChange={set('transporterId')} />
          <input placeholder="Transporter name" value={f.transporterName} onChange={set('transporterName')} />
        </div>
        {Number(f.mode) !== 1 && <div className="row"><input placeholder="Transport document no." value={f.docNo} onChange={set('docNo')} /><input type="date" value={f.docDate} onChange={set('docDate')} /></div>}
        <button className="primary" disabled={!f.invoiceId}>Prepare</button>
        <span className="muted"> Validity is one day per 200 km (20 km for over-dimensional cargo). Distance 0 lets the portal work it out.</span>
      </form>
      {err && <p className="err">{err}</p>}
      {draft && (
        <div className="card">
          <strong>Review</strong>
          {(draft.validation?.errors ?? []).map((e) => <p key={e} className="err">✗ {e}</p>)}
          {(draft.validation?.warnings ?? []).map((w) => <p key={w} className="muted" style={{ margin: '4px 0' }}>⚠ {w}</p>)}
          <div className="row" style={{ marginTop: 8, marginBottom: 0 }}>
            <button className="primary" disabled={(draft.validation?.errors ?? []).length > 0 || !gsp?.connected} onClick={generate}>Generate e-way bill</button>
            <button onClick={() => setDraft(null)}>Close</button>
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>Invoice</th><th>Buyer</th><th>E-way bill</th><th>Valid until</th><th>Vehicle</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((w) => <EwbRow key={w.id} w={w} onChange={load} onError={setErr} />)}</tbody>
      </table>
      {!rows.length && <p className="muted">No e-way bills yet.</p>}
    </>
  );
}

function EwbRow({ w, onChange, onError }) {
  const [veh, setVeh] = useState('');
  const [editing, setEditing] = useState(false);
  const s = EWB_STATUS[w.status];
  const run = async (fn) => { onError(''); try { await fn(); setEditing(false); onChange(); } catch (e) { onError(e.message); } };
  return (
    <tr>
      <td>{w.invoiceNumber}</td><td>{w.party}</td><td>{w.ewbNo || '—'}</td><td>{w.validUpto ? fmtTime(w.validUpto) : '—'}</td>
      <td>{editing
        ? <><input value={veh} onChange={(e) => setVeh(e.target.value)} placeholder="KA01AB1234" style={{ width: 130 }} /> <button className="primary" onClick={() => run(() => api('POST', `/ewb/${w.id}/vehicle`, { vehicleNo: veh }))}>Save</button></>
        : w.vehicleNo || '—'}</td>
      <td><span style={{ background: s[2], color: s[1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{s[0]}</span></td>
      <td>{w.status === 'generated' && <>
        <button onClick={() => setEditing(!editing)}>{w.vehicleNo ? 'Change vehicle' : 'Add vehicle'}</button>{' '}
        <button onClick={() => window.confirm('Cancel this e-way bill? Only possible within 24 hours.') && run(() => api('POST', `/ewb/${w.id}/cancel`, { reason: 3 }))}>Cancel</button></>}</td>
    </tr>
  );
}

// ---------------- setup ----------------
function Setup({ go }) {
  const [p, setP] = useState(null);
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/company/profile').then(setP); api('GET', '/einvoice/settings').then(setS); }, []);
  if (!p || !s) return <p>Loading…</p>;
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });

  async function saveProfile(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      await api('PUT', '/company/profile', { legalName: p.legalName ?? '', tradeName: p.tradeName ?? '', addr1: p.addr1 ?? '', addr2: p.addr2 ?? '', loc: p.loc ?? '', pin: p.pin ?? '', phone: p.phone ?? '', email: p.email ?? '' });
      setMsg('Business details saved.');
    } catch (e2) { setErr(e2.message); }
  }
  async function saveSettings(e) {
    e.preventDefault(); setErr(''); setMsg('');
    try { await api('PUT', '/einvoice/settings', { enabled: s.enabled, applicableFrom: s.applicableFrom || null, ewbThreshold: Number(s.ewbThreshold) }); setMsg('E-invoice settings saved.'); } catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      {err && <p className="err">{err}</p>}{msg && <p style={{ color: '#15803d' }}>{msg}</p>}
      <form className="card" onSubmit={saveProfile}>
        <strong>Business details</strong>
        <p className="muted" style={{ margin: '4px 0 8px' }}>The IRP and the e-way bill portal need your registered name and full address. GSTIN: {p.gstin || 'not set'}.</p>
        <div className="row">
          <input placeholder="Legal name (as on GST registration)" value={p.legalName ?? ''} onChange={set('legalName')} style={{ minWidth: 260 }} />
          <input placeholder="Trade name" value={p.tradeName ?? ''} onChange={set('tradeName')} />
        </div>
        <div className="row">
          <input placeholder="Address line 1" value={p.addr1 ?? ''} onChange={set('addr1')} style={{ minWidth: 260 }} />
          <input placeholder="Address line 2" value={p.addr2 ?? ''} onChange={set('addr2')} />
        </div>
        <div className="row">
          <input placeholder="Town / city" value={p.loc ?? ''} onChange={set('loc')} />
          <input placeholder="PIN code" maxLength={6} value={p.pin ?? ''} onChange={set('pin')} style={{ width: 110 }} />
          <input placeholder="Phone" value={p.phone ?? ''} onChange={set('phone')} />
          <input type="email" placeholder="Email" value={p.email ?? ''} onChange={set('email')} />
        </div>
        <button className="primary">Save details</button>
      </form>

      <form className="card" onSubmit={saveSettings}>
        <strong>E-invoice and e-way bill rules</strong>
        {s.suggested && <p className="err">Your recorded turnover is above ₹5 crore. E-invoicing is probably mandatory for you.</p>}
        <p className="muted" style={{ margin: '4px 0 8px' }}>{s.note}</p>
        <div className="row">
          <label><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> E-invoicing applies to me</label>
          <label className="muted">from <input type="date" value={s.applicableFrom ?? ''} onChange={(e) => setS({ ...s, applicableFrom: e.target.value })} /></label>
          <label className="muted">E-way bill needed above ₹ <input type="number" min="0" value={s.ewbThreshold} onChange={(e) => setS({ ...s, ewbThreshold: e.target.value })} style={{ width: 110 }} /></label>
        </div>
        <button className="primary">Save rules</button>
      </form>
      <p className="muted">Generating an IRN or e-way bill needs the GST portal connection made on the <button onClick={() => go('filing')}>GST Filing</button> page.</p>
    </>
  );
}
