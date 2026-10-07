import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { addDays } from '../src/billing.js';
import { today as todayFn } from '../src/util.js';
import { DEFAULT_SMS_TEMPLATE, renderSmsTemplate, resolveChannels, simulatedChannels, smsTemplateProblems, twilioSms } from '../src/notify.js';
import { buildMessage, dueReminders } from '../src/reminders.js';

const item = (o = {}) => ({ rule_code: 'GSTR3B_M', period_key: '2026-09', name: 'GSTR-3B - Sep 2026', due: '2026-10-20', status: 'upcoming', ...o });

// ---------- pure ----------
test('SMS template: placeholders are filled in order, values are single-line and cut to the DLT variable limit', () => {
  assert.deepEqual(smsTemplateProblems(DEFAULT_SMS_TEMPLATE), []);
  assert.equal(renderSmsTemplate('A {#var#} B {#var#}.', ['one', 'two']), 'A one B two.');
  assert.equal(renderSmsTemplate('X {#var#}', ['line one\n  line   two']), 'X line one line two');
  assert.equal(renderSmsTemplate('X {#var#}', ['abcdefghij'], 5), 'X abcde');
  assert.equal(renderSmsTemplate('X {#var#}', [null]), 'X ');
  assert.match(smsTemplateProblems('no placeholder here')[0], /at least one/);
  assert.match(smsTemplateProblems('{#var#} {#var#} {#var#} {#var#} {#var#}')[0], /at most 4/);
  assert.match(smsTemplateProblems(`{#var#} ${'x'.repeat(500)}`).join('|'), /500 characters/);
  assert.throws(() => renderSmsTemplate('plain', []), /placeholder/);
});

test('SMS message: company, how many, and the most urgent item with its date', () => {
  const items = dueReminders({ items: [item(), item({ rule_code: 'X', period_key: 'a', name: 'Pay rent', due: '2026-10-10' })], today: '2026-10-19' });
  const m = buildMessage({ company: 'Demo Co', items, channel: 'sms' });
  assert.equal(m.text, 'IBMP reminder: Demo Co has 2 compliance item(s) to action. Next: Pay rent due 10-10-2026. Open IBMP for details.');
  const long = buildMessage({ company: 'A Very Long Company Name Private Limited', items: [items[1]], channel: 'sms', smsVarMax: 30 }).text;
  assert.ok(long.includes('A Very Long Company Name Priva has'), long);
  assert.equal(buildMessage({ company: 'C', items, channel: 'sms', smsTemplate: 'Due: {#var#} / {#var#}' }).text, 'Due: C / 2');
});

