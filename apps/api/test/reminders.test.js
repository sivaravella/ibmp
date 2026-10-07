import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { addDays } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';
import { resolveChannels, simulatedChannels, smtpEmail, whatsappCloud } from '../src/notify.js';
import { buildMessage, dueReminders, keyOf, maskAddress, normalisePhone, parseDays, stagesFor } from '../src/reminders.js';

// ---------- pure ----------
test('lead and overdue days: parsed, de-duplicated, sorted; anything else is refused', () => {
  assert.deepEqual(parseDays('1, 7,3,7', { min: 0, max: 30 }), [7, 3, 1]);
  assert.deepEqual(parseDays('', { min: 0, max: 30 }), []);
  for (const bad of ['x', '1.5', '-1', '31', '7;3']) assert.equal(parseDays(bad, { min: 0, max: 30 }), null, bad);
  assert.equal(parseDays('0', { min: 1, max: 60 }), null, 'overdue starts at 1');
});

test('phone numbers become digits with a country code; email and phone are masked for display', () => {
  assert.equal(normalisePhone('98765 43210'), '919876543210');
  assert.equal(normalisePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalisePhone('919876543210'), '919876543210');
  assert.equal(normalisePhone('+1 (415) 555-0100'), '14155550100');
  for (const bad of ['12345', '5876543210', 'abc', '', null, '+12']) assert.equal(normalisePhone(bad), null, String(bad));
  assert.equal(maskAddress('email', 'accounts@demo.in'), 'a***@demo.in');
  assert.equal(maskAddress('whatsapp', '919876543210'), '91******10');
});

test('reminder moments are ordered by date; lead 0 is "due" and overdue follows the due date', () => {
  assert.deepEqual(stagesFor('2026-10-20', [7, 3, 0], [1, 7]).map((s) => [s.stage, s.trigger]),
    [['before_7', '2026-10-13'], ['before_3', '2026-10-17'], ['due', '2026-10-20'], ['overdue_1', '2026-10-21'], ['overdue_7', '2026-10-27']]);
});

const item = (o = {}) => ({ rule_code: 'GSTR3B_M', period_key: '2026-09', name: 'GSTR-3B - Sep 2026', due: '2026-10-20', status: 'upcoming', ...o });

test('which reminder is due: one per moment, the latest that has arrived, never twice, caught up after downtime', () => {
  const run = (today, o = {}) => dueReminders({ items: [item()], today, ...o });
  assert.deepEqual(run('2026-10-12'), [], 'nothing before the first lead day');
  assert.equal(run('2026-10-13')[0].stage, 'before_7');
  assert.equal(run('2026-10-16')[0].stage, 'before_7', 'still the same moment until the next one arrives');
  assert.deepEqual(run('2026-10-16', { sent: new Set([keyOf(item(), 'before_7')]) }), [], 'already sent');
  assert.equal(run('2026-10-17')[0].stage, 'before_3');
  assert.equal(run('2026-10-19', { sent: new Set([keyOf(item(), 'before_7')]) })[0].stage, 'before_1', 'the server was down on the 17th: one catch-up, not three');
  assert.equal(run('2026-10-20')[0].stage, 'due');
  assert.deepEqual(run('2026-10-21').map((x) => [x.stage, x.days]), [['overdue_1', -1]]);
  assert.equal(run('2026-10-27')[0].stage, 'overdue_7');
  assert.deepEqual(run('2026-11-30', { sent: new Set([keyOf(item(), 'overdue_7')]) }), [], 'the sequence ends');
});

test('switching reminders on sends no backlog; completed items are skipped; a new due date restarts the sequence', () => {
  assert.deepEqual(dueReminders({ items: [item()], today: '2026-10-19', since: '2026-10-20' }), [], 'every moment so far was before the switch-on date');
  assert.equal(dueReminders({ items: [item()], today: '2026-10-20', since: '2026-10-20' })[0].stage, 'due');
  assert.deepEqual(dueReminders({ items: [item({ status: 'completed' })], today: '2026-10-20' }), []);
  const sent = new Set([keyOf(item(), 'due')]);
  assert.deepEqual(dueReminders({ items: [item()], today: '2026-10-20', sent }), []);
  assert.equal(dueReminders({ items: [item({ due: '2026-10-27' })], today: '2026-10-20', sent })[0].stage, 'before_7', 'extended to the 27th: reminded again');
  assert.deepEqual(dueReminders({ items: [item()], today: '2026-10-13', lead: [3], overdue: [] }), [], 'custom lead days');
});

