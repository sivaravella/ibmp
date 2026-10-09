import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { signPurposeToken } from '../src/auth.js';
import { gstinCheckChar } from '../src/gstin.js';
import { fyOf } from '../src/compliance.js';
import { today, ymd } from '../src/util.js';
import { registerBusiness, parseBusiness } from '../src/onboarding.js';
import { makePdf } from './support/minipdf.js';

/** A fresh database and server (the per-network-address limit would otherwise be shared by every test). */
async function boot({ channels = simulatedChannels() } = {}) {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels }).listen(0);
  server.unref();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(origin + path, { method, headers: { ...(isBuf || body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { pool, origin, channels, get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h) };
}

const withCheck = (b14) => b14 + gstinCheckChar(b14);
const GSTIN = withCheck('36AAGCG1002R1Z');
const PAN = 'AAGCG1002R';

/** The whole email step: ask for a code, read it from the simulated inbox, verify. */
async function verified(app, email) {
  const sent = await app.post('/v1/onboarding/email-otp', { email });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const v = await app.post('/v1/onboarding/verify-email', { email, code: sent.body.devCode });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body.emailToken;
}

const baseBody = (emailToken, extra = {}) => ({
  emailToken, name: 'Rama Rao', password: 'correct-horse-1', company: 'Rama Traders', entityType: 'proprietorship', nature: 'trading',
  gstin: GSTIN, ...extra,
});

test('meta lists everything the wizard shows', async () => {
  const app = await boot();
  const r = await app.get('/v1/onboarding/meta');
  assert.equal(r.status, 200);
  const m = r.body;
  assert.deepEqual(m.entityTypes.map((e) => e.value), ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'opc', 'huf', 'trust', 'society', 'other']);
  assert.match(m.entityTypes[0].description, /Single owner/);
  assert.deepEqual(m.natures.map((n) => n.value), ['trading', 'manufacturing', 'service']);
  assert.ok(m.industries.length > 60 && m.industries.every((i) => i.code && i.name && i.sector));
  assert.ok(m.industries.some((i) => i.code === '3510' && i.name === 'Pharmaceuticals' && i.sector === 'Healthcare'));
  assert.ok(m.sectors.some((s) => s.value === 'trading') && m.sectors.every((s) => s.label));
  assert.equal(m.turnoverSlabs.length, 4);
  assert.equal(m.employeeRanges.length, 4);
  assert.deepEqual(m.plans.map((p) => p.code), ['trial', 'starter', 'professional', 'enterprise']);
  assert.equal(m.plans[1].monthly, 999);
  assert.ok(m.plans.every((p) => Array.isArray(p.highlights)));
  assert.equal(m.trialDays, 14);
});

test('the email code: sent by email, hashed in the database, works once', async () => {
  const app = await boot();
  const r = await app.post('/v1/onboarding/email-otp', { email: 'New.Owner@Example.com ' });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body, devCode: undefined }, { sent: true, expiresInMinutes: 10, resendAfterSeconds: 45, devCode: undefined });
  assert.match(r.body.devCode, /^\d{6}$/);
  const mail = app.channels.sent.at(-1);
  assert.equal(mail.to, 'new.owner@example.com');
  assert.equal(mail.subject, 'Your IBMP verification code');
  assert.ok(mail.text.includes(r.body.devCode) && mail.text.includes('10 minutes') && mail.html.includes(r.body.devCode));
  const row = (await app.pool.query("SELECT * FROM onboarding_otps WHERE email='new.owner@example.com'")).rows[0];
  assert.notEqual(row.code_hash, r.body.devCode);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  // an email with spaces and different case is the same address
  const v = await app.post('/v1/onboarding/verify-email', { email: 'NEW.owner@example.com', code: ` ${r.body.devCode.slice(0, 3)} ${r.body.devCode.slice(3)} ` });
  assert.equal(v.status, 200);
  const p = jwt.decode(v.body.emailToken);
  assert.equal(p.typ, 'onb-email');
  assert.equal(p.email, 'new.owner@example.com');
  assert.ok(p.exp - p.iat === 3600);
  // a second use of the same code fails
  const again = await app.post('/v1/onboarding/verify-email', { email: 'new.owner@example.com', code: r.body.devCode });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'OTP_NONE');
});

