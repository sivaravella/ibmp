import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { addDays } from '../src/billing.js';
import { companyLimit, quote } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';

const today = todayFn();
let pool, call;
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
let seq = 0;
const PROFILE = { body: 'ICAI', membershipNo: '123456', registeredName: 'Chandra Rao' };

const reg = async ({ consultant = false, gstin, stateCode = '29', name } = {}) => {
  const n = ++seq;
  const r = await call('POST', '/auth/register', {
    name: name ?? `User ${n}`, email: `mc${n}@example.com`, password: 'password123', company: name ?? `Practice ${n}`, sector: 'service',
    ...(gstin ? { gstin } : { stateCode }), ...(consultant ? { accountType: 'consultant', consultant: PROFILE } : {}),
  }, null);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, email: `mc${n}@example.com` };
};
const me = async (t) => (await call('GET', '/auth/me', undefined, t)).body;
const addCompany = (t, name, extra = {}) => call('POST', '/companies', { name, sector: 'trading', stateCode: '27', ...extra }, t);
const switchTo = async (t, companyId) => (await ok(call('POST', '/auth/switch', { companyId }, t))).token;
const buy = async (t, plan, months = 1) => {
  const c = await ok(call('POST', '/billing/checkout', { plan, months }, t));
  await ok(call('POST', '/billing/dev/simulate', { orderId: c.order.orderId, outcome: 'success' }, t));
  return c;
};

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok, headers = {}) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
after(() => { delete process.env.ADMIN_API_KEY; });

test('plan rules: consultants and individuals buy different plans; the slab sets the company limit', () => {
  const args = { months: 1, sub: { plan_code: 'trial', trial_ends: '2026-10-20', period_end: null }, today: '2026-10-06', providerState: '36', customerState: '36' };
  assert.throws(() => quote({ plan: 'consultant_5', accountType: 'individual', ...args }), (e) => e.status === 400 && e.code === 'PLAN_AUDIENCE');
  assert.throws(() => quote({ plan: 'starter', accountType: 'consultant', ...args }), (e) => e.code === 'PLAN_AUDIENCE');
  const q = quote({ plan: 'consultant_5', accountType: 'consultant', ...args });
  assert.deepEqual([q.base, q.total], [399900, 471882], 'placeholder price ₹3,999 + 18% GST');

  const paid = (plan) => ({ plan_code: plan, trial_ends: '2026-09-01', period_end: '2026-10-31' });
  assert.equal(companyLimit({ accountType: 'individual', sub: paid('enterprise'), today: '2026-10-06' }), 1, 'an individual never exceeds one company');
  assert.equal(companyLimit({ accountType: 'consultant', sub: args.sub, today: '2026-10-06' }), 5, 'trial: the smallest slab');
  assert.equal(companyLimit({ accountType: 'consultant', sub: paid('consultant_5'), today: '2026-10-06' }), 5);
  assert.equal(companyLimit({ accountType: 'consultant', sub: paid('consultant_10'), today: '2026-10-06' }), 10);
  // moving up a slab is an upgrade with credit
  const up = quote({ plan: 'consultant_10', accountType: 'consultant', months: 1, sub: paid('consultant_5'), creditable: [{ id: 1, taxable: 3999, period_start: '2026-10-01', period_end: '2026-10-31' }], today: '2026-10-11', providerState: '36', customerState: '36' });
  assert.deepEqual([up.kind, up.credit], ['upgrade', 258000], '3,999 x 20/31 days unused is exactly 2,580');
});

