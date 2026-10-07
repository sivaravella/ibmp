import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Panel, Skeleton } from '../ui/kit.jsx';
import { Field, Notice } from '../ui/forms.jsx';
import { fmtDate } from '../ui/format.js';

const NAMES = { google: 'Google', linkedin: 'LinkedIn' };

/** How this person signs in: the password, and the Google or LinkedIn accounts linked to the login. */
export default function Security() {
  const [s, setS] = useState(null);
  const [f, setF] = useState({ currentPassword: '', newPassword: '', again: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/auth/security').then(setS).catch((e) => setErr(e.message)); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function savePassword(e) {
    e.preventDefault(); setErr(''); setMsg('');
    if (f.newPassword !== f.again) return setErr('The two new passwords are not the same.');
    setBusy(true);
    try {
      setS(await api('POST', '/auth/password', { ...(s.hasPassword ? { currentPassword: f.currentPassword } : {}), newPassword: f.newPassword }));
      setF({ currentPassword: '', newPassword: '', again: '' }); setMsg(s.hasPassword ? 'Password changed.' : 'Password set. You can now sign in with your email and this password too.');
    } catch (e2) { setErr(e2.issues?.map((i) => i.message).join(' ') || e2.message); } finally { setBusy(false); }
  }
  async function unlink(provider) {
    if (!window.confirm(`Unlink ${NAMES[provider] ?? provider}? You will no longer be able to sign in with it.`)) return;
    setErr(''); setMsg('');
    try { setS(await api('DELETE', `/auth/identities/${provider}`)); setMsg(`${NAMES[provider] ?? provider} unlinked.`); } catch (e2) { setErr(e2.message); }
  }

  if (!s) return <><PageHeader title="Sign-in and security" />{err ? <Notice>{err}</Notice> : <Skeleton rows={4} height={44} />}</>;
  return (
    <>
      <PageHeader title="Sign-in and security" subtitle={`How you sign in as ${s.email}`} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <Notice>{err}</Notice>
      <div className="g12">
        <Panel className="s6" title={s.hasPassword ? 'Change your password' : 'Set a password'} hint={s.hasPassword ? 'Use at least 8 characters' : 'You signed up with Google or LinkedIn, so you have no password yet. Set one to also sign in with your email.'}>
          <form onSubmit={savePassword} className="form-grid">
            {s.hasPassword && <Field label="Current password" className="span2"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} required /></Field>}
            <Field label="New password" className="span2"><input type="password" autoComplete="new-password" minLength={8} value={f.newPassword} onChange={set('newPassword')} required /></Field>
            <Field label="New password again" className="span2"><input type="password" autoComplete="new-password" minLength={8} value={f.again} onChange={set('again')} required /></Field>
            <div className="span2"><button className="primary" disabled={busy}>{busy ? 'Saving…' : s.hasPassword ? 'Change password' : 'Set password'}</button></div>
          </form>
        </Panel>
        <Panel className="s6" title="Linked accounts" hint="Signing in with these goes straight to this login">
          {s.identities.length === 0
            ? <p className="muted" style={{ margin: 0 }}>No Google or LinkedIn account is linked. Signing in with one that uses {s.email} links it automatically.</p>
            : s.identities.map((i) => (
              <div className="row" key={i.provider} style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div><b>{NAMES[i.provider] ?? i.provider}</b><div className="muted" style={{ fontSize: 12.5 }}>{i.email} · linked {fmtDate(String(i.createdAt).slice(0, 10))}</div></div>
                <button className="row-btn" onClick={() => unlink(i.provider)}>Unlink</button>
              </div>))}
          {!s.hasPassword && s.identities.length === 1 && <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>This is your only way to sign in. Set a password before you can unlink it.</p>}
        </Panel>
      </div>
    </>
  );
}
