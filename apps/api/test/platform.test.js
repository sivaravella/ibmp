import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { createPlatformAdmin } from '../src/platform.js';
import { addDays } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';

const T = todayFn();
const KEY = 'test-admin-key-0123456789abcdef';
let pool, call, seq = 0;

before(async () => {
  process.env.ADMIN_API_KEY = KEY;
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels: simulatedChannels() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok, headers = {}) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };

const PW = 'a-long-test-password';
const admin = async (role = 'owner') => {
  const email = `pa${++seq}@platform.test`;
  await createPlatformAdmin(pool, { email, name: `Admin ${seq}`, password: PW, role, rounds: 4 });
  const { token } = await ok(call('POST', '/platform/login', { email, password: PW }));
  return { token, email };
};
const biz = async (extra = {}) => (await call('POST', '/auth/register', { name: `Owner ${++seq}`, email: `biz${seq}@example.com`, password: 'password123', company: `Biz Co ${seq}`, sector: 'trading', stateCode: '29', ...extra }, null)).body.token;
const consultant = (body = 'ICAI', extra = {}) => biz({ accountType: 'consultant', consultant: { body, membershipNo: '123456', registeredName: 'Test Person' }, ...extra });
const cidOf = async (email) => (await pool.query('SELECT company_id FROM users WHERE email=$1', [email])).rows[0].company_id;

test('creating platform admins: validated, unique, and never through public registration', async () => {
  const mk = (o) => createPlatformAdmin(pool, { email: 'x@platform.test', name: 'X', password: PW, rounds: 4, ...o });
  await assert.rejects(() => mk({ password: 'short' }), /at least 12/);
  await assert.rejects(() => mk({ email: 'nope' }), /valid email/);
  await assert.rejects(() => mk({ role: 'god' }), /Role must be/);
  await assert.rejects(() => mk({ name: ' ' }), /name is required/);
  const a = await mk({ email: 'First@Platform.Test' });
  assert.deepEqual([a.email, a.role], ['first@platform.test', 'owner']);
  await assert.rejects(() => mk({ email: 'first@platform.test' }), /already exists/);
  // the key-guarded bootstrap endpoint
  assert.equal((await call('POST', '/admin/platform-admins', { email: 'b@platform.test', name: 'B', password: PW })).status, 401);
  const viaKey = await call('POST', '/admin/platform-admins', { email: 'b@platform.test', name: 'B', password: PW, role: 'support' }, null, { 'x-admin-key': KEY });
  assert.deepEqual([viaKey.status, viaKey.body.role], [201, 'support']);
  assert.equal((await call('POST', '/admin/platform-admins', { email: 'c@platform.test', name: 'C', password: 'short' }, null, { 'x-admin-key': KEY })).status, 400);
  // a business registration cannot create one, whatever it asks for
  assert.equal((await call('POST', '/auth/register', { name: 'Eve', email: 'eve@platform.test', password: PW, company: 'E', sector: 'trading', stateCode: '29', role: 'owner', platform: true }, null)).status, 201);
  assert.equal((await call('POST', '/platform/login', { email: 'eve@platform.test', password: PW })).status, 401);
});

test('sign-in: generic errors, lock-out after repeated failures, switched-off admins, and a platform token only for the platform', async () => {
  const { token, email } = await admin();
  const bad = await call('POST', '/platform/login', { email, password: 'wrong-password-1' });
  const unknown = await call('POST', '/platform/login', { email: 'nobody@platform.test', password: 'wrong-password-1' });
  assert.deepEqual([bad.status, unknown.status, bad.body.error], [401, 401, unknown.body.error], 'an unknown email looks like a wrong password');
  assert.equal((await call('POST', '/platform/login', { email: 'not-an-email', password: 'x' })).status, 400);

  // five wrong passwords lock the account, even for the right password
  const victim = await admin();
  for (let i = 0; i < 5; i++) await call('POST', '/platform/login', { email: victim.email, password: `wrong-${i}` });
  const locked = await call('POST', '/platform/login', { email: victim.email, password: PW });
  assert.deepEqual([locked.status, locked.body.code], [429, 'LOCKED']);
  await pool.query('UPDATE platform_admins SET locked_until=$1 WHERE email=$2', [new Date(Date.now() - 1000), victim.email]);
  assert.equal((await call('POST', '/platform/login', { email: victim.email, password: PW })).status, 200, 'the lock expires');
  // a success clears the count
  const other = await admin();
  for (let i = 0; i < 4; i++) await call('POST', '/platform/login', { email: other.email, password: 'wrong-password-1' });
  await ok(call('POST', '/platform/login', { email: other.email, password: PW }));
  await call('POST', '/platform/login', { email: other.email, password: 'wrong-password-1' });
  assert.equal((await call('POST', '/platform/login', { email: other.email, password: PW })).status, 200);

  // tokens do not cross over
  const business = await biz();
  assert.equal((await call('GET', '/platform/me', undefined, business)).status, 401, 'a business token is not a platform token');
  assert.equal((await call('GET', '/parties', undefined, token)).status, 401, 'a platform token is not a business token');
  assert.equal((await call('GET', '/platform/me')).status, 401);
  assert.equal((await call('GET', '/platform/overview', undefined, 'garbage')).status, 401);
  assert.deepEqual((await ok(call('GET', '/platform/me', undefined, token))).role, 'owner');
});