test('Twilio: request shape, sender or messaging service, and errors', async () => {
  let call;
  const okFetch = async (url, init) => { call = { url, init }; return { ok: true, status: 201, json: async () => ({ sid: 'SM123', status: 'queued' }) }; };
  const a = twilioSms({ accountSid: 'AC1', authToken: 'tok', from: 'IBMPAP', fetchImpl: okFetch });
  assert.deepEqual(await a.send({ to: '919876543210', text: 'Hello' }), { id: 'SM123' });
  assert.equal(call.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(call.init.headers.authorization, `Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  assert.equal(call.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const p = new URLSearchParams(call.init.body);
  assert.deepEqual([p.get('To'), p.get('From'), p.get('Body'), p.has('MessagingServiceSid')], ['+919876543210', 'IBMPAP', 'Hello', false]);
  await twilioSms({ accountSid: 'AC1', authToken: 'tok', messagingServiceSid: 'MG9', fetchImpl: okFetch }).send({ to: '919876543210', text: 'Hi' });
  const q = new URLSearchParams(call.init.body);
  assert.deepEqual([q.get('MessagingServiceSid'), q.has('From')], ['MG9', false]);
  const bad = twilioSms({ accountSid: 'AC1', authToken: 'tok', from: 'X', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ code: 21211, message: 'Invalid To number', status: 400 }) }) });
  await assert.rejects(() => bad.send({ to: '1', text: 't' }), /Invalid To number \(Twilio error 21211\)/);
  const odd = twilioSms({ accountSid: 'AC1', authToken: 'tok', from: 'X', fetchImpl: async () => ({ ok: false, status: 503, json: async () => { throw new Error('html'); } }) });
  await assert.rejects(() => odd.send({ to: '1', text: 't' }), /SMS request failed \(503\)/);
});

test('SMS configuration: credentials, a sender AND a valid registered template are all needed; nothing is faked in production', () => {
  const base = { NODE_ENV: 'production', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', SMS_FROM: 'IBMPAP', SMS_TEMPLATE: 'Hi {#var#}, {#var#} items.' };
  assert.equal(resolveChannels({ NODE_ENV: 'production' }).sms, null);
  assert.equal(resolveChannels({ NODE_ENV: 'production', ENABLE_SIMULATORS: 'true' }).sms.mode, 'simulated');
  const live = resolveChannels(base);
  assert.deepEqual([live.sms.name, live.smsTemplate, live.smsVarMax], ['twilio', 'Hi {#var#}, {#var#} items.', 30]);
  assert.equal(resolveChannels({ ...base, SMS_VAR_MAX: '20' }).smsVarMax, 20);
  assert.equal(resolveChannels({ ...base, SMS_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MG1' }).sms.name, 'twilio');
  for (const missing of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMS_FROM', 'SMS_TEMPLATE']) assert.equal(resolveChannels({ ...base, [missing]: undefined }).sms, null, missing);
  assert.equal(resolveChannels({ ...base, SMS_TEMPLATE: 'no placeholders' }).sms, null, 'an unusable template is not a configuration');
  assert.equal(resolveChannels({ ...base, SMS_TEMPLATE: '{#var#}{#var#}{#var#}{#var#}{#var#}' }).sms, null);
  assert.equal(simulatedChannels().smsTemplate, DEFAULT_SMS_TEMPLATE);
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
function start(channels = simulatedChannels()) {
  const app = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels });
  const server = app.listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, channels };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const register = async (call) => (await call('POST', '/auth/register', { name: 'T', email: `sms${++seq}@example.com`, password: 'password123', company: `Sms Co ${seq}`, sector: 'service', stateCode: '29' }, null)).body.token;
const post = (call, t, asOf) => call('POST', '/reminders/run', { asOf }, t);
const smsOf = (run) => run.results.filter((r) => r.channel === 'sms');

test('API: SMS recipients need consent and a mobile number; the same number can be on WhatsApp and SMS', async () => {
  const { call } = start();
  const t = await register(call);
  const no = await call('POST', '/reminders/recipients', { channel: 'sms', address: '9876543210' }, t);
  assert.deepEqual([no.status, no.body.code], [400, 'CONSENT_REQUIRED']);
  assert.match(no.body.error, /SMS/);
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'sms', address: '12345', consent: true }, t)).status, 400);
  const one = await ok(call('POST', '/reminders/recipients', { channel: 'sms', address: '+91 98765 43210', consent: true }, t));
  assert.equal(one.masked, '91******10');
  await ok(call('POST', '/reminders/recipients', { channel: 'whatsapp', address: '9876543210', consent: true }, t));
  assert.equal((await call('POST', '/reminders/recipients', { channel: 'sms', address: '9876543210', consent: true }, t)).status, 409);
  const list = (await ok(call('GET', '/reminders/settings', undefined, t))).recipients;
  assert.deepEqual(list.map((x) => [x.channel, x.address, x.consent]), [['sms', '919876543210', true], ['whatsapp', '919876543210', true]]);
});

test('API: SMS settings and delivery: one short message per recipient, once per moment, with the registered wording', async () => {
  const env = start();
  const t = await register(env.call);
  const s = await ok(env.call('GET', '/reminders/settings', undefined, t));
  assert.deepEqual([s.smsEnabled, s.channels.sms.configured, s.channels.sms.simulated, s.channels.sms.variableMax], [false, true, true, 30]);
  assert.ok(s.channels.sms.template.includes('{#var#}'));
  const on = await ok(env.call('PUT', '/reminders/settings', { smsEnabled: true }, t));
  assert.deepEqual([on.smsEnabled, on.emailEnabled, on.enabledSince], [true, false, T]);
  await ok(env.call('POST', '/reminders/recipients', { channel: 'sms', address: '9876543210', consent: true }, t));
  await ok(env.call('POST', '/compliance/custom', { name: 'Licence renewal', dueDate: day(7) }, t));

  const first = await ok(post(env.call, t, T));
  assert.deepEqual(smsOf(first).map((r) => [r.status, r.to]), [['sent', '91******10']]);
  const msg = env.channels.sent.find((m) => m.channel === 'sms');
  assert.equal(msg.to, '919876543210');
  assert.ok(msg.text.startsWith('IBMP reminder: Sms Co ') && msg.text.endsWith('. Open IBMP for details.'), msg.text);
  assert.ok(msg.text.length < 200, 'short enough for one or two SMS segments');
  assert.ok(!msg.text.includes('{#var#}'));
  assert.equal(env.channels.sent.filter((m) => m.channel === 'sms').length, 1, 'one message however many items');

  assert.deepEqual(smsOf(await ok(post(env.call, t, T))), [], 'not sent twice');
  assert.equal(smsOf(await ok(post(env.call, t, day(4)))).filter((r) => r.status === 'sent').length, 1, 'the next moment sends again');
  const log = (await ok(env.call('GET', '/reminders/log', undefined, t))).filter((x) => x.channel === 'sms' && x.status === 'sent');
  assert.ok(log.length >= 2 && log.every((x) => x.to === '91******10'));

  const rid = (await ok(env.call('GET', '/reminders/settings', undefined, t))).recipients[0].id;
  assert.equal((await ok(env.call('POST', `/reminders/recipients/${rid}/test`, {}, t))).sent, true);
  await ok(env.call('PUT', '/reminders/settings', { smsEnabled: false }, t));
  assert.deepEqual(smsOf(await ok(post(env.call, t, day(6)))), []);
});

test('API: SMS without consent on record, or with no provider configured, is skipped and reported', async () => {
  const a = start();
  const t = await register(a.call);
  await ok(a.call('PUT', '/reminders/settings', { smsEnabled: true }, t));
  const r = await ok(a.call('POST', '/reminders/recipients', { channel: 'sms', address: '9876543210', consent: true }, t));
  await pool.query('UPDATE reminder_recipients SET consent_at=NULL WHERE id=$1', [r.id]);
  await ok(a.call('POST', '/compliance/custom', { name: 'Licence renewal', dueDate: day(7) }, t));
  assert.deepEqual(smsOf(await ok(post(a.call, t, T))).map((x) => [x.status, x.reason]), [['skipped', 'No recorded consent for SMS.']]);

  const b = start({ email: null, whatsapp: null, sms: null, sent: [] });
  const t2 = await register(b.call);
  await ok(b.call('PUT', '/reminders/settings', { smsEnabled: true }, t2));
  const r2 = await ok(b.call('POST', '/reminders/recipients', { channel: 'sms', address: '9876543210', consent: true }, t2));
  await ok(b.call('POST', '/compliance/custom', { name: 'Licence renewal', dueDate: day(7) }, t2));
  const out = smsOf(await ok(post(b.call, t2, T)));
  assert.deepEqual(out.map((x) => [x.status]), [['skipped']]);
  assert.match(out[0].reason, /SMS sending is not configured/);
  const test503 = await b.call('POST', `/reminders/recipients/${r2.id}/test`, {}, t2);
  assert.deepEqual([test503.status, test503.body.code], [503, 'CHANNEL_NOT_CONFIGURED']);
  assert.match(test503.body.error, /^SMS /);
});
