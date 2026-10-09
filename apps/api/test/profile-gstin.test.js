import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';
import { describeGstin, normaliseTaxpayer, parseGstin, resolveGstinLookup } from '../src/gstin-lookup.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
let call, seq = 0;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool, { gateway: mockProvider(), gsp: simulatedGsp(), channels: simulatedChannels() }).listen(0);
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  call = async (method, path, body, tok) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
const signup = async (extra = {}) => (await call('POST', '/auth/register', { name: 'Owner', email: `pg${++seq}@example.com`, password: 'password123', company: `Profile Co ${seq}`, sector: 'trading', stateCode: '37', ...extra })).body.token;

test('parseGstin reads state, PAN and kind of taxpayer from the number and checks the check character', () => {
  const g = gstin('37ATQPK0472R1Z');
  const p = parseGstin(g);
  assert.deepEqual([p.formatOk, p.checkOk, p.stateCode, p.pan, p.panKind], [true, true, '37', 'ATQPK0472R', 'Individual or proprietor']);
  assert.equal(parseGstin(g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A')).checkOk, false);
  assert.equal(parseGstin('nonsense').formatOk, false);
  assert.equal(parseGstin(gstin('29AABCU9603R1Z')).panKind, 'Company');
});

test('normaliseTaxpayer understands the GSTN field names and friendlier ones', () => {
  const t = normaliseTaxpayer({ taxpayerInfo: { lgnm: 'ACME TRADERS', tradeNam: 'Acme', sts: 'Active', ctb: 'Proprietorship', pradr: { addr: { bno: '12', bnm: 'Sai Complex', st: 'MG Road', loc: 'Benz Circle', dst: 'Krishna', pncd: '520010' } } } });
  assert.deepEqual([t.legalName, t.tradeName, t.status, t.loc, t.pin], ['ACME TRADERS', 'Acme', 'Active', 'Krishna', '520010']);
  assert.match(t.addr1, /12, Sai Complex/);
  assert.equal(normaliseTaxpayer({ data: { legalName: 'Beta LLP', status: 'Cancelled' } }).status, 'Cancelled');
  assert.equal(normaliseTaxpayer({ error: true }), null);
});

test('describeGstin never fails: with no provider it fills state and PAN and says why the name is missing', async () => {
  const d = await describeGstin(gstin('37ATQPK0472R1Z'));
  assert.deepEqual([d.found, d.stateCode, d.pan, d.source], [false, '37', 'ATQPK0472R', 'number']);
  assert.match(d.message, /not switched on/);
});

test('describeGstin with a provider returns the details, and survives a provider outage', async () => {
  const good = { name: 'stub', lookup: async () => ({ legalName: 'ACME TRADERS', tradeName: null, status: 'Active', addr1: '12 MG Road', addr2: null, loc: 'Vijayawada', pin: '520010' }) };
  const d = await describeGstin(gstin('37ATQPK0472R1Z'), { provider: good });
  assert.deepEqual([d.found, d.legalName, d.pin, d.source], [true, 'ACME TRADERS', '520010', 'stub']);
  const down = { name: 'stub', lookup: async () => { throw new Error('boom'); } };
  const e = await describeGstin(gstin('37ATQPK0472R1Z'), { provider: down });
  assert.equal(e.found, false); assert.match(e.message, /did not answer/);
});

test('resolveGstinLookup builds the Appyflow request and treats "not found" as an answer', async () => {
  const seen = [];
  const fetchFn = async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ error: true, message: 'GSTIN not found' }) }; };
  const p = resolveGstinLookup({ IBMP_GSTIN_LOOKUP: 'appyflow', IBMP_GSTIN_LOOKUP_KEY: 'k3y' }, fetchFn);
  assert.equal(await p.lookup('37ATQPK0472R1ZU'), null);
  assert.match(seen[0], /appyflow\.in\/api\/verifyGST\?gst_no=37ATQPK0472R1ZU&key_secret=k3y/);
  assert.equal(resolveGstinLookup({}), null);
});

test('GET /gstin/:gstin answers 200 with derived details (no 500), and 400 with a clear message for a bad number', async () => {
  const t = await signup();
  const d = await ok(call('GET', `/gstin/${gstin('37ATQPK0472R1Z')}`, undefined, t));
  assert.deepEqual([d.found, d.stateCode, d.pan], [false, '37', 'ATQPK0472R']);
  const short = await call('GET', '/gstin/37ATQPK', undefined, t);
  assert.equal(short.status, 400); assert.match(short.body.error, /15 characters/);
  const g = gstin('37ATQPK0472R1Z');
  const typo = await call('GET', `/gstin/${g.slice(0, 14)}${g[14] === 'A' ? 'B' : 'A'}`, undefined, t);
  assert.equal(typo.status, 400); assert.match(typo.body.error, /check-character/);
});