test('password change: needs the current one, a long new one, and is audited', async () => {
  const { token, email } = await admin();
  assert.equal((await call('POST', '/platform/password', { current: 'wrong', next: 'another-long-password' }, token)).status, 400);
  assert.equal((await call('POST', '/platform/password', { current: PW, next: 'short' }, token)).status, 400);
  await ok(call('POST', '/platform/password', { current: PW, next: 'another-long-password' }, token));
  assert.equal((await call('POST', '/platform/login', { email, password: PW })).status, 401);
  assert.equal((await call('POST', '/platform/login', { email, password: 'another-long-password' })).status, 200);
  assert.ok((await ok(call('GET', '/platform/audit', undefined, token))).some((a) => a.action === 'password_changed' && a.admin === email));
});

test('overview: people, companies, subscriptions, revenue and consultants', async () => {
  const { token } = await admin();
  const before = await ok(call('GET', '/platform/overview', undefined, token));
  await biz();
  await consultant();
  await biz();
  const payingId = await cidOf(`biz${seq}@example.com`);
  await pool.query("UPDATE subscriptions SET plan_code='starter', period_start=$1, period_end=$2 WHERE company_id=$3", [T, addDays(T, 29), payingId]);
  await pool.query("INSERT INTO billing_invoices (company_id, number, plan_code, months, kind, period_start, period_end, base, taxable, cgst, sgst, igst, total, status, paid_on) VALUES ($1,'IBMP-9001','starter',1,'new',$2,$3,999,999,89.91,89.91,0,1178.82,'paid',$2)", [payingId, T, addDays(T, 29)]);
  const now = await ok(call('GET', '/platform/overview', undefined, token));
  assert.equal(now.users.total - before.users.total, 3);
  assert.equal(now.users.consultant - before.users.consultant, 1);
  assert.equal(now.companies.total - before.companies.total, 3);
  assert.equal(now.companies.signupsLast7 - before.companies.signupsLast7, 3);
  assert.equal((now.subscriptions.byStatus.trialing ?? 0) - (before.subscriptions.byStatus.trialing ?? 0), 2);
  assert.equal((now.subscriptions.activeByPlan.starter ?? 0) - (before.subscriptions.activeByPlan.starter ?? 0), 1);
  assert.equal(now.revenue.invoicesPaid - before.revenue.invoicesPaid, 1);
  assert.equal(Math.round(now.revenue.taxableTotal - before.revenue.taxableTotal), 999);
  assert.equal(Math.round(now.revenue.grossLast30 - before.revenue.grossLast30), 1179);
  assert.equal(now.consultants.pending - before.consultants.pending, 1);
  assert.equal(now.recentCompanies.length, 5);
  assert.equal((await call('GET', '/platform/overview')).status, 401);
});