test('a bad email address is refused', async () => {
  const app = await boot();
  assert.equal((await app.post('/v1/onboarding/email-otp', { email: 'not-an-email' })).status, 400);
  assert.equal((await app.post('/v1/onboarding/email-otp', {})).status, 400);
  assert.equal((await app.post('/v1/onboarding/verify-email', { email: 'nobody@example.com', code: '123456' })).body.code, 'OTP_NONE');
});

test('wrong codes count down and lock the code; a new code starts afresh', async () => {
  const app = await boot();
  const email = 'lock@example.com';
  const r = await app.post('/v1/onboarding/email-otp', { email });
  const wrong = r.body.devCode === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    const w = await app.post('/v1/onboarding/verify-email', { email, code: wrong });
    assert.equal(w.status, 400);
    assert.equal(w.body.code, 'OTP_WRONG');
    assert.equal(w.body.attemptsLeft, left);
    assert.match(w.body.error, /tr(?:y|ies) left/);
  }
  const last = await app.post('/v1/onboarding/verify-email', { email, code: wrong });
  assert.equal(last.status, 400);
  assert.equal(last.body.attemptsLeft, 0);
  assert.equal(last.body.code, 'OTP_LOCKED');
  // even the right code no longer works
  const right = await app.post('/v1/onboarding/verify-email', { email, code: r.body.devCode });
  assert.equal(right.status, 400);
  assert.equal(right.body.code, 'OTP_LOCKED');
  // a new code replaces the locked one, and the old one is dead
  const r2 = await app.post('/v1/onboarding/email-otp', { email });
  const old = await app.post('/v1/onboarding/verify-email', { email, code: r.body.devCode === r2.body.devCode ? '999999' : r.body.devCode });
  assert.equal(old.status, 400);
  assert.equal(old.body.attemptsLeft, 4);
  assert.equal((await app.post('/v1/onboarding/verify-email', { email, code: r2.body.devCode })).status, 200);
});

test('a code expires after 10 minutes', async () => {
  const app = await boot();
  const email = 'late@example.com';
  const r = await app.post('/v1/onboarding/email-otp', { email });
  const row = (await app.pool.query('SELECT expires_at, created_at FROM onboarding_otps WHERE email=$1', [email])).rows[0];
  assert.equal(Number(row.expires_at) - Number(row.created_at), 10 * 60_000);
  await app.pool.query('UPDATE onboarding_otps SET expires_at=$1 WHERE email=$2', [Date.now() - 1000, email]);
  const v = await app.post('/v1/onboarding/verify-email', { email, code: r.body.devCode });
  assert.equal(v.status, 400);
  assert.equal(v.body.code, 'OTP_EXPIRED');
  assert.equal(v.body.attemptsLeft, 0);
});

test('codes are limited to 5 an hour per email and 20 per network address', async () => {
  const app = await boot();
  for (let i = 0; i < 5; i++) assert.equal((await app.post('/v1/onboarding/email-otp', { email: 'busy@example.com' })).status, 200);
  const six = await app.post('/v1/onboarding/email-otp', { email: 'busy@example.com' });
  assert.equal(six.status, 429);
  assert.match(six.body.error, /Too many codes/);
  // the same address is 5 of the 20 for this network address; 15 more addresses use the rest
  for (let i = 0; i < 15; i++) assert.equal((await app.post('/v1/onboarding/email-otp', { email: `p${i}@example.com` })).status, 200);
  const over = await app.post('/v1/onboarding/email-otp', { email: 'p99@example.com' });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /network/);
  // an hour later the limits are clear
  await app.pool.query('UPDATE onboarding_otp_sends SET sent_at = sent_at - 3700000');
  assert.equal((await app.post('/v1/onboarding/email-otp', { email: 'busy@example.com' })).status, 200);
});