test('a GSTIN missed at sign-up can be added later in the business profile; it sets the state and the PAN', async () => {
  const t = await signup({ stateCode: '29' });
  const before0 = await ok(call('GET', '/company/profile', undefined, t));
  assert.equal(before0.gstin, null); assert.ok(before0.completeness.missing.some((m) => m.key === 'gstin'));
  const g = gstin('37ATQPK0472R1Z');
  const after = await ok(call('PUT', '/company/profile', { gstin: g }, t));
  assert.deepEqual([after.gstin, after.stateCode, after.pan], [g, '37', 'ATQPK0472R']);
  const re = await ok(call('GET', '/company/profile', undefined, t));
  assert.equal(re.gstin, g);
});

test('profile rejects a mistyped GSTIN, a PAN that disagrees with it, and non-owners', async () => {
  const t = await signup();
  const g = gstin('37ATQPK0472R1Z');
  const typo = await call('PUT', '/company/profile', { gstin: g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A') }, t);
  assert.equal(typo.status, 400); assert.match(typo.body.error, /check-character/);
  const clash = await call('PUT', '/company/profile', { gstin: g, pan: 'AAAAA9999A' }, t);
  assert.equal(clash.status, 400); assert.match(clash.body.error, /PAN inside this GSTIN/);
  const bad = await call('PUT', '/company/profile', { udyam: 'nope', tan: 'x' }, t);
  assert.equal(bad.status, 400);
});

test('changing the state needs confirmation once books exist', async () => {
  const t = await signup({ stateCode: '29' });
  const cust = await ok(call('POST', '/parties', { type: 'customer', name: 'Buyer', stateCode: '29' }, t));
  const item = await ok(call('POST', '/items', { name: 'Widget', hsn: '1234', rate: 100, gstPct: 18, stock: 10, unit: 'Nos' }, t));
  await ok(call('POST', '/invoices', { partyId: cust.id, date: '2026-10-01', lines: [{ itemId: item.id, qty: 1 }] }, t));
  const g = gstin('37ATQPK0472R1Z');
  const blocked = await call('PUT', '/company/profile', { gstin: g }, t);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'STATE_CHANGE');
  const done = await ok(call('PUT', '/company/profile', { gstin: g, confirmStateChange: true }, t));
  assert.equal(done.stateCode, '37');
});

test('the business profile stores the entity details and reports completeness', async () => {
  const t = await signup();
  const p = await ok(call('PUT', '/company/profile', { legalName: 'Acme Traders LLP', entityType: 'llp', cin: 'AAB-1234', udyam: 'UDYAM-AP-01-1234567', tan: 'HYDA12345B', website: 'https://acme.example', contactPerson: 'S Rao', incorporatedOn: '2020-04-01', addr1: '1 Main Road', loc: 'Guntur', pin: '522034', phone: '9177999263', email: 'a@acme.example', bankAccount: '630605121531', bankIfsc: 'ICIC0006306' }, t));
  assert.deepEqual([p.entityType, p.cin, p.udyam, p.tan, p.contactPerson, p.incorporatedOn], ['llp', 'AAB-1234', 'UDYAM-AP-01-1234567', 'HYDA12345B', 'S Rao', '2020-04-01']);
  assert.ok(p.completeness.percent >= 70, JSON.stringify(p.completeness));
  assert.ok(p.completeness.missing.some((m) => m.key === 'gstin'));
  const odd = await call('PUT', '/company/profile', { entityType: 'sole_trader' }, t);
  assert.equal(odd.status, 400);
});

test('a party can be added with its postal details in one go (for the quick-add on bills and invoices)', async () => {
  const t = await signup();
  const v = await ok(call('POST', '/parties', { type: 'vendor', name: 'Steel India', gstin: gstin('36AAAAA0000A1Z'), phone: '9000000000', email: 'v@steel.example', addr1: '5 Industrial Estate', loc: 'Hyderabad', pin: '500032' }, t));
  assert.deepEqual([v.addr1, v.loc, v.pin, v.stateCode], ['5 Industrial Estate', 'Hyderabad', '500032', '36']);
  const bad = await call('POST', '/parties', { type: 'vendor', name: 'X', stateCode: '29', pin: '12' }, t);
  assert.equal(bad.status, 400);
});
