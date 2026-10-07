import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
let pool, mount, seq = 0;
const stubPdf = { name: 'stub', calls: [], render: async function ({ url, token }) { this.calls.push({ url, token }); return Buffer.from('%PDF-1.4 stub'); } };

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await migrate(pool);
  mount = (opts) => {
    const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), ...opts }).listen(0);
    server.unref();
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    return async (method, path, body, tok) => {
      const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };

async function world(call) {
  const t = (await call('POST', '/auth/register', { name: 'T', email: `mail${++seq}@example.com`, password: 'password123', company: `Mail Co ${seq}`, sector: 'trading', gstin: gstin('29MAILC5555Q1Z') })).body.token;
  const party = await ok(call('POST', '/parties', { type: 'customer', name: 'Priya Stores', gstin: gstin('29BBBBB1111B1Z'), email: 'priya@example.com' }, t));
  const item = await ok(call('POST', '/items', { name: 'Laptop', hsn: '8471', rate: 1000, gstPct: 18, stock: 50, unit: 'Nos' }, t));
  const inv = await ok(call('POST', '/invoices', { partyId: party.id, date: '2026-10-07', lines: [{ itemId: item.id, qty: 1 }] }, t));
  return { t, inv };
}

test('an invoice is emailed with the PDF attached, using a short-lived token for the print page, and the send is recorded', async () => {
  const channels = simulatedChannels();
  const call = mount({ channels, pdf: stubPdf });
  const { t, inv } = await world(call);
  const sent = await ok(call('POST', `/invoices/${inv.id}/email`, { to: 'priya@example.com', message: 'Thank you for your order.' }, t));
  assert.deepEqual([sent.toAddress, sent.status], ['priya@example.com', 'sent']);
  const mail = channels.sent.at(-1);
  assert.equal(mail.to, 'priya@example.com');
  assert.match(mail.subject, /^Invoice INV-0001 from /);
  assert.match(mail.text, /Invoice total: Rs\. 1,180\.00/);
  assert.match(mail.text, /Thank you for your order\./);
  assert.equal(mail.attachments[0].filename, 'INV-0001.pdf');
  assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(mail.attachments[0].content) && mail.attachments[0].content.toString().startsWith('%PDF'));
  const call0 = stubPdf.calls.at(-1);
  assert.ok(call0.url.endsWith('/#/invoice-print?id=' + inv.id), call0.url);
  const exp = JSON.parse(Buffer.from(call0.token.split('.')[1], 'base64url').toString()).exp, iat = JSON.parse(Buffer.from(call0.token.split('.')[1], 'base64url').toString()).iat;
  assert.ok(exp - iat <= 180, 'the token for the print page lives at most three minutes');
  const hist = await ok(call('GET', `/invoices/${inv.id}/emails`, undefined, t));
  assert.deepEqual(hist.map((h) => [h.toAddress, h.status]), [['priya@example.com', 'sent']]);
});

test('bad addresses, other companies, a missing PDF engine, missing email set-up and a failing mail server are all handled', async () => {
  const channels = simulatedChannels();
  const call = mount({ channels, pdf: stubPdf });
  const { t, inv } = await world(call);
  const other = await world(call);
  assert.equal((await call('POST', `/invoices/${inv.id}/email`, { to: 'not-an-email' }, t)).status, 400);
  assert.equal((await call('POST', `/invoices/${inv.id}/email`, { to: 'a@example.com' }, other.t)).status, 404);          // someone else's invoice
  assert.equal((await call('GET', `/invoices/${inv.id}/emails`, undefined, other.t)).status, 404);
  const before = channels.sent.length;
  assert.equal(channels.sent.length, before);

  const noPdf = mount({ channels: simulatedChannels(), pdf: null });
  const w2 = await world(noPdf);
  const r = await noPdf('POST', `/invoices/${w2.inv.id}/email`, { to: 'a@example.com' }, w2.t);
  assert.deepEqual([r.status, r.body.code], [503, 'PDF_OFF']);

  const noMail = mount({ channels: { ...simulatedChannels(), email: null }, pdf: stubPdf });
  const w3 = await world(noMail);
  assert.deepEqual([(await noMail('POST', `/invoices/${w3.inv.id}/email`, { to: 'a@example.com' }, w3.t)).status], [503]);

  const failing = mount({ channels: { ...simulatedChannels(), email: { name: 'smtp', send: async () => { throw new Error('550 sender not verified'); } } }, pdf: stubPdf });
  const w4 = await world(failing);
  const f = await failing('POST', `/invoices/${w4.inv.id}/email`, { to: 'a@example.com' }, w4.t);
  assert.equal(f.status, 502);
  assert.doesNotMatch(f.body.error, /550/);                                                                               // the SMTP detail stays in the log, not in front of the user
  const hist = await ok(failing('GET', `/invoices/${w4.inv.id}/emails`, undefined, w4.t));
  assert.deepEqual(hist.map((h) => h.status), ['failed']);
});
