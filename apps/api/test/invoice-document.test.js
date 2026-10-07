import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';
import { computeInvoice, splitLineTax } from '../src/gst.js';
import { buildEinvoice } from '../src/einvoice.js';
import { STATES, stateName } from '../src/states.js';
import { amountInWords } from '../../web/src/ui/words.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);

// ---------- pure ----------
test('a line discount is taken off before tax, and the lines add up to the invoice exactly', () => {
  const c = computeInvoice([{ qty: 3, rate: 1000, gst_pct: 18, discount_pct: 10 }, { qty: 5, rate: 500, gst_pct: 12 }], '29', '29');
  assert.deepEqual([c.lines[0].discount, c.lines[0].taxable, c.lines[0].cgst, c.lines[0].sgst], [300, 2700, 243, 243]);
  assert.deepEqual([c.lines[1].discount, c.lines[1].taxable, c.lines[1].cgst, c.lines[1].sgst], [0, 2500, 150, 150]);
  assert.deepEqual([c.taxable, c.discount, c.cgst, c.sgst, c.igst, c.total], [5200, 300, 393, 393, 0, 5986]);
  const inter = computeInvoice([{ qty: 3, rate: 1000, gst_pct: 18, discount_pct: 10 }], '29', '27');
  assert.deepEqual([inter.lines[0].igst, inter.lines[0].cgst, inter.igst, inter.total], [486, 0, 486, 3186]);
});

test('odd paise are shared between lines so CGST and SGST each add up to the invoice figure', () => {
  // taxes of 167 and 51 paise: the invoice has 109 of CGST and 109 of SGST; the odd paisa goes to the first odd lines
  assert.deepEqual(splitLineTax([167, 51]), [{ cgst: 84, sgst: 83 }, { cgst: 25, sgst: 26 }]);
  assert.deepEqual(splitLineTax([100, 200]), [{ cgst: 50, sgst: 50 }, { cgst: 100, sgst: 100 }]);
  assert.deepEqual(splitLineTax([1]), [{ cgst: 0, sgst: 1 }]);
  const c = computeInvoice([{ qty: 1, rate: 33.33, gst_pct: 5 }, { qty: 1, rate: 10.10, gst_pct: 5 }], '29', '29');
  const p = (n) => Math.round(n * 100);
  assert.deepEqual([p(c.lines[0].cgst) + p(c.lines[1].cgst), p(c.lines[0].sgst) + p(c.lines[1].sgst), p(c.cgst), p(c.sgst)], [109, 109, 109, 109]);
});

test('a full discount leaves nothing to tax; the discount can never exceed the line', () => {
  const c = computeInvoice([{ qty: 2, rate: 100, gst_pct: 18, discount_pct: 100 }], '29', '29');
  assert.deepEqual([c.taxable, c.cgst, c.sgst, c.total, c.discount], [0, 0, 0, 0, 200]);
});

test('amount in words uses the Indian system', () => {
  assert.equal(amountInWords(0), 'Zero rupees only');
  assert.equal(amountInWords(1), 'One rupee only');
  assert.equal(amountInWords(5986), 'Five thousand nine hundred and eighty-six rupees only');
  assert.equal(amountInWords(100000), 'One lakh rupees only');
  assert.equal(amountInWords(1234567.5), 'Twelve lakh thirty-four thousand five hundred and sixty-seven rupees and fifty paise only');
  assert.equal(amountInWords(10000000), 'One crore rupees only');
  assert.equal(amountInWords(123456789), 'Twelve crore thirty-four lakh fifty-six thousand seven hundred and eighty-nine rupees only');
  assert.equal(amountInWords(0.05), 'Zero rupees and five paise only');
  assert.equal(amountInWords(19.99), 'Nineteen rupees and ninety-nine paise only');
});

test('state names for the place of supply', () => {
  assert.deepEqual([stateName('29'), stateName('27'), stateName('36'), stateName('07')], ['Karnataka', 'Maharashtra', 'Telangana', 'Delhi']);
  assert.ok(!('25' in STATES) && '99' in STATES);
});