test('an email that already has an account is told to sign in', async () => {
  const app = await boot();
  const reg = await app.post('/v1/auth/register', { name: 'Old', email: 'old@example.com', password: 'password123', company: 'Old Co', sector: 'trading', stateCode: '29' });
  assert.equal(reg.status, 201);
  const r = await app.post('/v1/onboarding/email-otp', { email: 'OLD@example.com' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMAIL_TAKEN');
  assert.equal(app.channels.sent.length, 0);
});

test('without an email channel no code can be sent', async () => {
  const app = await boot({ channels: { ...simulatedChannels(), email: null } });
  const r = await app.post('/v1/onboarding/email-otp', { email: 'x@example.com' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'EMAIL_OFF');
  assert.equal(r.body.error, 'Email is not set up on this server, so a verification code cannot be sent.');
});

test('a real (non-simulated) email channel never reveals the code', async () => {
  const sent = [];
  const live = { ...simulatedChannels(), email: { name: 'smtp', mode: 'live', send: async (m) => { sent.push(m); return { id: '1' }; } } };
  const app = await boot({ channels: live });
  const r = await app.post('/v1/onboarding/email-otp', { email: 'live@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.devCode, undefined);
  assert.match(sent[0].text, /\d{6}/);
});

test('a failed send leaves no usable code and says so', async () => {
  const broken = { ...simulatedChannels(), email: { name: 'smtp', mode: 'live', send: async () => { throw new Error('smtp down'); } } };
  const app = await boot({ channels: broken });
  const r = await app.post('/v1/onboarding/email-otp', { email: 'down@example.com' });
  assert.equal(r.status, 502);
  assert.equal((await app.pool.query('SELECT 1 FROM onboarding_otps')).rowCount, 0);
});

test('complete creates the company, owner, profile, onboarding facts and compliance settings', async () => {
  const app = await boot();
  const emailToken = await verified(app, 'rama@example.com');
  const r = await app.post('/v1/onboarding/complete', baseBody(emailToken, {
    mobile: '+91 98765 43210', industry: { code: '2540', name: 'ignored: the list wins' }, legalName: 'RAMA TRADERS', tradeName: 'Rama', addr1: '8-2-120', addr2: 'Banjara Hills', loc: 'Hyderabad', pin: '500034',
    phone: '040 1234 5678', website: 'www.rama.example', contactPerson: 'Rama Rao', secondaryMobile: '9123456789', secondaryEmail: 'Accounts@Rama.example', udyam: 'UDYAM-TS-01-1234567',
    turnoverSlab: '1_5cr_to_5cr', employeeRange: '11_50', preferredPlan: 'professional', documentsUsed: ['gst', 'gst', 'coi'],
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.company.name, 'Rama Traders');
  const cid = r.body.company.id;
  const fyStart = `${fyOf(today()).slice(0, 4)}-04-01`;
  assert.equal(r.body.summary.complianceCalendarFrom, fyStart);
  assert.equal(r.body.summary.invoiceTemplate, true);
  assert.equal(r.body.summary.preferredPlan, 'professional');
  assert.ok(r.body.summary.accountsCreated > 10);
  assert.match(r.body.summary.trialEnds, /^\d{4}-\d{2}-\d{2}$/);

  const me = await app.get('/v1/auth/me', { authorization: `Bearer ${r.body.token}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'rama@example.com');
  assert.equal(me.body.role, 'owner');
  assert.equal(me.body.gstin, GSTIN);
  assert.equal(me.body.sector, 'textile');                // Apparel & Textiles
  assert.equal(me.body.stateCode, '36');

  const co = (await app.pool.query('SELECT * FROM companies WHERE id=$1', [cid])).rows[0];
  assert.equal(co.pan, PAN);
  assert.equal(co.legal_name, 'RAMA TRADERS');
  assert.equal(co.entity_type, 'proprietorship');
  assert.equal(co.email, 'rama@example.com');
  assert.equal(co.phone, '4012345678');
  assert.equal(co.pin, '500034');
  assert.equal(co.udyam, 'UDYAM-TS-01-1234567');
  const ob = (await app.pool.query('SELECT * FROM company_onboarding WHERE company_id=$1', [cid])).rows[0];
  assert.deepEqual([ob.nature, ob.industry_code, ob.industry_name, ob.turnover_slab, ob.employee_range, ob.preferred_plan, ob.mobile, ob.mobile_verified, ob.secondary_mobile, ob.secondary_email, ob.documents_used],
    ['trading', '2540', 'Apparel & Textiles', '1_5cr_to_5cr', '11_50', 'professional', '9876543210', false, '9123456789', 'accounts@rama.example', 'gst,coi']);
  const cs = (await app.pool.query('SELECT * FROM compliance_settings WHERE company_id=$1', [cid])).rows[0];
  assert.equal(ymd(cs.track_from), fyStart);
  assert.equal(cs.tds_deductor, false);
  assert.equal(cs.gst_frequency, 'monthly');
  const sub = (await app.pool.query('SELECT plan_code FROM subscriptions WHERE company_id=$1', [cid])).rows[0];
  assert.equal(sub.plan_code, 'trial');

  // the owner can read their onboarding facts; the mobile is not verified
  const facts = await app.get('/v1/company/onboarding', { authorization: `Bearer ${r.body.token}` });
  assert.equal(facts.status, 200);
  assert.deepEqual([facts.body.recorded, facts.body.nature, facts.body.industryName, facts.body.mobile, facts.body.mobileVerified, facts.body.documentsUsed], [true, 'trading', 'Apparel & Textiles', '9876543210', false, ['gst', 'coi']]);
  assert.equal((await app.get('/v1/company/onboarding')).status, 401);
  // the password works for a normal sign-in, and the email can no longer be used to sign up
  assert.equal((await app.post('/v1/auth/login', { email: 'rama@example.com', password: 'correct-horse-1' })).status, 200);
  assert.equal((await app.post('/v1/onboarding/email-otp', { email: 'rama@example.com' })).status, 409);
  // the compliance calendar works at once
  const cal = await app.get('/v1/compliance', { authorization: `Bearer ${r.body.token}` });
  assert.equal(cal.status, 200);
});

test('the business type defaults from the industry or the nature, and can be set explicitly', async () => {
  const app = await boot();
  const a = await app.post('/v1/onboarding/complete', baseBody(await verified(app, 'a1@example.com'), { nature: 'manufacturing', gstin: undefined, stateCode: '29' }));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await app.get('/v1/auth/me', { authorization: `Bearer ${a.body.token}` })).body.sector, 'manufacturing');
  const b = await app.post('/v1/onboarding/complete', baseBody(await verified(app, 'b1@example.com'), { gstin: undefined, stateCode: '29', industry: { code: '3560' }, sector: 'wellness' }));
  assert.equal((await app.get('/v1/auth/me', { authorization: `Bearer ${b.body.token}` })).body.sector, 'wellness');
  const c = await app.post('/v1/onboarding/complete', baseBody(await verified(app, 'c1@example.com'), { gstin: undefined, stateCode: '29', industry: { code: '3560' } }));
  assert.equal((await app.get('/v1/auth/me', { authorization: `Bearer ${c.body.token}` })).body.sector, 'pharmacy');
  assert.equal((await app.get('/v1/auth/me', { authorization: `Bearer ${c.body.token}` })).body.stateCode, '29');
});

test('industry: a custom one needs a name; an unknown code alone is refused', async () => {
  const app = await boot();
  const t = await verified(app, 'ind@example.com');
  const bad = await app.post('/v1/onboarding/complete', baseBody(t, { industry: { code: '9999' } }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not in the list/);
  const long = await app.post('/v1/onboarding/complete', baseBody(t, { industry: { name: 'x'.repeat(81) } }));
  assert.equal(long.status, 400);
  const ok = await app.post('/v1/onboarding/complete', baseBody(t, { industry: { code: 'CUST1234', name: 'Drone photography' } }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = (await app.pool.query('SELECT industry_code, industry_name FROM company_onboarding WHERE company_id=$1', [ok.body.company.id])).rows[0];
  assert.deepEqual([row.industry_code, row.industry_name], ['CUST1234', 'Drone photography']);
});

test('GSTIN rules: check character, PAN agreement, state from the GSTIN, or a state when there is none', async () => {
  const app = await boot();
  const t = await verified(app, 'gst@example.com');
  const wrongCheck = GSTIN.slice(0, 14) + (GSTIN[14] === 'A' ? 'B' : 'A');
  const a = await app.post('/v1/onboarding/complete', baseBody(t, { gstin: wrongCheck }));
  assert.equal(a.status, 400);
  assert.match(a.body.error, /check-character/);
  const b = await app.post('/v1/onboarding/complete', baseBody(t, { pan: 'ABCDE1234F' }));
  assert.equal(b.status, 400);
  assert.match(b.body.error, /AAGCG1002R/);
  const c = await app.post('/v1/onboarding/complete', baseBody(t, { gstin: undefined }));
  assert.equal(c.status, 400);
  assert.match(c.body.error, /GSTIN, or choose the state/);
  const d = await app.post('/v1/onboarding/complete', baseBody(t, { gstin: undefined, stateCode: '98' }));
  assert.equal(d.status, 400);
  const e = await app.post('/v1/onboarding/complete', baseBody(t, { gstin: undefined, pan: 'bad' }));
  assert.equal(e.status, 400);
  assert.equal((await app.pool.query('SELECT 1 FROM users')).rowCount, 0);           // nothing was created by any of these
  // the GSTIN's state wins over a state sent with it, and the matching PAN is accepted
  const ok = await app.post('/v1/onboarding/complete', baseBody(t, { stateCode: '29', pan: PAN }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await app.pool.query('SELECT state_code FROM companies WHERE id=$1', [ok.body.company.id])).rows[0].state_code, '36');
});

test('field rules: password, mobile, entity type, nature, logo, PIN', async () => {
  const app = await boot();
  const t = await verified(app, 'rules@example.com');
  const status = async (extra) => (await app.post('/v1/onboarding/complete', baseBody(t, extra))).status;
  assert.equal(await status({ password: 'short' }), 400);
  assert.equal(await status({ mobile: '12345' }), 400);
  assert.equal(await status({ mobile: '5876543210' }), 400);          // Indian mobiles start with 6 to 9
  assert.equal(await status({ entityType: 'sole_prop' }), 400);
  assert.equal(await status({ nature: 'farming' }), 400);
  assert.equal(await status({ pin: '12345' }), 400);
  assert.equal(await status({ logo: 'data:text/html;base64,AAAA' }), 400);
  assert.equal(await status({ preferredPlan: 'free' }), 400);
  assert.equal(await status({ turnoverSlab: 'lots' }), 400);
  assert.equal(await status({ incorporatedOn: '2026-02-31' }), 400);
  assert.equal(await status({ company: '   ' }), 400);
  // blanks are the same as absent; a small logo, a 10-digit mobile with +91 and the date are accepted
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ok = await app.post('/v1/onboarding/complete', baseBody(t, { mobile: '09876543210', legalName: '', pin: '', logo: png, incorporatedOn: '2020-02-29', cin: 'U74999TS2020PTC123456' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const co = (await app.pool.query('SELECT logo, incorporated_on, cin, legal_name FROM companies WHERE id=$1', [ok.body.company.id])).rows[0];
  assert.equal(co.logo, png);
  assert.equal(ymd(co.incorporated_on), '2020-02-29');
  assert.equal(co.legal_name, null);
});

test('the email token must be valid and for the same address; the account email comes from the token', async () => {
  const app = await boot();
  const t = await verified(app, 'mine@example.com');
  const other = await app.post('/v1/onboarding/complete', baseBody(t, { email: 'someone.else@example.com' }));
  assert.equal(other.status, 400);
  assert.equal(other.body.code, 'EMAIL_MISMATCH');
  const forged = await app.post('/v1/onboarding/complete', baseBody(t.slice(0, -3) + 'abc'));
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, 'EMAIL_TOKEN_INVALID');
  // tokens of other purposes are not accepted
  const social = signPurposeToken('social-signup', { p: 'google', sub: '1', email: 'mine@example.com', name: 'M' }, '30m');
  assert.equal((await app.post('/v1/onboarding/complete', baseBody(social))).body.code, 'EMAIL_TOKEN_INVALID');
  const session = (await app.post('/v1/auth/register', { name: 'S', email: 'sess@example.com', password: 'password123', company: 'S Co', sector: 'trading', stateCode: '29' })).body.token;
  assert.equal((await app.post('/v1/onboarding/complete', baseBody(session))).body.code, 'EMAIL_TOKEN_INVALID');
  // an expired email token
  const old = signPurposeToken('onb-email', { email: 'mine@example.com' }, '-1m');
  assert.equal((await app.post('/v1/onboarding/complete', baseBody(old))).status, 400);
  // the account is created for the token's address, whatever the body says about the name
  const ok = await app.post('/v1/onboarding/complete', baseBody(t));
  assert.equal(ok.status, 201);
  assert.equal((await app.pool.query('SELECT email FROM users WHERE company_id=$1', [ok.body.company.id])).rows[0].email, 'mine@example.com');
});

test('the email is taken in the meantime: 409 and nothing is created', async () => {
  const app = await boot();
  const t = await verified(app, 'race@example.com');
  await app.post('/v1/auth/register', { name: 'Fast', email: 'race@example.com', password: 'password123', company: 'Fast Co', sector: 'trading', stateCode: '29' });
  const companiesBefore = (await app.pool.query('SELECT COUNT(*) AS n FROM companies')).rows[0].n;
  const r = await app.post('/v1/onboarding/complete', baseBody(t));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMAIL_TAKEN');
  assert.equal((await app.pool.query('SELECT COUNT(*) AS n FROM companies')).rows[0].n, companiesBefore);
});

test('the sign-up is atomic: a failure after the company exists leaves nothing behind', async (t) => {
  const app = await boot();
  // pg-mem accepts BEGIN and ROLLBACK but does not undo anything; this check is real on PostgreSQL (npm run test:pg).
  await app.pool.query('CREATE TABLE probe (v INTEGER)');
  const c = await app.pool.connect();
  await c.query('BEGIN'); await c.query('INSERT INTO probe VALUES (1)'); await c.query('ROLLBACK'); c.release();
  if ((await app.pool.query('SELECT 1 FROM probe')).rowCount) return t.skip('this database engine does not roll back (checked on PostgreSQL)');
  const b = parseBusiness({ company: 'Atomic Co', entityType: 'llp', nature: 'service', stateCode: '29' });
  const counts = async () => Object.fromEntries(await Promise.all(['companies', 'users', 'accounts', 'subscriptions', 'company_onboarding', 'compliance_settings'].map(async (t) => [t, (await app.pool.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n])));
  const before = await counts();
  await assert.rejects(() => registerBusiness(app.pool, { email: 'atomic@example.com', name: 'A', passwordHash: 'x', b, afterCreate: async () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(await counts(), before);
  assert.equal((await app.pool.query("SELECT 1 FROM users WHERE email='atomic@example.com'")).rowCount, 0);
  // and the same call without the failure works
  const ok = await registerBusiness(app.pool, { email: 'atomic@example.com', name: 'A', passwordHash: 'x', b });
  assert.ok(ok.token && ok.company.id);
});

test('consultant sign-up through the compact form is unchanged', async () => {
  const app = await boot();
  const r = await app.post('/v1/auth/register', { name: 'CA Priya', email: 'ca@example.com', password: 'password123', company: 'Priya & Co', sector: 'service', stateCode: '29', accountType: 'consultant', consultant: { body: 'ICAI', membershipNo: '123456', registeredName: 'Priya Sharma' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.token);
  const noConsultant = await app.post('/v1/auth/register', { name: 'X', email: 'x@example.com', password: 'password123', company: 'X', sector: 'service', stateCode: '29', accountType: 'consultant' });
  assert.equal(noConsultant.status, 400);
});

test('social sign-up can finish through the wizard fields', async () => {
  const app = await boot();
  const token = signPurposeToken('social-signup', { p: 'google', sub: 'g-123', email: 'social@example.com', name: 'Sonia Social' }, '30m');
  const bad = await app.post('/v1/auth/social/complete', { token, company: 'Social Co', entityType: 'llp', nature: 'service' });
  assert.equal(bad.status, 400);                                         // no GSTIN and no state
  const r = await app.post('/v1/auth/social/complete', { token, company: 'Social Co', entityType: 'llp', nature: 'service', industry: { code: '7030' }, gstin: GSTIN, mobile: '9876543210', turnoverSlab: 'below_1_5cr', documentsUsed: ['mca'], preferredPlan: 'starter',
    name: 'ignored', email: 'ignored@example.com', password: 'ignored-pass-1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.token && r.body.company.id && r.body.summary.trialEnds);
  const u = (await app.pool.query('SELECT id, name, email, password_set FROM users WHERE company_id=$1', [r.body.company.id])).rows[0];
  assert.deepEqual([u.name, u.email, u.password_set], ['Sonia Social', 'social@example.com', false]);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM user_identities WHERE user_id=$1 AND provider=$2 AND subject=$3', [u.id, 'google', 'g-123'])).rows[0].n), 1);
  const ob = (await app.pool.query('SELECT nature, industry_name, mobile, mobile_verified, documents_used, preferred_plan FROM company_onboarding WHERE company_id=$1', [r.body.company.id])).rows[0];
  assert.deepEqual(ob, { nature: 'service', industry_name: 'Management Consulting', mobile: '9876543210', mobile_verified: false, documents_used: 'mca', preferred_plan: 'starter' });
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM compliance_settings WHERE company_id=$1', [r.body.company.id])).rows[0].n), 1);
  // the old compact form still works on the same endpoint
  const t2 = signPurposeToken('social-signup', { p: 'linkedin', sub: 'l-9', email: 'compact@example.com', name: 'Compact' }, '30m');
  const compact = await app.post('/v1/auth/social/complete', { token: t2, company: 'Compact Co', sector: 'trading', stateCode: '29' });
  assert.equal(compact.status, 201);
  assert.deepEqual(Object.keys(compact.body), ['token']);
  // a social sign-up whose email got an account in the meantime is refused
  const t3 = signPurposeToken('social-signup', { p: 'google', sub: 'g-124', email: 'social@example.com', name: 'Again' }, '30m');
  const dup = await app.post('/v1/auth/social/complete', { token: t3, company: 'Dup', entityType: 'llp', nature: 'service', stateCode: '29' });
  assert.equal(dup.status, 409);
});

test('extract: needs the email token, reads a text PDF, refuses images and damaged files', async () => {
  const app = await boot();
  const t = await verified(app, 'doc@example.com');
  const pdf = makePdf([`Registration Number : ${GSTIN}`, '1. Legal Name RAMA TRADERS', '2. Trade Name, if any RAMA', '3. Additional trade names, if any', '6. Constitution of Business Proprietorship']);
  const send = (body, headers) => app.post('/v1/onboarding/extract', body, headers);

  assert.equal((await send(pdf, { 'x-kind': 'gst', 'content-type': 'application/pdf' })).status, 403);
  assert.equal((await send(pdf, { 'x-kind': 'gst', 'x-onboarding-token': 'junk' })).status, 403);
  assert.equal((await send(pdf, { 'x-kind': 'passport', 'x-onboarding-token': t })).status, 400);

  const ok = await send(pdf, { 'x-kind': 'gst', 'x-onboarding-token': t, 'x-filename': 'gst.pdf', 'content-type': 'application/pdf' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.supported, true);
  assert.equal(ok.body.kind, 'gst');
  assert.equal(ok.body.found.gstin, GSTIN);
  assert.equal(ok.body.found.pan, PAN);
  assert.equal(ok.body.found.legalName, 'RAMA TRADERS');
  assert.equal(ok.body.found.entityType, 'proprietorship');
  assert.equal(ok.body.found.stateCode, '36');
  assert.match(ok.body.message, /Read \d+ details/);
  // the same content under a JSON content type is still read as a file
  const odd = await send(pdf, { 'x-kind': 'gst', 'x-onboarding-token': t, 'content-type': 'application/octet-stream' });
  assert.equal(odd.status, 200);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const img = await send(png, { 'x-kind': 'gst', 'x-onboarding-token': t, 'x-filename': 'cert.png', 'content-type': 'image/png' });
  assert.equal(img.status, 200);
  assert.deepEqual(img.body, { kind: 'gst', supported: false, found: {}, message: 'We can read text PDFs. For a photo or scan please type the details in the next steps.' });

  const bad = await send(Buffer.from('%PDF-1.4\nnot really a pdf, just junk after a header line'), { 'x-kind': 'coi', 'x-onboarding-token': t, 'content-type': 'application/pdf' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /could not read this PDF/);

  const empty = await send(Buffer.alloc(0), { 'x-kind': 'mca', 'x-onboarding-token': t });
  assert.equal(empty.status, 400);

  // nothing about the file is stored
  const tables = (await app.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name);
  assert.deepEqual(tables.filter((n) => /onboarding/.test(n)).sort(), ['company_onboarding', 'onboarding_otp_sends', 'onboarding_otps']);
});

test('extract: a file over 3 MB is refused', async () => {
  const app = await boot();
  const t = await verified(app, 'big@example.com');
  const r = await app.post('/v1/onboarding/extract', Buffer.alloc(3 * 1024 * 1024 + 10, 65), { 'x-kind': 'gst', 'x-onboarding-token': t });
  assert.equal(r.status, 413);
});