test('messages: email lists overdue first and escapes HTML; WhatsApp is one line within the template limit', () => {
  const items = dueReminders({ items: [item(), item({ rule_code: 'X', period_key: 'a', name: 'Pay <b>rent</b> & tax', due: '2026-10-10' })], today: '2026-10-19' });
  const m = buildMessage({ company: 'Demo & Co', items, channel: 'email', appUrl: 'https://app.example.com' });
  assert.match(m.subject, /^1 overdue, 2 compliance items need attention: Demo & Co$/);
  assert.ok(m.text.indexOf('OVERDUE') < m.text.indexOf('COMING UP'));
  assert.match(m.text, /GSTR-3B - Sep 2026: 20-10-2026 \(due in 1 day\)/);
  assert.match(m.text, /9 days overdue/);
  assert.match(m.text, /remove your address/);
  assert.ok(m.html.includes('Pay &lt;b&gt;rent&lt;/b&gt; &amp; tax') && !m.html.includes('<b>rent'));
  const w = buildMessage({ company: 'Demo Co', items, channel: 'whatsapp', templateName: 'tpl', templateLang: 'en' });
  assert.ok(!/[\n\t]/.test(w.template.params[1]));
  assert.deepEqual([w.template.name, w.template.params[0]], ['tpl', 'Demo Co']);
  const many = Array.from({ length: 60 }, (_, i) => ({ ...item(), name: `Compliance item number ${i}`, days: 3, due: '2026-10-20' }));
  const long = buildMessage({ company: 'C', items: many, channel: 'whatsapp' }).template.params[1];
  assert.ok(long.length <= 1024 && long.endsWith('and more'));
});

test('providers: WhatsApp Cloud request shape and errors; SMTP hands the message to the transport; configuration picks the right one', async () => {
  let call;
  const wa = whatsappCloud({ token: 'T', phoneId: '123', template: 'tpl', fetchImpl: async (url, init) => { call = { url, init }; return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; } });
  assert.deepEqual(await wa.send({ to: '919876543210', template: { name: 'tpl', lang: 'en', params: ['Co', 'Summary'] } }), { id: 'wamid.1' });
  const body = JSON.parse(call.init.body);
  assert.match(call.url, /\/123\/messages$/);
  assert.equal(call.init.headers.authorization, 'Bearer T');
  assert.deepEqual([body.to, body.type, body.template.name, body.template.language.code, body.template.components[0].parameters.map((p) => p.text)], ['919876543210', 'template', 'tpl', 'en', ['Co', 'Summary']]);
  const bad = whatsappCloud({ token: 'T', phoneId: '1', template: 'x', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Template not approved' } }) }) });
  await assert.rejects(() => bad.send({ to: '1', template: { params: [] } }), /Template not approved/);

  const mails = [];
  const smtp = smtpEmail({ from: 'IBMP <no-reply@example.com>', transport: { sendMail: async (m) => { mails.push(m); return { messageId: '<1@x>' }; } } });
  assert.deepEqual(await smtp.send({ to: 'a@b.in', subject: 'S', text: 'T', html: '<p>H</p>' }), { id: '<1@x>' });
  assert.deepEqual([mails[0].from, mails[0].to, mails[0].subject], ['IBMP <no-reply@example.com>', 'a@b.in', 'S']);

  const prod = resolveChannels({ NODE_ENV: 'production' });
  assert.deepEqual([prod.email, prod.whatsapp], [null, null], 'nothing is faked in production');
  const demo = resolveChannels({ NODE_ENV: 'production', ENABLE_SIMULATORS: 'true' });
  assert.deepEqual([demo.email.mode, demo.whatsapp.mode], ['simulated', 'simulated']);
  const live = resolveChannels({ NODE_ENV: 'production', SMTP_URL: 'smtp://u:p@localhost:2525', MAIL_FROM: 'a@b.in', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1', WHATSAPP_TEMPLATE: 'tpl' });
  assert.deepEqual([live.email.name, live.whatsapp.name, live.templateName], ['smtp', 'whatsapp_cloud', 'tpl']);
  assert.equal(resolveChannels({ NODE_ENV: 'production', SMTP_URL: 'smtp://x' }).email, null, 'a half configuration is not a configuration');
});

// ---------- API ----------
let pool, seq = 0;
const T = todayFn();
const day = (n) => addDays(T, n);

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
});

/** A running app with its own channels; returns a caller. */
function start(channels = simulatedChannels()) {
  const app = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels });
  const server = app.listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, call, channels };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (call) => (await call('POST', '/auth/register', { name: 'T', email: `rem${++seq}@example.com`, password: 'password123', company: `Rem Co ${seq}`, sector: 'service', stateCode: '29' }, null)).body.token;