test('registration: consultants must give professional details; individuals are the default', async () => {
  const base = { name: 'C', email: 'c-reg@example.com', password: 'password123', company: 'Reg Co', sector: 'service', stateCode: '29' };
  assert.equal((await call('POST', '/auth/register', { ...base, accountType: 'consultant' }, null)).status, 400, 'no details');
  assert.equal((await call('POST', '/auth/register', { ...base, accountType: 'consultant', consultant: { ...PROFILE, body: 'ICWA' } }, null)).status, 400, 'unknown body');
  assert.equal((await call('POST', '/auth/register', { ...base, accountType: 'consultant', consultant: { ...PROFILE, membershipNo: '#' } }, null)).status, 400, 'bad number');
  assert.equal((await pool.query("SELECT 1 FROM users WHERE email='c-reg@example.com'")).rowCount, 0, 'nothing is created by a rejected registration');

  const ind = await reg();
  const i = await me(ind.token);
  assert.deepEqual([i.accountType, i.consultant, i.companies.length, i.isHome], ['individual', null, 1, true]);

  const con = await reg({ consultant: true });
  const c = await me(con.token);
  assert.deepEqual([c.accountType, c.consultant.status, c.consultant.body, c.consultant.membershipNo, c.consultant.registeredName], ['consultant', 'pending', 'ICAI', '123456', 'Chandra Rao']);
});

test('only consultant accounts can add companies; an individual can become a consultant', async () => {
  const ind = await reg();
  const denied = await addCompany(ind.token, 'Sneaky');
  assert.deepEqual([denied.status, denied.body.code], [403, 'NOT_CONSULTANT']);
  const list = (await call('GET', '/companies', undefined, ind.token)).body;
  assert.deepEqual([list.accountType, list.limit, list.used, list.companies.length], ['individual', 1, 1, 1]);
  assert.equal((await call('GET', '/consultant/overview', undefined, ind.token)).status, 403);

  assert.equal((await call('POST', '/account/consultant', { ...PROFILE, membershipNo: '' }, ind.token)).status, 400);
  assert.equal((await call('POST', '/account/consultant', PROFILE, ind.token)).status, 201);
  assert.equal((await me(ind.token)).accountType, 'consultant');
  assert.equal((await addCompany(ind.token, 'Now allowed')).status, 201);
  assert.equal((await call('POST', '/account/consultant', { ...PROFILE, membershipNo: 'A99999' }, ind.token)).status, 200, 'resubmitting is allowed');
  assert.equal((await call('GET', '/account/consultant', undefined, ind.token)).body.profile.membershipNo, 'A99999');
});

test('clients: create, switch, and strict data isolation between the consultant\'s companies', async () => {
  const con = await reg({ consultant: true, name: 'Rao & Associates' });
  assert.equal((await addCompany(con.token, 'No state', { stateCode: undefined })).status, 400);
  assert.equal((await addCompany(con.token, 'Bad GSTIN', { stateCode: undefined, gstin: '27BAD' })).status, 400);
  const a = await ok(addCompany(con.token, 'Client A'));
  const b = await ok(addCompany(con.token, 'Client B', { gstin: '27ABCDE1234F1Z5', stateCode: undefined }));
  assert.equal(b.stateCode, '27', 'state comes from the GSTIN');

  const info = (await call('GET', '/companies', undefined, con.token)).body;
  assert.deepEqual([info.limit, info.used, info.companies.map((c) => c.name)], [5, 3, ['Rao & Associates', 'Client A', 'Client B']]);
  assert.deepEqual(info.companies.map((c) => [c.isHome, c.active]), [[true, true], [false, false], [false, false]]);

  const home = (await me(con.token));
  const tA = await switchTo(con.token, a.id);
  const meA = await me(tA);
  assert.deepEqual([meA.company, meA.isHome, meA.companyId, meA.homeCompanyId, meA.companies.length], ['Client A', false, a.id, home.companyId, 3]);

  // each company has its own books
  await ok(call('POST', '/parties', { type: 'customer', name: 'Only in A', stateCode: '27' }, tA));
  assert.equal((await call('GET', '/accounts', undefined, tA)).body.length, 30, 'chart of accounts seeded for the client');
  assert.deepEqual((await call('GET', '/parties', undefined, tA)).body.map((p) => p.name), ['Only in A']);
  assert.equal((await call('GET', '/parties', undefined, con.token)).body.length, 0, 'the consultant\'s own company does not see it');
  const tB = await switchTo(con.token, b.id);
  assert.equal((await call('GET', '/parties', undefined, tB)).body.length, 0);

  // other people's companies are out of reach
  const stranger = await reg();
  const strangerCo = (await me(stranger.token)).companyId;
  assert.equal((await call('POST', '/auth/switch', { companyId: strangerCo }, con.token)).status, 403);
  assert.equal((await call('POST', '/auth/switch', { companyId: a.id }, stranger.token)).status, 403);
  assert.equal((await call('POST', '/auth/switch', { companyId: 999999 }, con.token)).status, 403);
  assert.equal((await call('GET', '/parties', undefined, stranger.token)).body.length, 0);

  // logging in again resumes where the consultant left off
  const login = await ok(call('POST', '/auth/login', { email: con.email, password: 'password123' }, null));
  assert.equal((await me(login.token)).company, 'Client B');
});

