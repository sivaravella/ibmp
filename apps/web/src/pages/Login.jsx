import React, { useEffect, useState } from 'react';
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

const Google = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" /><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" /><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" /></svg>
);
const LinkedIn = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#0A66C2" /><path fill="#fff" d="M6.9 9.6H4.2V19h2.7V9.6zM5.5 5.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM19.8 13.7c0-2.5-1.3-4.3-3.6-4.3-1.1 0-1.9.6-2.3 1.2V9.6h-2.6V19h2.7v-5c0-1.3.6-2.1 1.7-2.1s1.4.8 1.4 2.1v5h2.7v-5.3z" /></svg>
);
const SOCIAL = [['google', 'Google', Google], ['linkedin', 'LinkedIn', LinkedIn]];

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ sector: 'trading', accountType: 'individual', body: 'ICAI' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const consultant = f.accountType === 'consultant';
  const [providers, setProviders] = useState({});
  const [pending, setPending] = useState(null);       // a first-time Google/LinkedIn sign-in: { token, email, name, providerName }

  // The provider sends the person back to "/#social=<session>", "/#social-signup=<token>" or "/#social-error=<message>".
  useEffect(() => {
    api('GET', '/auth/social/providers').then(setProviders).catch(() => {});
    const m = location.hash.match(/^#(social|social-signup|social-error)=(.*)$/);
    if (!m) return;
    const value = decodeURIComponent(m[2]);
    history.replaceState(null, '', location.pathname + location.search);
    if (m[1] === 'social') { setToken(value); onAuth(); }
    else if (m[1] === 'social-error') setErr(value);
    else api('POST', '/auth/social/signup-info', { token: value }).then((i) => { setPending({ token: value, ...i }); setMode('social'); }).catch((e) => setErr(e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const company = {
        company: f.company, sector: f.sector,
        ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : { stateCode: f.stateCode }),
        accountType: f.accountType,
        ...(consultant ? { consultant: { body: f.body, membershipNo: f.membershipNo, registeredName: f.registeredName } } : {}),
      };
      if (mode === 'social') { const { token } = await api('POST', '/auth/social/complete', { token: pending.token, ...company }); setToken(token); onAuth(); return; }
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
          <h2>{mode === 'login' ? 'Welcome back' : mode === 'social' ? `Welcome, ${pending.name.split(' ')[0]}` : 'Create your account'}</h2>
          <p className="lead">{mode === 'login' ? 'Sign in to continue to your dashboard.' : mode === 'social' ? `One last step: tell us about your business. You are signing up with ${pending.providerName} as ${pending.email}.` : 'Start a free 14-day trial. No card needed.'}</p>
          {mode !== 'social' && SOCIAL.some(([k]) => providers[k]) && <>
            <div className="social-row">
              {SOCIAL.filter(([k]) => providers[k]).map(([k, label, Logo]) => <a key={k} className="social-btn" href={`/v1/auth/social/${k}/start`}><Logo /> {mode === 'login' ? 'Continue' : 'Sign up'} with {label}</a>)}
            </div>
            <div className="auth-or"><span>or use your email</span></div>
          </>}
          {(mode === 'register' || mode === 'social') && <>
            <Segmented wide label="Account type" value={f.accountType} onChange={(v) => setF({ ...f, accountType: v })} options={[['individual', 'Business Owner'], ['consultant', 'CA / CS / CMA']]} />
            {mode === 'register' && <input placeholder="Your name" autoComplete="name" onChange={set('name')} required />}
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
          {mode !== 'social' && <input type="email" placeholder="Email" autoComplete="username" onChange={set('email')} required />}
          {mode !== 'social' && <input type="password" placeholder="Password (min 8 characters)" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onChange={set('password')} required />}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'social' ? 'Finish and start my trial' : 'Create account'}</button>
          <p className="auth-switch">
            {mode === 'login' ? 'New to IBMP? ' : 'Already have an account? '}
            <a href="#" onClick={(e) => { e.preventDefault(); setErr(''); setPending(null); setMode(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? 'Create an account' : mode === 'social' ? 'Cancel' : 'Sign in'}</a>
          </p>
        </form>
      </div>
    </div>
  );
}