const company = { gstin: gstin('29ABCDE1234F1Z'), name: 'Demo Traders', legal_name: 'Demo Traders Pvt Ltd', trade_name: 'Demo Traders', state_code: '29', addr1: '12 MG Road', addr2: null, loc: 'Bengaluru', pin: '560001', phone: '9876543210', email: 'a@demo.in' };
test('an e-invoice reports the gross amount, the discount and the assessable value of a discounted line', () => {
  const buyer = { gstin: gstin('29BBBBB1111B1Z'), name: 'Local Buyer', state_code: '29', addr1: '5 Brigade Road', loc: 'Bengaluru', pin: '560025' };
  const line = { item_id: 1, description: 'A', hsn: '8471', qty: 3, rate: 1000, gst_pct: 18, taxable: 2700 };
  const { payload: p, errors } = buildEinvoice({ type: 'INV', company, party: buyer, doc: { number: 'INV-0001', date: '2026-09-10', total: 3186, place_of_supply: '29' }, lines: [line], units: new Map([[1, 'Nos']]) });
  assert.deepEqual(errors, []);
  assert.deepEqual([p.ItemList[0].UnitPrice, p.ItemList[0].TotAmt, p.ItemList[0].Discount, p.ItemList[0].AssAmt, p.ItemList[0].CgstAmt], [1000, 3000, 300, 2700, 243]);
  assert.deepEqual([p.ValDtls.AssVal, p.ValDtls.TotInvVal], [2700, 3186]);
});