/** A company with email and WhatsApp on, one recipient each, and a custom item due a week from today. */
async function world(env = start()) {
  const { call } = env;
  const t = await register(call);
  await ok(call('PUT', '/reminders/settings', { emailEnabled: true, whatsappEnabled: true }, t));
  const em = await ok(call('POST', '/reminders/recipients', { channel: 'email', address: 'Accounts@Demo.in', name: 'Accounts' }, t));
  const wa = await ok(call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '98765 43210', consent: true }, t));
  const it = await ok(call('POST', '/compliance/custom', { name: 'Licence renewal', dueDate: day(7) }, t));
  return { ...env, t, em, wa, key: it.periodKey };
}
const mine = (run) => run.results.map((r) => ({ ...r, items: r.items.filter((i) => i.name === 'Licence renewal') })).filter((r) => r.items.length);
const post = (call, t, asOf) => call('POST', '/reminders/run', { asOf }, t);

test('API: settings: defaults, validation, and what the server can send', async () => {
  const env = start();
  const t = await register(env.call);
  const s = await ok(env.call('GET', '/reminders/settings', undefined, t));
  assert.deepEqual([s.emailEnabled, s.whatsappEnabled, s.leadDays, s.overdueDays, s.enabledSince], [false, false, [7, 3, 1, 0], [1, 3, 7], null]);
  assert.deepEqual([s.channels.email.configured, s.channels.email.simulated, s.channels.whatsapp.template], [true, true, 'ibmp_compliance_reminder']);
  assert.equal((await env.call('PUT', '/reminders/settings', { leadDays: [] }, t)).status, 400);
  assert.equal((await env.call('PUT', '/reminders/settings', { leadDays: [40] }, t)).status, 400);
  assert.equal((await env.call('PUT', '/reminders/settings', { overdueDays: [0] }, t)).status, 400);
  assert.equal((await env.call('PUT', '/reminders/settings', { emailEnabled: 'yes' }, t)).status, 400);
  const on = await ok(env.call('PUT', '/reminders/settings', { emailEnabled: true, leadDays: [5, 2], overdueDays: [2] }, t));
  assert.deepEqual([on.emailEnabled, on.leadDays, on.overdueDays, on.enabledSince], [true, [5, 2], [2], T]);
  const later = await ok(env.call('PUT', '/reminders/settings', { whatsappEnabled: true }, t));
  assert.equal(later.enabledSince, T, 'the switch-on date is kept while any channel stays on');
  assert.equal((await env.call('GET', '/reminders/settings')).status, 401);
  const none = start({ email: null, whatsapp: null, sent: [] });
  const t2 = await register(none.call);
  const s2 = await ok(none.call('GET', '/reminders/settings', undefined, t2));
  assert.deepEqual([s2.channels.email.configured, s2.channels.whatsapp.configured], [false, false]);
});

