import React, { useState } from 'react';
import { api, setToken } from '../api.js';

const SECTORS = ['retail', 'trading', 'service', 'wholesale', 'hospital', 'pharmacy'];

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ sector: 'trading', accountType: 'individual', body: 'ICAI' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const consultant = f.accountType === 'consultant';

  async function submit(e) {
    e.preventDefault();
    setErr('');
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
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h1>IBMP</h1>
      <p className="muted">Integrated Business Management Platform</p>
      {mode === 'register' && <>
        <div className="row" style={{ marginBottom: 0 }}>
          <label><input type="radio" checked={!consultant} onChange={() => setF({ ...f, accountType: 'individual' })} /> My own business</label>
          <label><input type="radio" checked={consultant} onChange={() => setF({ ...f, accountType: 'consultant' })} /> CA / CS / CMA managing clients</label>
        </div>
        <input placeholder="Your name" onChange={set('name')} required />
        <input placeholder={consultant ? 'Practice or firm name' : 'Company name'} onChange={set('company')} required />
        <select value={f.sector} onChange={set('sector')}>{SECTORS.map((s) => <option key={s}>{s}</option>)}</select>
        <input placeholder="GSTIN (or fill state code below)" onChange={set('gstin')} />
        {!f.gstin && <input placeholder="State code, e.g. 29" maxLength={2} onChange={set('stateCode')} required />}
        {consultant && <>
          <div className="row" style={{ marginBottom: 0 }}>
            <select value={f.body} onChange={set('body')}><option>ICAI</option><option>ICSI</option><option>ICMAI</option></select>
            <input placeholder="Membership no." onChange={set('membershipNo')} required style={{ flex: 1, minWidth: 120 }} />
          </div>
          <input placeholder="Name as registered with the institute" onChange={set('registeredName')} required />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Your membership is checked by our team after you sign up. You can start straight away.</p>
        </>}
      </>}
      <input type="email" placeholder="Email" onChange={set('email')} required />
      <input type="password" placeholder="Password (min 8 chars)" onChange={set('password')} required />
      {err && <p className="err">{err}</p>}
      <button className="primary">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); }}>
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </a>
    </form>
  );
}
