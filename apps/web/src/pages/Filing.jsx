import React, { useEffect, useState } from 'react';
import { PageHeader } from '../ui/kit.jsx';
import { Notice } from '../ui/forms.jsx';
import { api, download, inr } from '../api.js';

const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const STATUS = {
  draft: ['Prepared', '#475569', '#f1f5f9'], saved: ['Saved at GST portal', '#1d4ed8', '#dbeafe'], error: ['Rejected by portal', '#b91c1c', '#fee2e2'],
  submitted: ['Submitted: ready to file', '#92400e', '#fef3c7'], filed: ['Filed', '#15803d', '#dcfce7'],
};
const Chip = ({ s }) => <span style={{ background: STATUS[s][2], color: STATUS[s][1], padding: '2px 10px', borderRadius: 12, fontSize: 12 }}>{STATUS[s][0]}</span>;

export default function Filing({ params }) {
  const [period, setPeriod] = useState(params?.period || lastMonth());
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('GET', `/filing/status?period=${period}`).then((s) => { setSt(s); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setSt(null); load(); }, [period]);

  return (
    <>
      <PageHeader title="GST filing" subtitle={`Send GSTR-1 and GSTR-3B for ${monthName(period)} to the GST portal through your GSP, then file`}>
        <input type="month" value={period} max={lastMonth()} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Return period" />
      </PageHeader>
      {err && <Notice>{err}</Notice>}
      {st && <>
        {st.gsp?.mode === 'simulated' && (
          <div style={{ background: '#fef3c7', color: '#92400e', padding: '8px 14px', borderRadius: 8, marginBottom: 14 }}>
            <strong>Simulated GSP.</strong> Nothing here is sent to the GST portal and no return is really filed. It exists to build and test the flow.
            You can still download each return as JSON and upload it yourself with the GST offline tool.
          </div>
        )}
        {!st.gsp && <p className="err">No GSP is configured on this server. You can download the returns as JSON, but cannot send them to the GST portal from here.</p>}
        {!st.company.gstin && <p className="err">Add the company's GSTIN first: a return cannot be prepared without it.</p>}
        <Connection st={st} onChange={load} />
        <div className="tiles" style={{ alignItems: 'start' }}>
          <ReturnCard type="GSTR1" label="GSTR-1" what="Outward supplies" st={st} period={period} onChange={load} />
          <ReturnCard type="GSTR3B" label="GSTR-3B" what="Summary return and tax payment" st={st} period={period} onChange={load} />
        </div>
      </>}
    </>
  );
}

function Connection({ st, onChange }) {
  const [username, setUsername] = useState(st.session.username || '');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(null);
  const [err, setErr] = useState('');
  if (!st.gsp) return null;

  const run = async (fn) => { setErr(''); try { await fn(); onChange(); } catch (e) { setErr(e.message); } };
  if (st.session.connected) {
    return (
      <div className="card row">
        <span style={{ color: '#15803d' }}>● Connected to the GST portal as <strong>{st.session.username}</strong></span>
        <span className="muted">until {new Date(st.session.expiresAt).toLocaleTimeString()}</span>
        <button onClick={() => run(() => api('DELETE', '/filing/gsp/session'))}>Disconnect</button>
      </div>
    );
  }
  return (
    <div className="card">
      <strong>Connect to the GST portal</strong>
      <p className="muted" style={{ margin: '4px 0 8px' }}>Enter your GST portal username. An OTP is sent to the mobile number registered on the portal.</p>
      <div className="row">
        <input placeholder="GST portal username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <button onClick={() => run(async () => setSent(await api('POST', '/filing/gsp/otp', { username })))} disabled={!username || !st.company.gstin}>Send OTP</button>
        {sent && <>
          <input placeholder="OTP" value={otp} onChange={(e) => setOtp(e.target.value)} style={{ width: 110 }} />
          <button className="primary" onClick={() => run(() => api('POST', '/filing/gsp/session', { otp }))} disabled={!otp}>Connect</button>
        </>}
      </div>
      {sent?.hint && <p className="muted" style={{ margin: 0 }}>{sent.hint}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function ReturnCard({ type, label, what, st, period, onChange }) {
  const filing = st.filings[type];
  const [detail, setDetail] = useState(null);
  const [ack, setAck] = useState(false);
  const [otp, setOtp] = useState('');
  const [payRef, setPayRef] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDetail(null); setAck(false); setOtp(''); setErr(''); if (filing) api('GET', `/filing/returns/${filing.id}`).then(setDetail).catch(() => {}); }, [filing?.id, filing?.status, filing?.payloadHash]);

  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); onChange(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const act = (what2, body) => run(() => api('POST', `/filing/returns/${filing.id}/${what2}`, body));
  const saveFile = () => download(`/filing/export/${type}?period=${period}&file=1`, `${type}_${period.replace('-', '')}.json`).catch((e) => setErr(e.message));

  const d = detail ?? filing;
  const errors = d?.validation?.errors ?? [], warnings = d?.validation?.warnings ?? [];
  const sum = d?.summary;
  const connected = st.session.connected;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>{label}</h3>{filing && <Chip s={filing.status} />}
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>{what}</p>

      {!filing && <>
        <div className="row">
          <button className="primary" onClick={() => run(() => api('POST', '/filing/returns', { type, period }))} disabled={busy || !st.company.gstin}>Prepare {label}</button>
          <button onClick={saveFile}>Download JSON</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>Preparing takes a snapshot you can review. Nothing is sent anywhere.</p>
      </>}

      {filing && <>
        {d?.stale && filing.status !== 'filed' && filing.status !== 'submitted' && (
          <p className="err">Your books changed after this was prepared. <button onClick={() => run(() => api('POST', '/filing/returns', { type, period }))}>Prepare again</button></p>
        )}
        {sum && (
          <table style={{ maxWidth: 420 }}><tbody>
            <tr><td>Taxable value</td><td>{inr(sum.taxable)}</td></tr>
            {type === 'GSTR1' ? <>
              <tr><td>IGST / CGST / SGST</td><td>{inr(sum.igst)} / {inr(sum.cgst)} / {inr(sum.sgst)}</td></tr>
              <tr><td>Documents</td><td>{sum.invoices} invoice(s), {sum.creditNotes} credit note(s)</td></tr>
            </> : <>
              <tr><td>Output tax (IGST / CGST / SGST)</td><td>{inr(sum.igst)} / {inr(sum.cgst)} / {inr(sum.sgst)}</td></tr>
              <tr><td>Net input tax credit</td><td>{inr(sum.itcNet.igst + sum.itcNet.cgst + sum.itcNet.sgst)}</td></tr>
              <tr><td><strong>Tax payable in cash</strong></td><td><strong>{inr(sum.cashPayable)}</strong></td></tr>
            </>}
          </tbody></table>
        )}
        {errors.map((e) => <p key={e} className="err">✗ {e}</p>)}
        {filing.status === 'error' && (filing.gspErrors ?? []).map((e) => <p key={e.message} className="err">✗ GST portal: {e.message}</p>)}
        {warnings.length > 0 && (
          <details style={{ margin: '8px 0' }}><summary style={{ color: '#92400e', cursor: 'pointer' }}>{warnings.length} warning(s) to review</summary>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>{warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></details>
        )}

        <div className="row">
          {['draft', 'saved', 'error'].includes(filing.status) && <button onClick={() => run(() => api('POST', '/filing/returns', { type, period }))} disabled={busy}>Prepare again</button>}
          <button onClick={() => download(`/filing/returns/${filing.id}/json`, `${type}_${period.replace('-', '')}.json`).catch((e) => setErr(e.message))}>Download JSON</button>
          {['draft', 'error'].includes(filing.status) && <button className="primary" onClick={() => act('save')} disabled={busy || errors.length > 0 || !connected}>Save to GST portal</button>}
          {filing.status === 'error' && <button onClick={() => act('refresh')} disabled={busy}>Check status</button>}
          {filing.status === 'saved' && <button className="primary" onClick={() => act('submit')} disabled={busy}>Submit</button>}
        </div>
        {['draft', 'error'].includes(filing.status) && !connected && st.gsp && <p className="muted" style={{ margin: 0 }}>Connect to the GST portal above to save this return.</p>}

        {filing.status === 'submitted' && (
          <div className="card" style={{ background: '#fffbeb', marginTop: 10 }}>
            <strong>File {label} for {monthName(period)}</strong>
            <p className="muted" style={{ margin: '4px 0' }}>Filing is final. Review the figures above, then confirm with the OTP sent for your EVC.</p>
            {type === 'GSTR3B' && sum.cashPayable > 0 && (
              <div className="row"><input placeholder="Challan reference (CPIN)" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
                <span className="muted">The {inr(sum.cashPayable)} cash liability must be paid first.</span></div>
            )}
            <label style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed this return and understand it cannot be undone.</label>
            <div className="row" style={{ marginBottom: 0 }}>
              <input placeholder="OTP" value={otp} onChange={(e) => setOtp(e.target.value)} style={{ width: 110 }} />
              <button className="primary" disabled={busy || !ack || !otp || !connected}
                onClick={() => act('file', { otp, confirm: true, payloadHash: filing.payloadHash, ...(payRef ? { paymentRef: payRef } : {}) })}>File {label}</button>
            </div>
          </div>
        )}

        {filing.status === 'filed' && (
          <p style={{ color: '#15803d' }}>Filed on {filing.filedOn.split('-').reverse().join('-')}. ARN <strong>{filing.arn}</strong>. The compliance calendar is updated.</p>
        )}

        {detail?.events?.length > 0 && (
          <details style={{ marginTop: 8 }}><summary className="muted" style={{ cursor: 'pointer' }}>History</summary>
            <table><tbody>{detail.events.map((e, i) => <tr key={i}><td className="muted">{new Date(e.createdAt).toLocaleString()}</td><td>{e.action.replace('_', ' ')}</td><td className="muted">{e.detail}</td></tr>)}</tbody></table></details>
        )}
      </>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
