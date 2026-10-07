import React, { useState } from 'react';
import { api, setToken } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { Segmented } from '../ui/kit.jsx';

const SECTORS = ['retail', 'trading', 'service', 'wholesale', 'hospital', 'pharmacy'];
const POINTS = [
  ['percent', 'GST done properly', 'Invoices, returns, GSTR-1 and GSTR-3B from the same books, checked before they go to the portal.'],
  ['calendar', 'Never miss a due date', 'A compliance calendar with reminders by email, WhatsApp and SMS.'],
  ['briefcase', 'Payroll, PF, ESI and TDS', 'Payslips, ECR, Form 16 and 24Q without a second tool.'],
  ['users', 'Built for CAs and CSs too', 'Manage every client company from one login.'],
];

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ sector: 'trading', accountType: 'individual', body: 'ICAI' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const consultant = f.accountType === 'consultant';

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const body = mode === 'login'
        ? { email: f.email, password: f.password }
        : {
          name: f.name, email: f.email, password: f.password, company: f.company, sector: f.sector,
          ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : { stateCode: f.stateCode }),
          accountType: f.accountType,
          ...(consultant ? { consultant: { body: f.body, membershipNo: f.membershipNo, registeredName: f.registeredName } } : {}),
        };
      const { token } = await api('POST', `/auth/${mode === 'login' ? 'login' : 'register'}`, body);
      setToken(token);
      onAuth();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-page">
      <section className="auth-hero" aria-hidden="false">
        <div className="brand"><div className="brand-mark">I</div><div><strong>IBMP</strong><span>Integrated Business Management Platform</span></div></div>
        <div>
          <h1>Run your books, GST and people from one place.</h1>
          <p>Made for Indian SMEs and the professionals who look after them.</p>
          <ul className="auth-points">
            {POINTS.map(([icon, title, text]) => <li key={title}><span className="ico"><Icon name={icon} size={18} /></span><div><b>{title}</b><span>{text}</span></div></li>)}
          </ul>
        </div>
        <small>© IBMP. Your data stays in your account.</small>
      </section>
      <div className="auth-side">
        <form className="auth" onSubmit={submit}>
          <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="lead">{mode === 'login' ? 'Sign in to continue to your dashboard.' : 'Start a free 14-day trial. No card needed.'}</p>
          {mode === 'register' && <>
            <Segmented wide label="Account type" value={f.accountType} onChange={(v) => setF({ ...f, accountType: v })} options={[['individual', 'My own business'], ['consultant', 'CA / CS / CMA']]} />
            <input placeholder="Your name" autoComplete="name" onChange={set('name')} required />
            <input placeholder={consultant ? 'Practice or firm name' : 'Company name'} autoComplete="organization" onChange={set('company')} required />
            <select value={f.sector} onChange={set('sector')} aria-label="Sector">{SECTORS.map((s) => <option key={s}>{s}</option>)}</select>
            <input placeholder="GSTIN (or fill the state code below)" onChange={set('gstin')} />
            {!f.gstin && <input placeholder="State code, e.g. 29" maxLength={2} onChange={set('stateCode')} required />}
            {consultant && <>
              <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
                <select value={f.body} onChange={set('body')} style={{ width: 110 }} aria-label="Professional body"><option>ICAI</option><option>ICSI</option><option>ICMAI</option></select>
                <input placeholder="Membership no." onChange={set('membershipNo')} required />
              </div>
              <input placeholder="Name as registered with the institute" onChange={set('registeredName')} required />
              <p className="muted" style={{ fontSize: 12.5 }}>Our team checks your membership after you sign up. You can start straight away.</p>
            </>}
          </>}
          <input type="email" placeholder="Email" autoComplete="username" onChange={set('email')} required />
          <input type="password" placeholder="Password (min 8 characters)" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onChange={set('password')} required />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <p className="auth-switch">
            {mode === 'login' ? 'New to IBMP? ' : 'Already have an account? '}
            <a href="#" onClick={(e) => { e.preventDefault(); setErr(''); setMode(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</a>
          </p>
        </form>
      </div>
    </div>
  );
}
