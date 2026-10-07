import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';

let pool, origin, profile;
let tokenOk = true;
// A stand-in for Google and LinkedIn: the token endpoint hands out a code's token, userinfo returns whatever `profile` is.
const socialFetch = async (url, init = {}) => {
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (/token|accessToken/.test(url)) return tokenOk ? json(200, { access_token: 'at' }) : json(400, { error: 'invalid_grant' });
  assert.equal(init.headers.authorization, 'Bearer at');
  return json(200, profile);
};

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { social: { google: { clientId: 'gid', clientSecret: 'gsecret' }, linkedin: { clientId: 'lid', clientSecret: 'lsecret' } }, socialFetch }).listen(0);
  server.unref();
  origin = `http://127.0.0.1:${server.address().port}`;
});

const get = (path, cookie) => fetch(origin + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const post = async (path, body) => { const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

/** Walk the whole redirect dance for a provider and return the fragment the browser lands on. */
async function signIn(provider, { tamper } = {}) {
  const start = await get(`/v1/auth/social/${provider}/start`);
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.equal(to.searchParams.get('redirect_uri'), `${origin}/v1/auth/social/${provider}/callback`);
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.match(to.searchParams.get('scope'), /openid/);
  const cb = await get(`/v1/auth/social/${provider}/callback?code=abc&state=${tamper ? 'x' + to.searchParams.get('state') : to.searchParams.get('state')}`, cookie);
  assert.equal(cb.status, 302);
  const frag = new URL(cb.headers.get('location')).hash.slice(1);
  const [key, ...v] = frag.split('=');
  return { key, value: decodeURIComponent(v.join('=')), to, cookie };
}

test('only configured providers are offered', async () => {
  const r = await (await get('/v1/auth/social/providers')).json();
  assert.deepEqual(r, { google: true, linkedin: true });
  assert.equal((await get('/v1/auth/social/facebook/start')).status, 404);
});

test('the provider page is sent the right client, scope and a state we can check', async () => {
  const g = await signIn('google').catch(() => null);      // profile not set yet: only the start leg matters here
  assert.ok(g);
  const start = await get('/v1/auth/social/linkedin/start');
  const u = new URL(start.headers.get('location'));
  assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(u.searchParams.get('client_id'), 'lid');
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
});

test('a first-time Google user finishes sign-up with company details, then signs in again without them', async () => {
  profile = { sub: 'g-1', email: 'Priya@Example.com', email_verified: true, name: 'Priya Rao' };
  const first = await signIn('google');
  assert.equal(first.key, 'social-signup');
  const info = await post('/v1/auth/social/signup-info', { token: first.value });
  assert.deepEqual([info.body.email, info.body.name, info.body.providerName], ['priya@example.com', 'Priya Rao', 'Google']);

  const bad = await post('/v1/auth/social/complete', { token: first.value, company: 'Priya Traders', sector: 'trading' });
  assert.equal(bad.status, 400);                                   // neither a GSTIN nor a state
  const done = await post('/v1/auth/social/complete', { token: first.value, company: 'Priya Traders', sector: 'trading', stateCode: '29' });
  assert.equal(done.status, 201);
  const me = await (await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${done.body.token}` } })).json();
  assert.deepEqual([me.email, me.name, me.company, me.stateCode], ['priya@example.com', 'Priya Rao', 'Priya Traders', '29']);

  const again = await signIn('google');
  assert.equal(again.key, 'social');
  const me2 = await (await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${again.value}` } })).json();
  assert.equal(me2.email, 'priya@example.com');
  assert.equal((await post('/v1/auth/login', { email: 'priya@example.com', password: 'guess-guess' })).status, 401);   // no usable password
});

test('LinkedIn links to the existing account with the same verified email', async () => {
  const reg = await post('/v1/auth/register', { name: 'Sam', email: 'sam@example.com', password: 'password123', company: 'Sam Co', sector: 'trading', stateCode: '27' });
  assert.equal(reg.status, 201);
  profile = { sub: 'li-9', email: 'sam@example.com', email_verified: true, name: 'Sam L' };
  const r = await signIn('linkedin');
  assert.equal(r.key, 'social');
  const me = await (await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${r.value}` } })).json();
  assert.deepEqual([me.name, me.company], ['Sam', 'Sam Co']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_identities WHERE provider='linkedin'")).rows[0].n, 1);
  assert.equal((await post('/v1/auth/login', { email: 'sam@example.com', password: 'password123' })).status, 200);       // the password still works
});

test('an unverified email, a forged state, a missing cookie or a refused code never signs anyone in', async () => {
  profile = { sub: 'x-1', email: 'sam@example.com', email_verified: false, name: 'Sam' };
  const unverified = await signIn('google');
  assert.equal(unverified.key, 'social-error');
  assert.match(unverified.value, /verified email/);

  profile = { sub: 'x-2', email: 'sam@example.com', email_verified: true };
  assert.equal((await signIn('google', { tamper: true })).key, 'social-error');

  const start = await get('/v1/auth/social/google/start');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const noCookie = new URL((await get(`/v1/auth/social/google/callback?code=abc&state=${state}`)).headers.get('location')).hash;
  assert.match(noCookie, /^#social-error=/);
  const denied = new URL((await get('/v1/auth/social/google/callback?error=access_denied')).headers.get('location')).hash;
  assert.match(decodeURIComponent(denied), /cancelled/);

  tokenOk = false;
  const refused = await signIn('google');
  tokenOk = true;
  assert.equal(refused.key, 'social-error');
});

test('a sign-up token cannot be used as a session and a session token cannot finish a sign-up', async () => {
  profile = { sub: 'g-2', email: 'new@example.com', email_verified: true, name: 'New' };
  const s = await signIn('google');
  const asSession = await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${s.value}` } });
  assert.equal(asSession.status, 401);
  const reg = await post('/v1/auth/login', { email: 'sam@example.com', password: 'password123' });
  assert.equal((await post('/v1/auth/social/complete', { token: reg.body.token, company: 'X', sector: 'trading', stateCode: '29' })).status, 400);
});