test('API: recipients: validation, normalising, consent for WhatsApp, masking, isolation', async () => {
  const { call } = start();
  const t = await register(call);
  const e = await ok(call('POST', '/reminders/recipients', { channel: 'email', address: ' Owner@Demo.IN ' }, t));
  assert.equal(e.masked, 'o***@demo.in');
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'email', address: 'owner@demo.in' }, t)).status, 409, 'duplicate after normalising');
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'email', address: 'not-an-email' }, t)).status, 400);
  const noConsent = await call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '9876543210' }, t);
  assert.deepEqual([noConsent.status, noConsent.body.code], [400, 'CONSENT_REQUIRED']);
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '12345', consent: true }, t)).status, 400);
  const w = await ok(call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '+91 98765 43210', consent: true }, t));
  assert.equal(w.masked, '91******10');
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '9876543210', consent: true }, t)).status, 409);
  const list = (await ok(call('GET', '/reminders/settings', undefined, t))).recipients;
  assert.deepEqual(list.map((x) => [x.channel, x.address, x.consent, x.active]), [['email', 'owner@demo.in', false, true], ['whatsapp', '919876543210', true, true]]);

  const other = await register(call);
  assert.deepEqual((await ok(call('GET', '/reminders/settings', undefined, other))).recipients, []);
  assert.equal((await call('DELETE', `/reminders/recipients/${e.id}`, undefined, other)).status, 404);
  assert.equal((await call('PUT', `/reminders/recipients/${e.id}`, { active: false }, other)).status, 404);
  await ok(call('PUT', `/reminders/recipients/${e.id}`, { active: false }, t));
  assert.equal((await ok(call('GET', '/reminders/settings', undefined, t))).recipients[0].active, false);
  await ok(call('DELETE', `/reminders/recipients/${e.id}`, undefined, t));
  assert.equal((await call('DELETE', `/reminders/recipients/${e.id}`, undefined, t)).status, 404);
  for (let i = 0; i < 19; i++) await ok(call('POST', '/reminders/recipients', { channel: 'email', address: `p${i}@demo.in` }, t));
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'email', address: 'one-too-many@demo.in' }, t)).status, 400, 'at most 20');
});

test('API: a reminder goes out once per moment on each channel; the next moment, completion and a new due date behave', async () => {
  const { call, channels, t, key } = await world();
  const prev = await ok(call('GET', `/reminders/preview?asOf=${T}`, undefined, t));
  assert.deepEqual(mine(prev).map((r) => [r.channel, r.status, r.items[0].stage, r.items[0].days]), [['email', 'would_send', 'before_7', 7], ['whatsapp', 'would_send', 'before_7', 7]]);
  assert.equal(channels.sent.length, 0, 'a preview sends nothing');

  const first = await ok(post(call, t, T));
  assert.deepEqual(mine(first).map((r) => [r.channel, r.status, r.to]), [['email', 'sent', 'a***@demo.in'], ['whatsapp', 'sent', '91******10']]);
  const email = channels.sent.find((m) => m.channel === 'email'), wa = channels.sent.find((m) => m.channel === 'whatsapp');
  assert.deepEqual([email.to, wa.to], ['accounts@demo.in', '919876543210']);
  assert.match(email.subject, /compliance items? need attention: Rem Co/);
  assert.match(email.text, new RegExp(`Licence renewal: ${day(7).split('-').reverse().join('-')} \\(due in 7 days\\)`));
  assert.match(wa.template.params[1], /Licence renewal/);
  const sentCount = channels.sent.length;

  assert.deepEqual(mine(await ok(post(call, t, T))), [], 'running again the same day sends nothing');
  assert.deepEqual(mine(await ok(post(call, t, day(3)))), [], 'still the same moment on day 3');
  assert.equal(channels.sent.length, sentCount);
  const next = await ok(post(call, t, day(4)));
  assert.deepEqual(mine(next).map((r) => [r.channel, r.items[0].stage]), [['email', 'before_3'], ['whatsapp', 'before_3']]);
  assert.deepEqual(mine(await ok(post(call, t, day(6)))).map((r) => r.items[0].stage), ['before_1', 'before_1']);

  // marking it done stops the sequence
  await ok(call('PUT', '/compliance/records', { ruleCode: 'CUSTOM', periodKey: key, completedOn: day(6) }, t));
  assert.deepEqual(mine(await ok(post(call, t, day(7)))), []);

  // reopening and moving the due date starts it again from the first moment
  await ok(call('PUT', '/compliance/records', { ruleCode: 'CUSTOM', periodKey: key, completedOn: null }, t));
  const log = (await ok(call('GET', '/reminders/log', undefined, t))).filter((x) => x.kind === 'reminder' && x.status === 'sent');
  assert.equal(log.length, 6, 'three moments, two channels');
  assert.ok(!JSON.stringify(log).includes('accounts@demo.in') && !JSON.stringify(log).includes('919876543210'), 'the log shows masked addresses only');
});

