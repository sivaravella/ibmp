// Sign in with Google or LinkedIn (OpenID Connect, authorization-code flow, all on the server).
//   GET  /v1/auth/social/providers            which buttons to show
//   GET  /v1/auth/social/:provider/start      redirects to the provider
//   GET  /v1/auth/social/:provider/callback   the provider sends the person back here; we redirect to the app with a result
//   POST /v1/auth/social/signup-info          who a pending sign-up is (so the form can say "Signing up as ...")
//   POST /v1/auth/social/complete             finish a first-time sign-up with the company details
// The result reaches the browser in the URL fragment (#social=<session token>), which is never sent to a server or logged.
// A person who already has an account is matched by the provider's verified email and the provider account is linked to it.
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { signPurposeToken, verifyPurposeToken } from './auth.js';
import { createAccount, loginToken, needsConsultant, registerBase } from './routes/auth.js';
import { h, httpError } from './util.js';

export const PROVIDERS = {
  google: { name: 'Google', auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile' },
  linkedin: { name: 'LinkedIn', auth: 'https://www.linkedin.com/oauth/v2/authorization', token: 'https://www.linkedin.com/oauth/v2/accessToken', userinfo: 'https://api.linkedin.com/v2/userinfo', scope: 'openid profile email' },
};

const COOKIE = 'ibmp_oauth';
const cookieOf = (req, name) => String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

const completeSchema = registerBase.omit({ name: true, email: true, password: true }).extend({ token: z.string().min(10) }).refine(...needsConsultant);

/**
 * providers: { google?: { clientId, clientSecret }, linkedin?: {...} } (only configured ones). fetchFn is injectable for tests.
 * publicUrl: the address users open, used for the redirect URI and for sending them back; defaults to the request's own origin.
 */
export function socialRoutes(pool, { providers = {}, publicUrl = '', bcryptRounds = 10, fetchFn = fetch } = {}) {
  const r = Router();
  const base = (req) => (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const redirectUri = (req, p) => `${base(req)}/v1/auth/social/${p}/callback`;
  const back = (req, res, key, value) => res.redirect(302, `${base(req)}/#${key}=${encodeURIComponent(value)}`);
  const known = (req) => { const p = req.params.provider; if (!PROVIDERS[p] || !providers[p]) throw httpError(404, 'That sign-in method is not available'); return p; };

  r.get('/providers', (_req, res) => res.json(Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, !!providers[p]]))));

  r.get('/:provider/start', h(async (req, res) => {
    const p = known(req), nonce = crypto.randomBytes(16).toString('hex');
    const secure = base(req).startsWith('https');
    res.setHeader('Set-Cookie', `${COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/v1/auth/social; Max-Age=600${secure ? '; Secure' : ''}`);
    const u = new URL(PROVIDERS[p].auth);
    u.search = new URLSearchParams({ client_id: providers[p].clientId, redirect_uri: redirectUri(req, p), response_type: 'code', scope: PROVIDERS[p].scope, state: signPurposeToken('oauth-state', { n: nonce, p }, '10m'), ...(p === 'google' ? { prompt: 'select_account' } : {}) }).toString();
    res.redirect(302, u.toString());
  }));

  r.get('/:provider/callback', h(async (req, res) => {
    const p = known(req);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/v1/auth/social; Max-Age=0`);
    try {
      if (req.query.error) throw httpError(400, req.query.error === 'access_denied' || req.query.error === 'user_cancelled_login' || req.query.error === 'user_cancelled_authorize' ? 'Sign-in was cancelled.' : 'The sign-in could not be completed.');
      let st;
      try { st = verifyPurposeToken('oauth-state', req.query.state); } catch { throw httpError(400, 'This sign-in link has expired. Please try again.'); }
      if (st.p !== p || !cookieOf(req, COOKIE) || cookieOf(req, COOKIE) !== st.n) throw httpError(400, 'This sign-in did not start in this browser. Please try again.');
      if (!req.query.code) throw httpError(400, 'The sign-in could not be completed.');

      const tr = await fetchFn(PROVIDERS[p].token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req, p), client_id: providers[p].clientId, client_secret: providers[p].clientSecret }).toString() });
      const tok = await tr.json().catch(() => ({}));
      if (!tr.ok || !tok.access_token) throw httpError(502, `${PROVIDERS[p].name} did not accept the sign-in. Please try again.`);
      const ur = await fetchFn(PROVIDERS[p].userinfo, { headers: { authorization: `Bearer ${tok.access_token}` } });
      const me = await ur.json().catch(() => ({}));
      if (!ur.ok || !me.sub) throw httpError(502, `Could not read your profile from ${PROVIDERS[p].name}.`);
      const email = String(me.email || '').toLowerCase();
      if (!email || !(me.email_verified === true || me.email_verified === 'true')) throw httpError(400, `${PROVIDERS[p].name} did not give a verified email address, so we cannot sign you in with it.`);
      const name = me.name || [me.given_name, me.family_name].filter(Boolean).join(' ') || email.split('@')[0];

      let user = (await pool.query('SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2', [p, String(me.sub)])).rows[0];
      if (!user) {
        const byEmail = (await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
        if (byEmail) {
          // IBMP does not check that a person owns the email they register with, so an account made with a password may have been made by someone else.
          // Linking by email alone would hand that person the victim's sign-in. Only an account whose email a provider has already vouched for is linked silently;
          // otherwise the owner of the account has to prove it with the password.
          const vouched = Number((await pool.query('SELECT COUNT(*) AS n FROM user_identities WHERE user_id=$1', [byEmail.id])).rows[0].n) > 0;
          if (!vouched) return back(req, res, 'social-link', signPurposeToken('social-link', { uid: byEmail.id, p, sub: String(me.sub), email }, '10m'));
          await pool.query('INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1,$2,$3,$4)', [byEmail.id, p, String(me.sub), email]);
          user = byEmail;
        }
      }
      if (user) return back(req, res, 'social', await loginToken(pool, user));
      return back(req, res, 'social-signup', signPurposeToken('social-signup', { p, sub: String(me.sub), email, name }, '30m'));
    } catch (e) { return back(req, res, 'social-error', e.status && e.status < 500 || e.status === 502 ? e.message : 'The sign-in could not be completed.'); }
  }));

  const pending = (token) => { try { return verifyPurposeToken('social-signup', token); } catch { throw httpError(400, 'This sign-up has expired. Please start again.'); } };

  // An account with this email already exists and has a password: the person must enter it once before the provider is linked.
  const pendingLink = (token) => { try { return verifyPurposeToken('social-link', token); } catch { throw httpError(400, 'This link request has expired. Please start again.'); } };
  r.post('/link-info', h(async (req, res) => {
    const s = pendingLink(z.object({ token: z.string() }).parse(req.body).token);
    res.json({ email: s.email, provider: s.p, providerName: PROVIDERS[s.p]?.name });
  }));
  r.post('/link-confirm', h(async (req, res) => {
    const b = z.object({ token: z.string(), password: z.string().min(1) }).parse(req.body);
    const s = pendingLink(b.token);
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [s.uid])).rows[0];
    if (!user || user.email !== s.email || !user.password_set || !(await bcrypt.compare(b.password, user.password_hash))) throw httpError(401, 'That password is not correct.');
    await pool.query('INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING', [user.id, s.p, s.sub, s.email]);
    res.json({ token: await loginToken(pool, user) });
  }));

  r.post('/signup-info', h(async (req, res) => {
    const s = pending(z.object({ token: z.string() }).parse(req.body).token);
    res.json({ email: s.email, name: s.name, provider: s.p, providerName: PROVIDERS[s.p]?.name });
  }));

  r.post('/complete', h(async (req, res) => {
    const { token, ...b } = completeSchema.parse(req.body);
    const s = pending(token);
    const u = await createAccount(pool, { ...b, name: s.name, email: s.email }, await bcrypt.hash(crypto.randomBytes(32).toString('hex'), bcryptRounds));     // no password: they sign in with the provider
    await pool.query('INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1,$2,$3,$4)', [u.id, s.p, s.sub, s.email]);
    await pool.query('UPDATE users SET password_set=false WHERE id=$1', [u.id]);
    res.status(201).json({ token: await loginToken(pool, { ...u, active_company_id: u.company_id }) });
  }));

  return r;
}