test('client companies share the consultant\'s subscription; billing is always done as the consultant', async () => {
  const con = await reg({ consultant: true, name: 'Billing Practice' });
  const a = await ok(addCompany(con.token, 'Billed Client'));
  const tA = await switchTo(con.token, a.id);

  // trial: every feature, in the client company too
  assert.equal((await call('POST', '/payroll/employees', { name: 'E', doj: '2020-01-01', basic: 20000 }, tA)).status, 201);

  const s0 = (await call('GET', '/billing/subscription', undefined, tA)).body;
  assert.deepEqual([s0.billedViaOtherCompany, s0.billingCompany.name, s0.accountType, s0.status], [true, 'Billing Practice', 'consultant', 'trialing']);
  assert.deepEqual(s0.plans.map((p) => [p.code, p.monthly, p.maxCompanies]), [['consultant_5', 3999, 5], ['consultant_10', 6999, 10]]);
  assert.equal((await call('GET', '/billing/subscription', undefined, (await reg()).token)).body.plans.length, 3, 'individuals still see their three plans');

  // pay from inside the client company: the invoice belongs to the consultant's company, using its details
  await buy(tA, 'consultant_5');
  const homeInvoices = (await call('GET', '/billing/invoices', undefined, con.token)).body;
  assert.equal(homeInvoices.length, 1);
  assert.equal(homeInvoices[0].customerName, 'Billing Practice');
  assert.equal((await call('GET', '/billing/invoices', undefined, tA)).body.length, 1, 'visible from the client company too');
  const s1 = (await call('GET', '/billing/subscription', undefined, tA)).body;
  assert.deepEqual([s1.planCode, s1.status], ['consultant_5', 'active']);
  assert.equal((await pool.query('SELECT 1 FROM subscriptions WHERE company_id=$1', [a.id])).rowCount, 0, 'the client has no subscription of its own');
  assert.equal((await call('GET', '/payroll/employees', undefined, tA)).status, 200, 'HR is part of the consultant plan');
  assert.equal((await call('GET', '/payroll/employees', undefined, con.token)).status, 200);

  // wrong plan for the account type
  assert.equal((await call('POST', '/billing/quote', { plan: 'starter', months: 1 }, con.token)).status, 400);
  assert.equal((await call('POST', '/billing/quote', { plan: 'consultant_5', months: 1 }, (await reg()).token)).status, 400);
});

test('slab limits: trial and 5-company slab stop at five, the 10 slab at ten', async () => {
  const con = await reg({ consultant: true, name: 'Slab Practice' });
  for (let i = 1; i <= 4; i++) await ok(addCompany(con.token, `Client ${i}`));          // 5 companies in total
  const over = await addCompany(con.token, 'Client 5');
  assert.deepEqual([over.status, over.body.code, over.body.requiredPlan], [402, 'COMPANY_LIMIT', 'consultant_10']);
  assert.match(over.body.error, /allows 5 companies and you are using 5/);

  await buy(con.token, 'consultant_5');
  assert.equal((await addCompany(con.token, 'Client 5')).status, 402, 'the 5-company slab does not help');

  await buy(con.token, 'consultant_10');                                               // an upgrade with credit
  const inv = (await call('GET', '/billing/invoices', undefined, con.token)).body.find((i) => i.planCode === 'consultant_10');
  assert.deepEqual([inv.kind, inv.credit > 0], ['upgrade', true]);
  for (let i = 5; i <= 9; i++) assert.equal((await addCompany(con.token, `Client ${i}`)).status, 201);
  assert.equal((await call('GET', '/companies', undefined, con.token)).body.used, 10);
  const max = await addCompany(con.token, 'Client 10');
  assert.deepEqual([max.status, max.body.code], [409, 'COMPANY_LIMIT_MAX']);
});

