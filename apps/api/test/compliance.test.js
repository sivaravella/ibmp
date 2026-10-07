import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { generateItems, fyOf, parseFy, prevFy, withStatus } from '../src/compliance.js';

const co = { gstin: '29ABCDE1234F1Z5', state_code: '29' };
const due = (items, rule, key) => items.find((i) => i.rule_code === rule && i.period_key === key)?.due;

test('financial year helpers', () => {
  assert.equal(parseFy('2026-27'), 2026);
  assert.equal(parseFy('2026-28'), null);
  assert.equal(parseFy('26-27'), null);
  assert.equal(fyOf('2026-03-31'), '2025-26');
  assert.equal(fyOf('2026-04-01'), '2026-27');
  assert.equal(prevFy('2026-27'), '2025-26');
  assert.equal(parseFy('2099-00'), 2099, 'century roll-over label is valid');
  assert.equal(prevFy('2100-01'), '2099-00');
});

test('GST monthly: GSTR-1 on the 11th, GSTR-3B on the 20th of the next month; March rolls into April', () => {
  const it = generateItems(co, { advance_tax: false }, '2026-27');
  assert.equal(due(it, 'GSTR1_M', '2026-10'), '2026-11-11');
  assert.equal(due(it, 'GSTR3B_M', '2026-10'), '2026-11-20');
  assert.equal(due(it, 'GSTR1_M', '2027-03'), '2027-04-11');
  assert.equal(due(it, 'GSTR3B_M', '2027-03'), '2027-04-20');
  assert.equal(due(it, 'GSTR3B_M', '2026-12'), '2027-01-20', 'December rolls into January');
  assert.equal(it.filter((i) => i.category === 'GST' && i.rule_code !== 'GSTR9').length, 24);
  assert.equal(due(it, 'GSTR9', 'FY2026-27'), '2027-12-31');
});

test('GST quarterly (QRMP): 13th for GSTR-1, 22nd/24th by state for 3B, PMT-06 on 25th for first two months', () => {
  const q = { advance_tax: false, gst_frequency: 'quarterly' };
  const ka = generateItems({ ...co, state_code: '29' }, q, '2026-27');
  const dl = generateItems({ ...co, state_code: '07' }, q, '2026-27');
  assert.equal(due(ka, 'GSTR1_Q', '2026-Q1'), '2026-07-13');
  assert.equal(due(ka, 'GSTR3B_Q', '2026-Q1'), '2026-07-22');
  assert.equal(due(dl, 'GSTR3B_Q', '2026-Q1'), '2026-07-24');
  assert.equal(due(ka, 'GSTR3B_Q', '2026-Q4'), '2027-04-22');
  assert.equal(due(ka, 'PMT06', '2026-04'), '2026-05-25');
  assert.equal(due(ka, 'PMT06', '2026-05'), '2026-06-25');
  assert.equal(due(ka, 'PMT06', '2026-06'), undefined, 'third month is covered by GSTR-3B');
  assert.equal(ka.filter((i) => i.rule_code === 'PMT06').length, 8);
  assert.equal(ka.filter((i) => i.rule_code === 'GSTR1_M').length, 0);
});

test('TDS, PF, ESI, advance tax, ITR and tax audit', () => {
  const it = generateItems(co, { tds_deductor: true, pf: true, esi: true, tax_audit: false }, '2026-27');
  assert.equal(due(it, 'TDS_PAY', '2026-10'), '2026-11-07');
  assert.equal(due(it, 'TDS_PAY', '2027-03'), '2027-04-30', 'March TDS is due 30 April');
  assert.equal(due(it, 'TDS_PAY', '2026-12'), '2027-01-07');
  assert.deepEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'].map((k) => due(it, 'TDS_RET', k)), ['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31']);
  assert.equal(due(it, 'PF', '2026-10'), '2026-11-15');
  assert.equal(due(it, 'ESI', '2027-03'), '2027-04-15');
  assert.deepEqual(['2026-15', '2026-45', '2026-75', '2026-100'].map((k) => due(it, 'ADV_TAX', k)), ['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15']);
  assert.equal(due(it, 'ITR', 'FY2026-27'), '2027-07-31');
  assert.equal(due(it, 'TAX_AUDIT', 'FY2026-27'), undefined);

  const audit = generateItems(co, { tax_audit: true }, '2026-27');
  assert.equal(due(audit, 'ITR', 'FY2026-27'), '2027-10-31');
  assert.equal(due(audit, 'TAX_AUDIT', 'FY2026-27'), '2027-09-30');
});

test('applicability follows the profile; no GSTIN means no GST items', () => {
  const none = generateItems({ gstin: null, state_code: '29' }, { advance_tax: false }, '2026-27');
  assert.deepEqual(none.map((i) => i.rule_code), ['ITR']);
  const keys = generateItems(co, { tds_deductor: true, pf: true, esi: true }, '2026-27').map((i) => `${i.rule_code}|${i.period_key}`);
  assert.equal(new Set(keys).size, keys.length, 'rule_code + period_key is unique');
  assert.throws(() => generateItems(co, {}, 'bogus'));
});