test('consultants: list, verify, reject with a reason, reopen; support staff can look but not change; everything is audited', async () => {
  const { token } = await admin();
  const support = await admin('support');
  const t = await consultant('ICSI');
  const email = `biz${seq}@example.com`;
  const userId = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  const list = await ok(call('GET', '/platform/consultants?status=pending', undefined, token));
  const mine = list.find((c) => c.email === email);
  assert.deepEqual([mine.body, mine.membershipNo, mine.status, mine.clientCompanies], ['ICSI', '123456', 'pending', 0]);
  assert.equal((await call('GET', '/platform/consultants', undefined, support.token)).status, 200);

  const asSupport = await call('POST', `/platform/consultants/${userId}/decision`, { status: 'verified' }, support.token);
  assert.deepEqual([asSupport.status, asSupport.body.code], [403, 'READ_ONLY']);
  assert.equal((await call('POST', `/platform/consultants/${userId}/decision`, { status: 'rejected' }, token)).status, 400, 'a rejection needs a reason');
  assert.equal((await call('POST', `/platform/consultants/${userId}/decision`, { status: 'maybe' }, token)).status, 400);
  assert.equal((await call('POST', '/platform/consultants/999999/decision', { status: 'verified' }, token)).status, 404);
  await ok(call('POST', `/platform/consultants/${userId}/decision`, { status: 'rejected', note: 'Membership number not found' }, token));
  let now = (await ok(call('GET', '/platform/consultants?status=rejected', undefined, token))).find((c) => c.email === email);
  assert.deepEqual([now.status, now.note], ['rejected', 'Membership number not found']);
  await ok(call('POST', `/platform/consultants/${userId}/decision`, { status: 'verified', note: 'Checked on the ICSI register' }, token));
  now = (await ok(call('GET', '/platform/consultants?status=verified', undefined, token))).find((c) => c.email === email);
  assert.deepEqual([now.status, now.verifiedAt], ['verified', T]);
  // the consultant sees the outcome in their own account
  assert.equal((await ok(call('GET', '/account/consultant', undefined, t))).profile.status, 'verified');
  const audit = (await ok(call('GET', '/platform/audit', undefined, token))).filter((a) => a.targetType === 'user' && a.targetId === String(userId));
  assert.deepEqual(audit.map((a) => a.action).reverse(), ['consultant_rejected', 'consultant_verified']);
  assert.deepEqual([audit[1].detail.before, audit[1].detail.note], ['pending', 'Membership number not found']);
});

test('companies: search by name, GSTIN or owner; paging; a detail view that shows accounts and plan, not the books', async () => {
  const { token } = await admin();
  const t = await biz({ company: 'Zebra Findable Traders' });
  const email = `biz${seq}@example.com`;
  const cid = await cidOf(email);
  await biz();
  const byName = await ok(call('GET', '/platform/companies?q=zebra%20findable', undefined, token));
  assert.deepEqual(byName.companies.map((c) => c.id), [cid]);
  assert.deepEqual([byName.companies[0].owner.email, byName.companies[0].plan, byName.companies[0].subscription, byName.companies[0].daysLeft], [email, 'trial', 'trialing', 14]);
  assert.equal((await ok(call('GET', `/platform/companies?q=${email}`, undefined, token))).companies[0].id, cid, 'by owner email');
  assert.equal((await ok(call('GET', '/platform/companies?q=no-such-thing-anywhere', undefined, token))).total, 0);
  const p1 = await ok(call('GET', '/platform/companies?limit=2&page=1', undefined, token));
  const p2 = await ok(call('GET', '/platform/companies?limit=2&page=2', undefined, token));
  assert.ok(p1.total >= 3 && p1.companies.length === 2 && p2.companies.length >= 1);
  assert.ok(p1.companies.every((a) => !p2.companies.some((b) => b.id === a.id)), 'pages do not overlap');
  assert.ok(p1.companies[0].id > p1.companies[1].id, 'newest first');

  await ok(call('POST', '/parties', { type: 'customer', name: 'Some Customer', stateCode: '29' }, t));
  const d = await ok(call('GET', `/platform/companies/${cid}`, undefined, token));
  assert.deepEqual([d.name, d.subscription.status, d.subscription.planName, d.members.length, d.members[0].email, d.suspended], ['Zebra Findable Traders', 'trialing', 'Free Trial', 1, email, null]);
  assert.deepEqual(d.activity, { invoices: 0, purchases: 0, parties: 1, employees: 0 });
  assert.ok(!JSON.stringify(d).includes('Some Customer'), 'no business records');
  assert.equal((await call('GET', '/platform/companies/999999', undefined, token)).status, 404);
});