test('archiving frees a slot, hides the company and cuts off its tokens; unarchive respects the limit', async () => {
  const con = await reg({ consultant: true, name: 'Archive Practice' });
  const clients = [];
  for (let i = 1; i <= 4; i++) clients.push(await ok(addCompany(con.token, `Arch ${i}`)));
  assert.equal((await addCompany(con.token, 'Full')).status, 402);

  const home = (await me(con.token)).companyId;
  assert.equal((await call('POST', `/companies/${home}/archive`, {}, con.token)).status, 409, 'own company');
  const tFirst = await switchTo(con.token, clients[0].id);
  assert.equal((await call('POST', `/companies/${clients[0].id}/archive`, {}, tFirst)).status, 409, 'cannot archive the company you are in');
  assert.equal((await call('POST', '/companies/999999/archive', {}, con.token)).status, 404);
  const other = await reg({ consultant: true });
  assert.equal((await call('POST', `/companies/${clients[1].id}/archive`, {}, other.token)).status, 404, 'not theirs');

  assert.equal((await call('POST', `/companies/${clients[0].id}/archive`, {}, con.token)).status, 200);
  const list = (await call('GET', '/companies', undefined, con.token)).body;
  assert.equal(list.used, 4);
  assert.equal(list.companies.find((c) => c.id === clients[0].id).archived, true);
  assert.equal((await me(con.token)).companies.length, 4, 'gone from the switcher');

  // the token issued for the company before it was archived stops working, and it cannot be switched into
  const stale = await call('GET', '/parties', undefined, tFirst);
  assert.deepEqual([stale.status, stale.body.code], [403, 'COMPANY_ARCHIVED']);
  const sw = await call('POST', '/auth/switch', { companyId: clients[0].id }, con.token);
  assert.deepEqual([sw.status, sw.body.code], [403, 'COMPANY_ARCHIVED']);

  assert.equal((await addCompany(con.token, 'Took the slot')).status, 201);
  assert.equal((await call('POST', `/companies/${clients[0].id}/unarchive`, {}, con.token)).status, 402, 'no free slot to come back to');
  await ok(call('POST', `/companies/${clients[1].id}/archive`, {}, con.token));
  assert.equal((await call('POST', `/companies/${clients[0].id}/unarchive`, {}, con.token)).status, 200);
  assert.equal((await call('POST', `/companies/${clients[0].id}/unarchive`, {}, con.token)).status, 200, 'idempotent');
  assert.equal((await call('GET', '/parties', undefined, await switchTo(con.token, clients[0].id))).status, 200, 'data survived');
});

test('revoked membership takes effect immediately, even with a valid token', async () => {
  const con = await reg({ consultant: true });
  const a = await ok(addCompany(con.token, 'Revoked'));
  const tA = await switchTo(con.token, a.id);
  assert.equal((await call('GET', '/parties', undefined, tA)).status, 200);
  await pool.query('DELETE FROM user_companies WHERE company_id=$1', [a.id]);
  const r = await call('GET', '/parties', undefined, tA);
  assert.deepEqual([r.status, r.body.code], [403, 'NO_ACCESS']);
  assert.equal((await call('GET', '/auth/me', undefined, tA)).status, 403);
  assert.equal((await call('GET', '/billing/invoices', undefined, tA)).status, 403, 'billing routes check access too');
  assert.equal((await call('GET', '/parties', undefined, con.token)).status, 200, 'their own company is unaffected');
});