// ---------- API ----------
let pool, call, seq = 0;
before(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
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

async function world() {
  const t = (await call('POST', '/auth/register', { name: 'T', email: `invdoc${++seq}@example.com`, password: 'password123', company: `Doc Co ${seq}`, sector: 'trading', gstin: gstin('29ZYXWV5555Q1Z') }, null)).body.token;
  await ok(call('PUT', '/company/profile', { legalName: 'Doc Co Pvt Ltd', addr1: '12 MG Road', loc: 'Bengaluru', pin: '560001', bankName: 'HDFC Bank', bankAccount: '50100123456789', bankIfsc: 'hdfc0001234', bankBranch: 'MG Road', upiId: 'docco@hdfcbank', invoiceTerms: 'Goods once sold will not be taken back.', signatory: 'A. Rao', paymentDays: 15 }, t));
  const local = await ok(call('POST', '/parties', { type: 'customer', name: 'Local Buyer', gstin: gstin('29BBBBB1111B1Z') }, t));
  const far = await ok(call('POST', '/parties', { type: 'customer', name: 'Far Buyer', stateCode: '27' }, t));
  const a = await ok(call('POST', '/items', { name: 'Laptop', hsn: '8471', rate: 1000, gstPct: 18, stock: 100, unit: 'Nos' }, t));
  const b = await ok(call('POST', '/items', { name: 'T-shirt', hsn: '6109', rate: 500, gstPct: 12, stock: 100 }, t));
  return { t, local, far, a, b };
}

test('API: company details printed on invoices are validated and saved', async () => {
  const { t } = await world();
  const p = await ok(call('GET', '/company/profile', undefined, t));
  assert.deepEqual([p.bankName, p.bankAccount, p.bankIfsc, p.upiId, p.signatory, p.paymentDays], ['HDFC Bank', '50100123456789', 'HDFC0001234', 'docco@hdfcbank', 'A. Rao', 15]);
  assert.equal((await call('PUT', '/company/profile', { bankIfsc: 'nope' }, t)).status, 400);
  assert.equal((await call('PUT', '/company/profile', { bankAccount: '12ab' }, t)).status, 400);
  assert.equal((await call('PUT', '/company/profile', { upiId: 'no-at-sign' }, t)).status, 400);
  assert.equal((await call('PUT', '/company/profile', { paymentDays: 400 }, t)).status, 400);
  assert.equal((await ok(call('PUT', '/company/profile', { bankName: '' }, t))).bankName, null, 'an empty value clears it');
});

test('API: an invoice with discounts, terms and a delivery address, as a document', async () => {
  const { t, local, a, b } = await world();
  const inv = await ok(call('POST', '/invoices', {
    partyId: local.id, date: '2026-09-10', reference: 'PO-778', notes: 'Deliver before Diwali', shipTo: 'Warehouse 4, Peenya, Bengaluru 560058',
    lines: [{ itemId: a.id, qty: 3, discountPct: 10, description: 'Laptop 14-inch' }, { itemId: b.id, qty: 5 }],
  }, t));
  assert.deepEqual([Number(inv.taxable), Number(inv.discount), Number(inv.cgst), Number(inv.sgst), Number(inv.total)], [5200, 300, 393, 393, 5986]);
  assert.equal(String(inv.dueDate).slice(0, 10), '2026-09-25', 'the default credit period of 15 days');

  const d = await ok(call('GET', `/invoices/${inv.id}/document`, undefined, t));
  assert.deepEqual([d.invoice.reference, d.invoice.notes, d.invoice.shipTo, d.invoice.placeOfSupply, d.invoice.placeOfSupplyName, d.invoice.intra], ['PO-778', 'Deliver before Diwali', 'Warehouse 4, Peenya, Bengaluru 560058', '29', 'Karnataka', true]);
  assert.deepEqual(d.invoice.lines.map((l) => [l.description, l.hsn, Number(l.qty), l.unit, Number(l.rate), Number(l.discount), Number(l.taxable), Number(l.cgst), Number(l.sgst)]),
    [['Laptop 14-inch', '8471', 3, 'Nos', 1000, 300, 2700, 243, 243], ['T-shirt', '6109', 5, 'Nos', 500, 0, 2500, 150, 150]]);
  assert.deepEqual([d.company.name, d.company.gstin.slice(0, 2), d.company.stateName, d.company.bankIfsc, d.company.upiId, d.company.terms, d.company.signatory, d.company.pan], ['Doc Co Pvt Ltd', '29', 'Karnataka', 'HDFC0001234', 'docco@hdfcbank', 'Goods once sold will not be taken back.', 'A. Rao', 'ZYXWV5555Q']);
  assert.deepEqual([d.party.name, d.party.gstin, d.party.stateName], ['Local Buyer', gstin('29BBBBB1111B1Z'), 'Karnataka']);
  assert.deepEqual(d.taxSummary.map((x) => [x.hsn, x.rate, x.taxable, x.cgst, x.sgst, x.igst, x.tax]), [['8471', 18, 2700, 243, 243, 0, 486], ['6109', 12, 2500, 150, 150, 0, 300]]);
  assert.equal(d.taxSummary.reduce((s, x) => s + x.tax, 0), 786, 'the summary adds up to the invoice tax');
  assert.deepEqual([d.einvoice, d.ewaybill, d.invoice.balance], [null, null, 5986]);

  // an invoice made before per-line tax was stored shows the same figures
  await pool.query('UPDATE invoice_lines SET cgst=NULL, sgst=NULL, igst=NULL WHERE invoice_id=$1', [inv.id]);
  const old = await ok(call('GET', `/invoices/${inv.id}/document`, undefined, t));
  assert.deepEqual(old.invoice.lines.map((l) => [Number(l.cgst), Number(l.sgst)]), [[243, 243], [150, 150]]);
  assert.equal((await call('GET', '/invoices/999999/document', undefined, t)).status, 404);
});

test('API: the place of supply decides the tax, and the due date and discount are checked', async () => {
  const { t, local, far, a } = await world();
  // a Karnataka buyer, but the goods are supplied in Maharashtra: IGST
  const igst = await ok(call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', placeOfSupply: '27', lines: [{ itemId: a.id, qty: 1 }] }, t));
  assert.deepEqual([igst.placeOfSupply, Number(igst.igst), Number(igst.cgst)], ['27', 180, 0]);
  const doc = await ok(call('GET', `/invoices/${igst.id}/document`, undefined, t));
  assert.deepEqual([doc.invoice.intra, doc.invoice.placeOfSupplyName, Number(doc.invoice.lines[0].igst), Number(doc.invoice.lines[0].cgst)], [false, 'Maharashtra', 180, 0]);
  const dflt = await ok(call('POST', '/invoices', { partyId: far.id, date: '2026-09-10', lines: [{ itemId: a.id, qty: 1 }] }, t));
  assert.equal(dflt.placeOfSupply, '27', "the buyer's state when nothing else is given");

  assert.equal((await call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', dueDate: '2026-09-01', lines: [{ itemId: a.id, qty: 1 }] }, t)).status, 400, 'due before the invoice date');
  assert.equal((await call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', placeOfSupply: '25', lines: [{ itemId: a.id, qty: 1 }] }, t)).status, 400, 'not a GST state code');
  assert.equal((await call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', lines: [{ itemId: a.id, qty: 1, discountPct: 120 }] }, t)).status, 400);
  assert.equal((await call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', lines: [{ itemId: a.id, qty: 1, discountPct: -5 }] }, t)).status, 400);
  const none = await ok(call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', dueDate: null, lines: [{ itemId: a.id, qty: 1 }] }, t));
  assert.equal(none.dueDate, null, 'no due date when it is cleared on purpose');
  const states = await ok(call('GET', '/meta/states', undefined, t));
  assert.deepEqual([states.length, states.find((s) => s.code === '29').name], [Object.keys(STATES).length, 'Karnataka']);
});

test('API: returning part of a discounted line credits what the buyer actually paid', async () => {
  const { t, local, a } = await world();
  const inv = await ok(call('POST', '/invoices', { partyId: local.id, date: '2026-09-10', lines: [{ itemId: a.id, qty: 3, discountPct: 10 }] }, t));   // 3 x 1000 less 10% = 2,700: 900 each
  const lines = (await ok(call('GET', `/invoices/${inv.id}/returnable`, undefined, t))).lines;
  const note = await ok(call('POST', `/invoices/${inv.id}/returns`, { date: '2026-09-12', lines: [{ lineId: lines[0].id, qty: 1 }] }, t));
  assert.equal(Number(note.taxable), 900, 'not 1,000');
  const rest = await ok(call('POST', `/invoices/${inv.id}/returns`, { date: '2026-09-13', full: true }, t));
  assert.equal(Number(rest.taxable), 1800, 'the remaining two units');
  assert.equal(Number((await ok(call('GET', `/invoices/${inv.id}`, undefined, t))).returned), 3186, 'everything returned: 2,700 plus 18% GST');
});

// ---------- the preview maths must equal the server's ----------
import { computeDraft, taxSummary as draftSummary, isBillOfSupply } from '../../web/src/ui/invoice-math.js';

test('the live preview computes exactly what the server saves (random invoices)', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
  for (let n = 0; n < 300; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
      qty: Math.round(rnd() * 50000) / 1000 + 0.001, rate: Math.round(rnd() * 500000) / 100, gst_pct: RATES[Math.floor(rnd() * RATES.length)], discount_pct: rnd() < 0.4 ? Math.round(rnd() * 3000) / 100 : 0,
    }));
    const pos = rnd() < 0.5 ? '29' : '27';
    const s = computeInvoice(lines, '29', pos);
    const d = computeDraft(lines.map((l) => ({ qty: l.qty, rate: l.rate, gstPct: l.gst_pct, discountPct: l.discount_pct })), '29', pos);
    assert.deepEqual([d.taxable, d.discount, d.cgst, d.sgst, d.igst, d.total], [s.taxable, s.discount, s.cgst, s.sgst, s.igst, s.total], `invoice ${n}`);
    assert.deepEqual(d.lines.map((l) => [l.taxable, l.discount, l.cgst, l.sgst, l.igst]), s.lines.map((l) => [l.taxable, l.discount, l.cgst, l.sgst, l.igst]), `lines of invoice ${n}`);
    // and the lines always add up to the invoice, to the paisa
    const p = (x) => Math.round(x * 100);
    assert.equal(s.lines.reduce((t, l) => t + p(l.cgst), 0), p(s.cgst));
    assert.equal(s.lines.reduce((t, l) => t + p(l.sgst), 0), p(s.sgst));
    assert.equal(s.lines.reduce((t, l) => t + p(l.igst), 0), p(s.igst));
  }
});

test('the tax summary groups by code and rate and a bill of supply is only for untaxed supplies', () => {
  const lines = computeDraft([{ hsn: '8471', qty: 1, rate: 1000, gstPct: 18 }, { hsn: '8471', qty: 2, rate: 500, gstPct: 18 }, { hsn: '6109', qty: 1, rate: 100, gstPct: 5 }, { hsn: '8471', qty: 1, rate: 100, gstPct: 12 }], '29', '29').lines;
  assert.deepEqual(draftSummary(lines).map((x) => [x.hsn, x.rate, x.taxable, x.tax]), [['8471', 18, 2000, 360], ['6109', 5, 100, 5], ['8471', 12, 100, 12]]);
  assert.equal(isBillOfSupply([{ gstPct: 0 }, { gstPct: 0 }]), true);
  assert.equal(isBillOfSupply([{ gstPct: 0 }, { gstPct: 5 }]), false);
  assert.equal(isBillOfSupply([]), false);
});