test('suspending: the company is shut out at once, a consultant\'s clients with it, and it is reversible and audited', async () => {
  const { token } = await admin();
  const support = await admin('support');
  const t = await consultant();
  const email = `biz${seq}@example.com`;
  const home = await cidOf(email);
  assert.equal((await call('GET', '/parties', undefined, t)).status, 200);

  assert.equal((await call('POST', `/platform/companies/${home}/suspend`, { reason: 'x' }, token)).status, 400, 'a reason is required');
  assert.equal((await call('POST', `/platform/companies/${home}/suspend`, { reason: 'Chargeback dispute' }, support.token)).status, 403);
  await ok(call('POST', `/platform/companies/${home}/suspend`, { reason: 'Chargeback dispute' }, token));
  assert.equal((await call('POST', `/platform/companies/${home}/suspend`, { reason: 'Again please' }, token)).status, 409);
  const blocked = await call('GET', '/parties', undefined, t);
  assert.deepEqual([blocked.status, blocked.body.code], [403, 'COMPANY_SUSPENDED']);
  assert.match(blocked.body.error, /Chargeback dispute/);
  const detail = await ok(call('GET', `/platform/companies/${home}`, undefined, token));
  assert.equal(detail.suspended.reason, 'Chargeback dispute');
  assert.equal((await ok(call('GET', `/platform/companies?q=${encodeURIComponent('Biz Co')}`, undefined, token))).companies.find((c) => c.id === home).suspended, true);

  assert.equal((await call('POST', `/platform/companies/${home}/unsuspend`, { reason: 'Resolved' }, support.token)).status, 403);
  await ok(call('POST', `/platform/companies/${home}/unsuspend`, { reason: 'Dispute resolved' }, token));
  assert.equal((await call('POST', `/platform/companies/${home}/unsuspend`, { reason: 'Dispute resolved' }, token)).status, 409);
  assert.equal((await call('GET', '/parties', undefined, t)).status, 200);
  const log = (await ok(call('GET', '/platform/audit', undefined, token))).filter((a) => a.targetId === String(home)).map((a) => [a.action, a.detail.reason]);
  assert.deepEqual(log, [['company_unsuspended', 'Dispute resolved'], ['company_suspended', 'Chargeback dispute']]);
});

test('a client company is suspended with its consultant\'s account, and not otherwise', async () => {
  const { token } = await admin();
  const t = await consultant();
  const home = await cidOf(`biz${seq}@example.com`);
  const client = await ok(call('POST', '/companies', { name: 'Client Two', sector: 'trading', stateCode: '27' }, t));
  const asClient = (await ok(call('POST', '/auth/switch', { companyId: client.id }, t))).token;
  assert.equal((await call('GET', '/parties', undefined, asClient)).status, 200);
  await ok(call('POST', `/platform/companies/${home}/suspend`, { reason: 'Terms breach' }, token));
  assert.equal((await call('GET', '/parties', undefined, asClient)).body.code, 'COMPANY_SUSPENDED');
  await ok(call('POST', `/platform/companies/${home}/unsuspend`, { reason: 'Resolved' }, token));
  await ok(call('POST', `/platform/companies/${client.id}/suspend`, { reason: 'Client misuse' }, token));
  assert.equal((await call('GET', '/parties', undefined, asClient)).body.code, 'COMPANY_SUSPENDED');
  assert.equal((await call('GET', '/parties', undefined, t)).status, 200, 'the consultant\'s own company is unaffected');
});

test('trial extension and complimentary plans: the right account, a reason, an audit trail and no invoice', async () => {
  const { token } = await admin();
  const support = await admin('support');
  const t = await biz();
  const cid = await cidOf(`biz${seq}@example.com`);
  const ext = await ok(call('POST', `/platform/companies/${cid}/extend-trial`, { days: 10, reason: 'Onboarding delay' }, token));
  assert.equal(ext.trialEnds, addDays(T, 24), '14 days left plus 10');
  assert.equal((await call('POST', `/platform/companies/${cid}/extend-trial`, { days: 0, reason: 'zero days' }, token)).status, 400);
  assert.equal((await call('POST', `/platform/companies/${cid}/extend-trial`, { days: 200, reason: 'too long' }, token)).status, 400);
  assert.equal((await call('POST', `/platform/companies/${cid}/extend-trial`, { days: 5 }, token)).status, 400, 'a reason is required');
  assert.equal((await call('POST', `/platform/companies/${cid}/extend-trial`, { days: 5, reason: 'Support goodwill' }, support.token)).status, 403);
  assert.equal((await ok(call('GET', '/billing/subscription', undefined, t))).trial_ends ?? (await ok(call('GET', '/billing/subscription', undefined, t))).trialEnds, addDays(T, 24));

  // a plan for the wrong kind of account, an unknown plan, the trial itself
  assert.equal((await call('POST', `/platform/companies/${cid}/grant`, { planCode: 'consultant_5', days: 30, reason: 'Wrong audience' }, token)).body.code, 'PLAN_AUDIENCE');
  assert.equal((await call('POST', `/platform/companies/${cid}/grant`, { planCode: 'trial', days: 30, reason: 'Not purchasable' }, token)).status, 400);
  assert.equal((await call('POST', `/platform/companies/${cid}/grant`, { planCode: 'nope', days: 30, reason: 'Unknown plan' }, token)).status, 400);
  const g = await ok(call('POST', `/platform/companies/${cid}/grant`, { planCode: 'professional', days: 30, reason: 'Pilot customer' }, token));
  assert.deepEqual([g.periodStart, g.periodEnd], [T, addDays(T, 29)]);
  const d = await ok(call('GET', `/platform/companies/${cid}`, undefined, token));
  assert.deepEqual([d.subscription.status, d.subscription.plan, d.subscription.daysLeft, d.invoices.length], ['active', 'professional', 29, 0]);
  assert.equal((await ok(call('GET', '/billing/subscription', undefined, t))).status, 'active', 'the customer sees it too');
  assert.equal((await call('POST', `/platform/companies/${cid}/extend-trial`, { days: 5, reason: 'On a paid plan now' }, token)).status, 409);
  const entry = (await ok(call('GET', '/platform/audit', undefined, token))).find((a) => a.action === 'plan_granted' && a.targetId === String(cid));
  assert.deepEqual([entry.detail.plan, entry.detail.before.plan, entry.detail.reason, entry.detail.note], ['professional', 'trial', 'Pilot customer', 'complimentary: no invoice raised']);

  // consultants get consultant plans, and a client company has no subscription of its own
  const ct = await consultant();
  const home = await cidOf(`biz${seq}@example.com`);
  const client = await ok(call('POST', '/companies', { name: 'Client Three', sector: 'trading', stateCode: '27' }, ct));
  assert.equal((await ok(call('POST', `/platform/companies/${home}/grant`, { planCode: 'consultant_5', days: 90, reason: 'Partner programme' }, token))).periodEnd, addDays(T, 89));
  assert.equal((await call('POST', `/platform/companies/${client.id}/grant`, { planCode: 'consultant_5', days: 30, reason: 'Wrong company' }, token)).body.code, 'CLIENT_COMPANY');
  const cd = await ok(call('GET', `/platform/companies/${home}`, undefined, token));
  assert.deepEqual(cd.clients.map((c) => c.name), ['Client Three']);
});

