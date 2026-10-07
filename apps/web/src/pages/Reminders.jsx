import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');
const STAGE = { due: 'on the due date' };
const stageText = (s) => STAGE[s] ?? (s.startsWith('before_') ? `${s.slice(7)} day(s) before` : `${s.slice(8)} day(s) overdue`);
const LABEL = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
const parseList = (t) => String(t).split(',').map((x) => x.trim()).filter(Boolean).map(Number);

/** Email, WhatsApp and SMS reminders for compliance items: who gets them, when, what was sent. */
export default function Reminders() {
  const [s, setS] = useState(null);
  const [lead, setLead] = useState('');
  const [over, setOver] = useState('');
  const [log, setLog] = useState([]);
  const [preview, setPreview] = useState(null);
  const [r, setR] = useState({ channel: 'email', address: '', name: '', consent: false });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => {
    api('GET', '/reminders/settings').then((x) => { setS(x); setLead(x.leadDays.join(', ')); setOver(x.overdueDays.join(', ')); });
    api('GET', '/reminders/log').then(setLog);
  };
  useEffect(load, []);
  if (!s) return null;
  const run = async (fn, ok) => { setErr(''); setMsg(''); try { const out = await fn(); if (ok) setMsg(typeof ok === 'function' ? ok(out) : ok); load(); } catch (e) { setErr(e.message); } };
  const put = (body, ok) => run(() => api('PUT', '/reminders/settings', body), ok);
  const notReady = (c) => !s.channels[c].configured;

  const tick = (k, label, channel) => (
    <label><input type="checkbox" checked={s[k]} disabled={notReady(channel) && !s[k]} onChange={(e) => put({ [k]: e.target.checked })} /> {label}
      {notReady(channel) && <span className="muted"> (not set up on this server)</span>}
      {!notReady(channel) && s.channels[channel].simulated && <span style={{ color: '#92400e' }}> (SIMULATED: nothing is really sent)</span>}</label>
  );

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Reminders</h3>
      <p className="muted" style={{ marginTop: 0 }}>Get an email, a WhatsApp message or an SMS before compliance items fall due, and again if they become overdue. Items you mark done are never reminded. Reminders start from the day you switch them on.</p>
      {err && <p className="err">{err}</p>}{msg && <p style={{ color: '#15803d' }}>{msg}</p>}
      <div className="row">{tick('emailEnabled', 'Email', 'email')}{tick('whatsappEnabled', 'WhatsApp', 'whatsapp')}{tick('smsEnabled', 'SMS', 'sms')}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <label>Days before the due date <input value={lead} onChange={(e) => setLead(e.target.value)} style={{ width: 110 }} title="0 means on the due date" /></label>
        <label>Days after, while overdue <input value={over} onChange={(e) => setOver(e.target.value)} style={{ width: 90 }} /></label>
        <button onClick={() => put({ leadDays: parseList(lead), overdueDays: parseList(over) }, 'Saved.')}>Save timing</button>
      </div>

      <h4>Who gets them</h4>
      <table>
        <thead><tr><th>Channel</th><th>Address</th><th>Name</th><th /></tr></thead>
        <tbody>{s.recipients.map((x) => (
          <tr key={x.id} style={{ opacity: x.active ? 1 : 0.5 }}>
            <td>{LABEL[x.channel]}</td><td>{x.channel === 'email' ? x.address : `+${x.address}`}</td><td>{x.name ?? '—'}</td>
            <td className="row">
              <button onClick={() => run(() => api('POST', `/reminders/recipients/${x.id}/test`, {}), (o) => `Test message sent${o.simulated ? ' (simulated)' : ''}.`)} disabled={notReady(x.channel)}>Send test</button>
              <button onClick={() => run(() => api('PUT', `/reminders/recipients/${x.id}`, { active: !x.active }))}>{x.active ? 'Pause' : 'Resume'}</button>
              <button onClick={() => window.confirm('Remove this recipient?') && run(() => api('DELETE', `/reminders/recipients/${x.id}`))}>Remove</button>
            </td>
          </tr>))}
          {!s.recipients.length && <tr><td colSpan={4} className="muted">No recipients yet.</td></tr>}
        </tbody>
      </table>
      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); run(() => api('POST', '/reminders/recipients', { channel: r.channel, address: r.address, ...(r.name ? { name: r.name } : {}), ...(r.channel !== 'email' ? { consent: r.consent } : {}) }), 'Added.').then(() => setR({ ...r, address: '', name: '' })); }}>
        <select value={r.channel} onChange={(e) => setR({ ...r, channel: e.target.value })}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select>
        <input placeholder={r.channel === 'email' ? 'name@company.com' : 'Mobile number (+91…)'} value={r.address} onChange={(e) => setR({ ...r, address: e.target.value })} required style={{ width: 220 }} />
        <input placeholder="Name (optional)" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} style={{ width: 150 }} />
        {r.channel !== 'email' && <label title="The person's agreement is required"><input type="checkbox" checked={r.consent} onChange={(e) => setR({ ...r, consent: e.target.checked })} /> This person agreed to receive {LABEL[r.channel]} messages from us</label>}
        <button className="primary">Add</button>
      </form>
      {s.channels.whatsapp.configured && !s.channels.whatsapp.simulated && <p className="muted">WhatsApp sends your approved template <strong>{s.channels.whatsapp.template}</strong> (two variables: the company name and the list of items).</p>}

      {s.channels.sms.configured && !s.channels.sms.simulated && <p className="muted">SMS sends your DLT-registered template: <em>{s.channels.sms.template}</em> (variables: company, number of items, the most urgent item, its due date; each cut to {s.channels.sms.variableMax} characters).</p>}
      {s.channels.sms.configured && s.channels.sms.simulated && <p className="muted">SMS wording (register this template with your DLT operator before using a real SMS provider): <em>{s.channels.sms.template}</em></p>}

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => run(() => api('GET', '/reminders/preview').then(setPreview))}>What would be sent today?</button>
        <button onClick={() => run(() => api('POST', '/reminders/run', {}), (o) => { const n = o.results.filter((x) => x.status === 'sent').length; return n ? `${n} message(s) sent.` : 'Nothing is due to be sent right now.'; })}>Send due reminders now</button>
      </div>
      {preview && <div style={{ marginTop: 8 }}>
        {!preview.results.length && <p className="muted">Nothing would be sent today.</p>}
        {preview.results.map((x, i) => <p key={i} style={{ margin: '4px 0' }}><strong>{LABEL[x.channel]}</strong> to {x.to}: {x.items.map((it) => `${it.name} (${stageText(it.stage)})`).join('; ')}
          {x.status === 'skipped' && <span className="err"> · skipped: {x.reason}</span>}</p>)}
      </div>}

      <h4>Recent messages</h4>
      <table>
        <thead><tr><th>When</th><th>Channel</th><th>To</th><th>About</th><th>Result</th></tr></thead>
        <tbody>{log.slice(0, 15).map((x) => (
          <tr key={x.id}><td>{fmt(x.at)}</td><td>{LABEL[x.channel]}</td><td>{x.to}</td>
            <td>{x.kind === 'test' ? 'Test message' : x.ruleCode === 'CUSTOM' ? `Custom item (${stageText(x.stage)})` : x.ruleCode ? `${x.ruleCode} ${x.periodKey} (${stageText(x.stage)})` : '—'}</td>
            <td style={{ color: x.status === 'failed' ? '#b91c1c' : undefined }}>{x.status === 'failed' ? `Failed: ${x.error}` : x.provider === 'simulated' ? 'Sent (simulated)' : 'Sent'}</td></tr>))}
          {!log.length && <tr><td colSpan={5} className="muted">Nothing sent yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