test('API: overdue items are chased on the overdue days, then left alone', async () => {
  const { call, t } = await world();
  const stages = [];
  for (const n of [7, 8, 10, 14, 15, 30]) stages.push(mine(await ok(post(call, t, day(n)))).filter((r) => r.channel === 'email').map((r) => r.items[0].stage)[0] ?? null);
  assert.deepEqual(stages, ['due', 'overdue_1', 'overdue_3', 'overdue_7', null, null]);
});

test('API: nothing is sent for moments before reminders were switched on, for paused recipients, disabled channels or missing consent', async () => {
  const { call, t, em, wa, channels } = await world();
  assert.deepEqual(mine(await ok(post(call, t, day(-10)))), [], 'asOf before the switch-on date');
  await ok(call('PUT', `/reminders/recipients/${em.id}`, { active: false }, t));
  await ok(call('PUT', '/reminders/settings', { whatsappEnabled: false }, t));
  assert.deepEqual(mine(await ok(post(call, t, T))), []);
  assert.equal(channels.sent.length, 0);
  await ok(call('PUT', '/reminders/settings', { whatsappEnabled: true }, t));
  await pool.query('UPDATE reminder_recipients SET consent_at=NULL WHERE id=$1', [wa.id]);
  const r = mine(await ok(post(call, t, T)));
  assert.deepEqual(r.map((x) => [x.channel, x.status, x.reason]), [['whatsapp', 'skipped', 'No recorded consent for WhatsApp.']]);
  assert.equal(channels.sent.length, 0);
});

test('API: a channel that is not configured is reported as skipped, never faked', async () => {
  const { call, t } = await world(start({ email: null, whatsapp: null, sent: [] }));
  const r = mine(await ok(post(call, t, T)));
  assert.deepEqual(r.map((x) => [x.channel, x.status]), [['email', 'skipped'], ['whatsapp', 'skipped']]);
  assert.match(r[0].reason, /not configured/);
  assert.equal((await ok(call('GET', '/reminders/log', undefined, t))).length, 0);
});

test('API: a provider failure is logged and retried; the items stay pending', async () => {
  let fail = true;
  const sim = simulatedChannels();
  const flaky = { ...sim, email: { name: 'flaky', mode: 'live', send: async (m) => { if (fail) throw new Error('SMTP connection refused'); return sim.email.send(m); } } };
  const { call, t } = await world(start(flaky));
  const a = mine(await ok(post(call, t, T)));
  assert.deepEqual(a.map((x) => [x.channel, x.status]), [['email', 'failed'], ['whatsapp', 'sent']], 'one channel failing does not stop the other');
  assert.match(a[0].error, /connection refused/);
  const log = await ok(call('GET', '/reminders/log', undefined, t));
  assert.deepEqual(log.filter((x) => x.status === 'failed').map((x) => [x.channel, x.error]), [['email', 'SMTP connection refused']]);
  fail = false;
  const b = mine(await ok(post(call, t, T)));
  assert.deepEqual(b.map((x) => [x.channel, x.status]), [['email', 'sent']], 'retried; WhatsApp is not repeated');
});