test('billing view lists paid invoices platform-wide; the audit log hides sign-ins unless asked', async () => {
  const { token, email } = await admin();
  await biz();
  const cid = await cidOf(`biz${seq}@example.com`);
  await pool.query("INSERT INTO billing_invoices (company_id, number, plan_code, months, kind, period_start, period_end, base, taxable, cgst, sgst, igst, total, status, paid_on, provider) VALUES ($1,'IBMP-9100','starter',3,'new',$2,$3,2997,2997,269.73,269.73,0,3536.46,'paid',$2,'razorpay')", [cid, T, addDays(T, 89)]);
  await pool.query("INSERT INTO billing_invoices (company_id, plan_code, months, kind, period_start, period_end, base, taxable, total, status) VALUES ($1,'starter',1,'new',$2,$3,999,999,1178.82,'pending')", [cid, T, T]);
  const b = await ok(call('GET', '/platform/billing', undefined, token));
  const row = b.invoices.find((i) => i.number === 'IBMP-9100');
  assert.deepEqual([row.company.startsWith('Biz Co'), row.plan, row.months, row.taxable, row.gst, row.total, row.provider], [true, 'starter', 3, 2997, 539.46, 3536.46, 'razorpay']);
  assert.ok(b.pendingCheckouts >= 1 && b.invoices.every((i) => i.number), 'only paid, numbered invoices');
  const quiet = await ok(call('GET', '/platform/audit', undefined, token));
  assert.ok(quiet.every((a) => a.action !== 'login'));
  const loud = await ok(call('GET', '/platform/audit?logins=true', undefined, token));
  assert.ok(loud.some((a) => a.action === 'login' && a.admin === email));
});

test('platform staff: only owners list and switch accounts off; switching off takes effect at once; not your own', async () => {
  const owner = await admin();
  const staff = await admin('support');
  assert.equal((await call('GET', '/platform/admins', undefined, staff.token)).status, 403);
  const list = await ok(call('GET', '/platform/admins', undefined, owner.token));
  const target = list.find((a) => a.email === staff.email);
  assert.deepEqual([target.role, target.active], ['support', true]);
  assert.ok(!JSON.stringify(list).includes('password'), 'no hashes');
  assert.equal((await call('PUT', `/platform/admins/${list.find((a) => a.email === owner.email).id}`, { active: false }, owner.token)).status, 400);
  await ok(call('PUT', `/platform/admins/${target.id}`, { active: false }, owner.token));
  assert.equal((await call('GET', '/platform/me', undefined, staff.token)).status, 401, 'an existing token stops working immediately');
  assert.equal((await call('POST', '/platform/login', { email: staff.email, password: PW })).status, 401);
  await ok(call('PUT', `/platform/admins/${target.id}`, { active: true }, owner.token));
  assert.equal((await call('POST', '/platform/login', { email: staff.email, password: PW })).status, 200);
  assert.equal((await call('PUT', '/platform/admins/999999', { active: true }, owner.token)).status, 404);
});