test('an expired consultant plan makes every client read-only and blocks new companies', async () => {
  const con = await reg({ consultant: true });
  const a = await ok(addCompany(con.token, 'Lapsed client'));
  const tA = await switchTo(con.token, a.id);
  const home = (await me(con.token)).companyId;
  await pool.query('UPDATE subscriptions SET trial_ends=$1 WHERE company_id=$2', [addDays(today, -1), home]);

  const w = await call('POST', '/parties', { type: 'customer', name: 'Blocked', stateCode: '27' }, tA);
  assert.deepEqual([w.status, w.body.code], [402, 'SUBSCRIPTION_EXPIRED']);
  assert.equal((await call('GET', '/parties', undefined, tA)).status, 200);
  assert.equal((await addCompany(con.token, 'Late client')).status, 402);
  await buy(tA, 'consultant_5');
  assert.equal((await call('POST', '/parties', { type: 'customer', name: 'Back', stateCode: '27' }, tA)).status, 201, 'paying from a client company restores them all');
});

test('practice overview: deadlines across all companies, worst first', async () => {
  const con = await reg({ consultant: true, gstin: '29ABCDE1234F1Z5', name: 'Overview Practice' });
  const a = await ok(addCompany(con.token, 'Plain client'));
  const tA = await switchTo(con.token, a.id);
  const home = await switchTo(con.token, (await me(con.token)).homeCompanyId);
  for (const t of [home, tA]) await ok(call('PUT', '/compliance/settings', { trackFrom: '2026-04-01' }, t));

  const o = (await call('GET', '/consultant/overview?asOf=2026-11-05', undefined, con.token)).body;
  // GST-registered practice: 14 overdue this year + March GSTR-1/3B and the 2025-26 ITR = 17, GSTR-1 for October due soon.
  // A client with no GSTIN: advance tax (Jun, Sep) + the 2025-26 ITR = 3.
  assert.deepEqual(o.companies.map((c) => [c.name, c.overdue, c.dueSoon]), [['Overview Practice', 17, 1], ['Plain client', 3, 0]]);
  assert.deepEqual(o.totals, { companies: 2, overdue: 20, dueSoon: 1 });
  assert.equal(o.companies[0].next.name, 'GSTR-1 - Oct 2026');
  assert.equal(o.companies[1].next.name, 'Advance tax - 75% cumulative');
  assert.ok(o.companies[0].mostOverdue.name);
  assert.equal(o.companies.find((c) => c.name === 'Plain client').isHome, false);
});

test('admin verification: disabled without a key, protected with one', async () => {
  const con = await reg({ consultant: true });
  const uid = (await pool.query('SELECT id FROM users WHERE email=$1', [con.email])).rows[0].id;
  assert.equal((await call('GET', '/admin/consultants', undefined, null)).status, 404, 'no ADMIN_API_KEY: the endpoint does not exist');

  process.env.ADMIN_API_KEY = 'staff-secret-key';
  assert.equal((await call('GET', '/admin/consultants', undefined, null)).status, 401);
  assert.equal((await call('GET', '/admin/consultants', undefined, null, { 'x-admin-key': 'wrong' })).status, 401);
  assert.equal((await call('GET', '/admin/consultants', undefined, con.token)).status, 401, 'a user token is not an admin key');
  const H = { 'x-admin-key': 'staff-secret-key' };

  const pending = (await call('GET', '/admin/consultants?status=pending', undefined, null, H)).body;
  assert.ok(pending.some((p) => p.userId === uid && p.membershipNo === '123456' && p.email === con.email));
  assert.equal((await call('POST', `/admin/consultants/${uid}/decision`, { status: 'maybe' }, null, H)).status, 400);
  assert.equal((await call('POST', '/admin/consultants/999999/decision', { status: 'verified' }, null, H)).status, 404);
  assert.equal((await call('POST', `/admin/consultants/${uid}/decision`, { status: 'verified', note: 'Checked on ICAI member search' }, null, H)).status, 200);
  const c = (await me(con.token)).consultant;
  assert.deepEqual([c.status, c.note], ['verified', 'Checked on ICAI member search']);
  assert.ok(!(await call('GET', '/admin/consultants?status=pending', undefined, null, H)).body.some((p) => p.userId === uid));
  delete process.env.ADMIN_API_KEY;
});