test('status: completed / overdue / due soon (7 days) / upcoming; overrides and late filing', () => {
  const item = { rule_code: 'X', period_key: 'p', name: 'n', category: 'GST', due: '2026-11-11' };
  assert.equal(withStatus(item, null, '2026-11-12').status, 'overdue');
  assert.equal(withStatus(item, null, '2026-11-12').days_to_due, -1);
  assert.equal(withStatus(item, null, '2026-11-11').status, 'due_soon', 'due today is not overdue');
  assert.equal(withStatus(item, null, '2026-11-04').status, 'due_soon');
  assert.equal(withStatus(item, null, '2026-11-03').status, 'upcoming');
  const ext = withStatus(item, { due_override: '2026-11-30' }, '2026-11-12');
  assert.deepEqual([ext.status, ext.due, ext.statutory_due, ext.overridden], ['upcoming', '2026-11-30', '2026-11-11', true]);
  assert.equal(withStatus(item, { completed_on: '2026-11-10' }, '2026-12-01').filed_late, false);
  const late = withStatus(item, { completed_on: '2026-11-13' }, '2026-12-01');
  assert.deepEqual([late.status, late.filed_late], ['completed', true]);
});

// ---- API ----
let base, token;
const api = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}/v1`;
  server.unref();
  token = (await api('POST', '/auth/register', {
    name: 'C', email: 'c@example.com', password: 'password123', company: 'Comp Co', sector: 'trading', gstin: '29ABCDE1234F1Z5',
  }, null)).body.token;
});

const list = async (asOf = '2026-11-05', fy = '2026-27', tok = token) => (await api('GET', `/compliance?fy=${fy}&asOf=${asOf}`, null, tok)).body;
const find = (l, rule, key) => l.items.find((i) => i.ruleCode === rule && i.periodKey === key);

test('API: new companies do not see periods before they signed up; tracking_from backfills', async () => {
  const old = await list('2026-11-05', '2020-21');
  assert.equal(old.items.length, 0);
  const s = (await api('GET', '/compliance/settings')).body;
  assert.equal(s.gstRegistered, true);
  assert.match(s.trackingFrom, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal((await api('PUT', '/compliance/settings', { trackFrom: '2026-04-01' })).status, 200);
  const l = await list();
  assert.equal(l.items.length, 24 + 1 + 4 + 1, '12x GSTR-1, 12x GSTR-3B, GSTR-9, 4 advance tax, ITR');
  // As of 5 Nov 2026: Apr-Sep GSTR-1/3B (12) + advance tax Jun & Sep (2) are past due; GSTR-1 for Oct (11 Nov) is due soon.
  assert.deepEqual([l.summary.overdue, l.summary.dueSoon, l.summary.completed], [14, 1, 0]);
  assert.equal(find(l, 'GSTR1_M', '2026-10').status, 'due_soon');
  assert.equal(find(l, 'GSTR3B_M', '2026-10').status, 'upcoming');
  assert.equal(find(l, 'GSTR3B_M', '2026-09').status, 'overdue');
  assert.deepEqual(find(l, 'GSTR1_M', '2026-10').link, { page: 'gst', period: '2026-10' });
  assert.deepEqual(l.items.map((i) => i.due), [...l.items.map((i) => i.due)].sort(), 'sorted by due date');
});

test('API: mark filed, filed late, undo, extension override and restore', async () => {
  const put = (b) => api('PUT', '/compliance/records', { fy: '2026-27', ...b });
  assert.equal((await put({ ruleCode: 'GSTR1_M', periodKey: '2026-09', completedOn: '2026-10-09', reference: 'ARN-123' })).status, 200);
  assert.equal((await put({ ruleCode: 'GSTR3B_M', periodKey: '2026-09', completedOn: '2026-10-25' })).status, 200);
  let l = await list();
  const a = find(l, 'GSTR1_M', '2026-09'), b = find(l, 'GSTR3B_M', '2026-09');
  assert.deepEqual([a.status, a.filedLate, a.reference], ['completed', false, 'ARN-123']);
  assert.deepEqual([b.status, b.filedLate], ['completed', true]);
  assert.deepEqual([l.summary.overdue, l.summary.completed], [12, 2]);

  // reference survives a later partial update; undo clears completion only
  await put({ ruleCode: 'GSTR1_M', periodKey: '2026-09', notes: 'filed by CA' });
  assert.equal(find(await list(), 'GSTR1_M', '2026-09').reference, 'ARN-123');
  await put({ ruleCode: 'GSTR1_M', periodKey: '2026-09', completedOn: null });
  const undone = find(await list(), 'GSTR1_M', '2026-09');
  assert.deepEqual([undone.status, undone.notes], ['overdue', 'filed by CA']);

  // government extension: Oct GSTR-1 moved from 11 Nov to 15 Nov
  await put({ ruleCode: 'GSTR1_M', periodKey: '2026-10', dueOverride: '2026-11-20', overrideNote: 'Notification extended' });
  let o = find(await list(), 'GSTR1_M', '2026-10');
  assert.deepEqual([o.status, o.due, o.statutoryDue, o.overridden, o.overrideNote], ['upcoming', '2026-11-20', '2026-11-11', true, 'Notification extended']);
  await put({ ruleCode: 'GSTR1_M', periodKey: '2026-10', dueOverride: null });
  o = find(await list(), 'GSTR1_M', '2026-10');
  assert.deepEqual([o.status, o.overridden, o.overrideNote], ['due_soon', false, null]);
});

test('API: settings change the generated items; QRMP replaces monthly GST items', async () => {
  await api('PUT', '/compliance/settings', { tdsDeductor: true, pf: true });
  let l = await list();
  assert.equal(l.items.filter((i) => i.category === 'TDS').length, 17, '12 payments, 4 quarterly returns, Form 16');
  assert.equal(l.items.filter((i) => i.category === 'PF').length, 12);

  await api('PUT', '/compliance/settings', { gstFrequency: 'quarterly' });
  l = await list();
  assert.equal(l.items.filter((i) => i.ruleCode === 'GSTR1_M').length, 0);
  assert.equal(find(l, 'GSTR3B_Q', '2026-Q2').due, '2026-10-22');
  assert.equal(find(l, 'GSTR1_Q', '2026-Q2').due, '2026-10-13');
  assert.equal(l.items.filter((i) => i.category === 'GST').length, 4 + 4 + 8 + 1);
  assert.equal((await api('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR1_M', periodKey: '2026-10', completedOn: '2026-11-01' })).status, 404,
    'monthly item does not exist for a quarterly filer');
  await api('PUT', '/compliance/settings', { gstFrequency: 'monthly', tdsDeductor: false, pf: false });
});

test('API: custom items and summary roll-up', async () => {
  const c = (await api('POST', '/compliance/custom', { name: 'Trade licence renewal', category: 'Custom', dueDate: '2026-11-03' }));
  assert.equal(c.status, 201);
  let l = await list();
  assert.equal(find(l, 'CUSTOM', c.body.periodKey).status, 'overdue');
  assert.equal((await api('PUT', '/compliance/records', { ruleCode: 'CUSTOM', periodKey: c.body.periodKey, completedOn: '2026-11-04' })).status, 200);
  assert.equal(find(await list(), 'CUSTOM', c.body.periodKey).status, 'completed');
  assert.equal(find(await list('2026-11-05', '2025-26'), 'CUSTOM', c.body.periodKey), undefined, 'custom items appear only in the FY of their due date');

  const sum = (await api('GET', '/compliance/summary?asOf=2026-11-05')).body;
  // 14 overdue in FY 2026-27, less the Sep GSTR-3B that was filed = 13, plus 3 from FY 2025-26 that fall due after
  // tracking started: March 2026 GSTR-1 (11 Apr) and GSTR-3B (20 Apr), and that year's ITR (31 Jul).
  assert.equal(sum.overdue, 16);
  assert.equal(sum.dueSoon, 1);
  assert.equal(sum.next[0].name, 'GSTR-1 - Oct 2026');
  assert.equal(sum.mostOverdue.length, 3);

  assert.equal((await api('DELETE', `/compliance/custom/${c.body.periodKey}`)).status, 200);
  assert.equal((await api('DELETE', `/compliance/custom/${c.body.periodKey}`)).status, 404);
});

test('API: validation and tenant isolation', async () => {
  assert.equal((await api('GET', '/compliance?fy=2026-28')).status, 400);
  assert.equal((await api('GET', '/compliance?asOf=tomorrow')).status, 400);
  assert.equal((await api('PUT', '/compliance/records', { ruleCode: 'NOPE', periodKey: 'x' })).status, 404);
  assert.equal((await api('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'ITR', periodKey: 'FY2026-27', completedOn: 'yesterday' })).status, 400);
  assert.equal((await api('PUT', '/compliance/settings', { gstFrequency: 'weekly' })).status, 400);
  assert.equal((await api('GET', '/compliance', null, null)).status, 401);

  const other = (await api('POST', '/auth/register', {
    name: 'O', email: 'o@example.com', password: 'password123', company: 'No GST', sector: 'retail', stateCode: '29',
  }, null)).body.token;
  assert.equal((await api('PUT', '/compliance/settings', { trackFrom: '2026-04-01' }, other)).status, 200);
  const l = await list('2026-11-05', '2026-27', other);
  assert.equal(l.gstRegistered, false);
  assert.equal(l.items.filter((i) => i.category === 'GST').length, 0);
  assert.equal(l.summary.completed, 0, "other company's filings are not visible");
  assert.equal((await api('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR1_M', periodKey: '2026-10', completedOn: '2026-11-01' }, other)).status, 404);
});