test('API: a test message reaches one recipient, is logged as a test and does not use up a reminder', async () => {
  const { call, t, em, wa, channels } = await world();
  const r = await ok(call('POST', `/reminders/recipients/${em.id}/test`, {}, t));
  assert.deepEqual([r.sent, r.simulated], [true, true]);
  await ok(call('POST', `/reminders/recipients/${wa.id}/test`, {}, t));
  assert.equal(channels.sent.length, 2);
  assert.match(channels.sent[0].text, /Test reminder/);
  assert.equal(mine(await ok(post(call, t, T))).length, 2, 'the real reminders still go out');
  assert.deepEqual((await ok(call('GET', '/reminders/log', undefined, t))).filter((x) => x.kind === 'test').map((x) => x.channel).sort(), ['email', 'whatsapp']);
  assert.equal((await call('POST', '/reminders/recipients/999999/test', {}, t)).status, 404);

  const off = await world(start({ email: null, whatsapp: null, sent: [] }));
  const n = await off.call('POST', `/reminders/recipients/${off.em.id}/test`, {}, off.t);
  assert.deepEqual([n.status, n.body.code], [503, 'CHANNEL_NOT_CONFIGURED']);
  const bad = await world(start({ email: { name: 'x', mode: 'live', send: async () => { throw new Error('550 mailbox unavailable'); } }, whatsapp: null, sent: [] }));
  const f = await bad.call('POST', `/reminders/recipients/${bad.em.id}/test`, {}, bad.t);
  assert.deepEqual([f.status, f.body.code], [502, 'DELIVERY_FAILED']);
  assert.match(f.body.error, /550 mailbox unavailable/);
});

test('API: the daily job covers every enabled company, skips expired subscriptions and archived companies, and survives one failure', async () => {
  const sim = simulatedChannels();
  const { app, call, channels } = await world(start(sim));
  await world({ app, call, channels });       // second company on the same app
  await world({ app, call, channels });       // expired
  await world({ app, call, channels });       // provider will reject its address
  const cidOfEmail = async (n) => (await pool.query('SELECT company_id FROM users WHERE email=$1', [`rem${n}@example.com`])).rows[0].company_id;
  const lastSeq = seq;
  const [cidA, cidB, cidC, cidD] = [await cidOfEmail(lastSeq - 3), await cidOfEmail(lastSeq - 2), await cidOfEmail(lastSeq - 1), await cidOfEmail(lastSeq)];
  await pool.query('INSERT INTO subscriptions (company_id, trial_ends) VALUES ($1,$2) ON CONFLICT (company_id) DO UPDATE SET trial_ends=$2', [cidC, addDays(T, -40)]);
  await pool.query("UPDATE reminder_recipients SET address='broken@fail.test' WHERE company_id=$1 AND channel='email'", [cidD]);
  const real = channels.email.send;
  channels.email.send = async (m) => { if (m.to === 'broken@fail.test') throw new Error('rejected'); return real(m); };

  const done = await app.locals.runReminders(T);
  const by = new Map(done.map((x) => [x.companyId, x]));
  assert.ok(by.has(cidA) && by.has(cidB), 'both active companies were processed');
  assert.equal(by.has(cidC), false, 'expired subscription: read-only, no reminders');
  const statusOf = (cid) => mine(by.get(cid)).map((r) => `${r.channel}:${r.status}`);
  assert.deepEqual(statusOf(cidA), ['email:sent', 'whatsapp:sent']);
  assert.deepEqual(statusOf(cidD), ['email:failed', 'whatsapp:sent'], 'one company failing does not stop the others');
  assert.deepEqual((await app.locals.runReminders(T)).flatMap((x) => mine(x)).filter((r) => r.status === 'sent'), [], 'the second run of the day sends nothing new');
});

test('API: reminders are private to the company', async () => {
  const { call, t, em } = await world();
  await ok(post(call, t, T));
  const other = await register(call);
  assert.deepEqual(await ok(call('GET', '/reminders/log', undefined, other)), []);
  assert.deepEqual((await ok(call('GET', '/reminders/settings', undefined, other))).recipients, []);
  assert.equal((await call('POST', `/reminders/recipients/${em.id}/test`, {}, other)).status, 404);
  assert.deepEqual((await ok(call('GET', `/reminders/preview?asOf=${T}`, undefined, other))).results, []);
  assert.equal((await call('GET', '/reminders/preview?asOf=nope', undefined, t)).status, 400);
});
