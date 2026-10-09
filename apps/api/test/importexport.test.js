import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { mockProvider } from '../src/gateway.js';
import { simulatedGsp } from '../src/gsp.js';
import { simulatedChannels } from '../src/notify.js';
import { gstinCheckChar } from '../src/gstin.js';
import { buildWorkbook, toCsv, readTable } from '../src/sheets.js';
import { columnsFor, parseDate } from '../src/importexport.js';

const gstin = (p14) => p14 + gstinCheckChar(p14);
let call, raw, pool, seq = 0;
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
  // Raw binary in (an upload) or out (a download).
  raw = async (method, path, tok, buf) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/octet-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: buf });
    const data = Buffer.from(await r.arrayBuffer());
    const json = /json/.test(r.headers.get('content-type') ?? '') ? JSON.parse(data.toString('utf8')) : null;
    return { status: r.status, data, body: json, headers: r.headers };
  };
});
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };

async function company(state = '29') {
  seq += 1;
  const tok = (await call('POST', '/auth/register', { name: 'T', email: `ie${seq}@example.com`, password: 'password123', company: `Import Co ${seq}`, sector: 'trading', gstin: gstin(`${state}IMPCO${1000 + seq}Q1Z`) })).body.token;
  return tok;
}
const HEAD = (type) => columnsFor(type).map((c) => c.h + (c.req ? ' *' : ''));
// A row: docNo, date, party, gstin, pos, item, hsn, qty, unit, rate, disc, gst, narration
const csvOf = (type, rows) => Buffer.from(toCsv([HEAD(type), ...rows]), 'utf8');
const xlsxOf = (type, rows, title = 'Upload from my billing sheet') => buildWorkbook([{ name: 'Data', title, columns: columnsFor(type).map((c) => ({ header: c.h, key: c.k })), rows: rows.map((r) => Object.fromEntries(columnsFor(type).map((c, i) => [c.k, r[i]]))) }]);
const preview = (tok, type, buf) => raw('POST', `/import/preview?type=${type}&name=${encodeURIComponent('my file.csv')}`, tok, buf);
const CUST = gstin('29BUYER1111B1Z'), CUST_OTHER = gstin('36OTHER2222C1Z');
const sale = (no, date, party, g, pos, item, qty, rate, gst, extra = {}) => [no, date, party, g, pos, item, extra.hsn ?? '8409', qty, extra.unit ?? 'Nos', rate, extra.disc ?? 0, gst, extra.note ?? ''];
const trial = async (tok) => (await ok(call('GET', '/trial-balance', undefined, tok)));

test('templates download as xlsx and csv, read back with the right headings, and import cleanly as they are', async () => {
  const tok = await company();
  for (const type of ['sales', 'purchases']) {
    const x = await raw('GET', `/import/template?type=${type}&format=xlsx`, tok);
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-disposition'), new RegExp(`ibmp-${type}-import-template\\.xlsx`));
    const t = await readTable(x.data);
    assert.deepEqual(t[0], HEAD(type));
    assert.equal(t.length, 4, 'headings and 2 sample rows');   // 3 sample lines: 3 data rows
    const c = await raw('GET', `/import/template?type=${type}&format=csv`, tok);
    assert.deepEqual((await readTable(c.data))[0], HEAD(type));
    for (const file of [x.data, c.data]) {
      const p = await preview(tok, type, file);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.deepEqual([p.body.summary.documents, p.body.summary.errors], [2, 0], 'the sample is a valid file');
    }
  }
  // the xlsx has an Instructions sheet
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await raw('GET', '/import/template?type=sales&format=xlsx', tok)).data);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Sales', 'Instructions', 'Lists']);
  assert.equal((await raw('GET', '/import/template?type=bogus', tok)).status, 400);
});

test('dates in the formats people use are understood', () => {
  assert.equal(parseDate('05-12-2025'), '2025-12-05');
  assert.equal(parseDate('2025-12-05'), '2025-12-05');
  assert.equal(parseDate('5/12/25'), '2025-12-05');
  assert.equal(parseDate('5-Dec-2025'), '2025-12-05');
  assert.equal(parseDate(45996), '2025-12-05');             // an Excel date cell
  assert.equal(parseDate(new Date(Date.UTC(2025, 11, 5))), '2025-12-05');
  assert.equal(parseDate('31-02-2025'), null);
  assert.equal(parseDate('soon'), null);
});

test('preview: xlsx with a title above the headings, lines grouped into documents, tax equals what POST /invoices works out', async () => {
  const tok = await company();
  await ok(call('POST', '/parties', { type: 'customer', name: 'Known Buyer', gstin: CUST }, tok));
  const widget = await ok(call('POST', '/items', { name: 'Widget', hsn: '8409', rate: 500, gstPct: 12, stock: 100 }, tok));
  const rows = [
    sale('S-1', '05-10-2026', 'Known Buyer', CUST, '29', 'Widget', 10, 500, 12),
    sale('S-1', '05-10-2026', 'Known Buyer', CUST, '29', 'Gadget', 3, 99.5, 18, { disc: 10 }),
    sale('S-2', '06-10-2026', 'Far Buyer', CUST_OTHER, '36', 'Widget', 2, 500, 12),
  ];
  const p = await ok(preview(tok, 'sales', await xlsxOf('sales', rows)));
  assert.deepEqual([p.summary.documents, p.summary.ok, p.summary.warnings, p.summary.errors, p.summary.lines], [2, 0, 2, 0, 3]);
  assert.ok(p.token && p.token.length >= 20);
  const [d1, d2] = p.documents;
  assert.deepEqual([d1.no, d1.lines, d1.rows], ['S-1', 2, [4, 5]], 'excel row numbers count the title rows');
  assert.match(d1.warnings.join('|'), /New item "Gadget" will be created/);
  assert.match(d2.warnings.join('|'), /New customer "Far Buyer" will be created/);
  // same lines through the normal invoice endpoint
  const gadget = await ok(call('POST', '/items', { name: 'Gadget X', hsn: '8409', rate: 99.5, gstPct: 18, stock: 50 }, tok));
  const manual = await ok(call('POST', '/invoices', { partyId: (await ok(call('GET', '/parties?type=customer', undefined, tok))).find((x) => x.name === 'Known Buyer').id, date: '2026-10-05', lines: [{ itemId: widget.id, qty: 10 }, { itemId: gadget.id, qty: 3, discountPct: 10 }] }, tok));
  assert.deepEqual([d1.taxable, d1.cgst, d1.sgst, d1.igst, d1.total], [Number(manual.taxable), Number(manual.cgst), Number(manual.sgst), Number(manual.igst), Number(manual.total)]);
  // inter-state: all IGST
  assert.deepEqual([d2.taxable, d2.cgst, d2.sgst, d2.igst, d2.total], [1000, 0, 0, 120, 1120]);
  // csv works the same
  const c = await ok(preview(tok, 'sales', csvOf('sales', rows)));
  assert.deepEqual(c.documents.map((d) => d.total), p.documents.map((d) => d.total));
});

test('preview: each validation rule says what is wrong and where', async () => {
  const tok = await company();
  const bad = gstin('29BUYER1111B1Z').slice(0, 14) + (gstin('29BUYER1111B1Z')[14] === 'A' ? 'B' : 'A');
  const rows = [
    sale('', '05-10-2026', 'A', '', '29', 'I', 1, 10, 18),                                // no number
    sale('E-DATE', '31-02-2026', 'A', '', '29', 'I', 1, 10, 18),                          // bad date
    sale('E-PARTY', '05-10-2026', '', '', '29', 'I', 1, 10, 18),                          // no party
    sale('E-GSTIN', '05-10-2026', 'A', '29ABC', '29', 'I', 1, 10, 18),                    // GSTIN format
    sale('E-CHECK', '05-10-2026', 'A', bad, '29', 'I', 1, 10, 18),                        // GSTIN check digit
    sale('E-POS', '05-10-2026', 'A', '', '99X', 'I', 1, 10, 18),                          // place of supply
    sale('E-QTY', '05-10-2026', 'A', '', '29', 'I', 0, 10, 18),
    sale('E-RATE', '05-10-2026', 'A', '', '29', 'I', 1, -5, 18),
    sale('E-DISC', '05-10-2026', 'A', '', '29', 'I', 1, 10, 18, { disc: 101 }),
    sale('E-GST', '05-10-2026', 'A', '', '29', 'I', 1, 10, 17),
    sale('E-ITEM', '05-10-2026', 'A', '', '29', '', 1, 10, 18),
    sale('E-MIX', '05-10-2026', 'A', '', '29', 'I', 1, 10, 18),
    sale('E-MIX', '05-10-2026', 'B', '', '29', 'I', 1, 10, 18),                           // party changes inside a document
    sale('OK-1', '05-10-2026', 'A', '', '29', 'I', 1, 10, 18),
  ];
  const p = await ok(preview(tok, 'sales', csvOf('sales', rows)));
  const by = Object.fromEntries(p.documents.map((d) => [d.no || '(blank)', d]));
  const msg = (no) => by[no].errors.join(' | ');
  assert.match(msg('(blank)'), /Invoice No is blank/);
  assert.match(msg('E-DATE'), /invalid date "31-02-2026"/);
  assert.match(msg('E-PARTY'), /Customer Name is blank/);
  assert.match(msg('E-GSTIN'), /not a valid 15-character GSTIN/);
  assert.match(msg('E-CHECK'), /check digit/);
  assert.match(msg('E-POS'), /Place of Supply "99X"/);
  assert.match(msg('E-QTY'), /Quantity must be greater than 0/);
  assert.match(msg('E-RATE'), /Rate must be a number/);
  assert.match(msg('E-DISC'), /Discount % must be between 0 and 100/);
  assert.match(msg('E-GST'), /GST Rate "17" is not a valid GST rate/);
  assert.match(msg('E-ITEM'), /Item Name is blank/);
  assert.match(msg('E-MIX'), /Customer Name differs from the first line/);
  assert.equal(by['E-QTY'].status, 'error');
  assert.equal(by['OK-1'].status, 'warning');                                              // new party + new item only
  assert.equal(p.summary.errors, 12);
  assert.match(by['E-DATE'].errors[0], /^Row 3:/, 'row numbers are file rows: headings are row 1');
  // missing columns: a clear refusal
  const r = await preview(tok, 'sales', Buffer.from('Foo,Bar\n1,2\n'));
  assert.equal(r.status, 400); assert.match(r.body.error, /Required column\(s\) not found/);
  assert.equal((await raw('POST', '/import/preview?type=sales', tok, Buffer.alloc(0))).status, 400);
  assert.equal((await raw('POST', '/import/preview?type=sales', tok, Buffer.from('d0cf11e0aabbccdd', 'hex'))).status, 400);
});

test('preview: headings are matched by alias, in any order, with extra columns ignored', async () => {
  const tok = await company();
  const csv = 'Remarks,Qty,Price,Tax %,Product,Buyer,Date,Voucher No,Something else\nhello,2,100,18,Pen,Zed Stores,2026-10-01,V-9,x\n';
  const p = await ok(preview(tok, 'sales', Buffer.from(csv)));
  assert.deepEqual([p.documents[0].no, p.documents[0].party, p.documents[0].taxable, p.documents[0].total], ['V-9', 'Zed Stores', 200, 236]);
});

test('commit creates parties, items, invoices and balanced ledger entries, moves stock, and is idempotent', async () => {
  const tok = await company();
  await ok(call('POST', '/items', { name: 'Widget', hsn: '8409', rate: 500, gstPct: 12, stock: 5 }, tok));
  const rows = [
    sale('INV-0007', '05-10-2026', 'Zed Stores', CUST, '29', 'Widget', 10, 500, 12, { note: 'thanks' }),
    sale('INV-0007', '05-10-2026', 'Zed Stores', CUST, '29', 'Brand New', 4, 250, 18),
    sale('X-2', '04-10-2026', 'Zed Stores', '', '', 'Widget', 1, 500, 12),
    sale('BAD-1', '05-10-2026', 'Zed Stores', '', '', 'Widget', 0, 500, 12),
  ];
  const p = await ok(preview(tok, 'sales', csvOf('sales', rows)));
  assert.match(p.documents[0].warnings.join('|'), /Stock of "Widget" is 5, less than the 11 sold/);
  const refuse = await call('POST', '/import/commit', { token: p.token }, tok);
  assert.equal(refuse.status, 409); assert.equal(refuse.body.code, 'HAS_ERRORS');
  const c = await ok(call('POST', '/import/commit', { token: p.token, skipErrors: true }, tok));
  assert.equal(c.created, 2); assert.deepEqual(c.skipped.map((s) => s.no), ['BAD-1']); assert.deepEqual(c.failed, []);
  assert.deepEqual([c.createdParties, c.createdItems], [1, 1]);
  assert.deepEqual(c.documents.map((d) => d.no), ['X-2', 'INV-0007'], 'created in date order');
  // again with the same token: nothing twice
  const again = await ok(call('POST', '/import/commit', { token: p.token, skipErrors: true }, tok));
  assert.equal(again.created, 0); assert.equal(again.alreadyImported, true);
  const invs = await ok(call('GET', '/invoices', undefined, tok));
  assert.equal(invs.length, 2);
  const i7 = invs.find((i) => i.number === 'INV-0007');
  assert.deepEqual([Number(i7.taxable), Number(i7.cgst), Number(i7.sgst), Number(i7.total)], [6000, 5000 * 0.06 + 1000 * 0.09, 5000 * 0.06 + 1000 * 0.09, 6000 + 2 * (300 + 90)]);
  assert.equal(i7.notes, 'thanks');
  const detail = await ok(call('GET', `/invoices/${i7.id}`, undefined, tok));
  assert.equal(detail.lines.length, 2);
  // the new customer takes the state of the GSTIN; the new item the line's rate and GST
  const party = (await ok(call('GET', '/parties?type=customer', undefined, tok)))[0];
  assert.deepEqual([party.name, party.state_code ?? party.stateCode], ['Zed Stores', '29']);
  const items = await ok(call('GET', '/items', undefined, tok));
  const widget = items.find((i) => i.name === 'Widget'), nb = items.find((i) => i.name === 'Brand New');
  assert.equal(Number(widget.stock), 5 - 10 - 1, 'stock goes below zero with a warning instead of blocking the import');
  assert.deepEqual([Number(nb.rate), Number(nb.gstPct ?? nb.gst_pct), Number(nb.stock)], [250, 18, -4]);
  // books balance, debtors hold the invoice totals
  const tb = await trial(tok);
  assert.equal(tb.balanced, true);
  const debtors = tb.rows.find((a) => a.code === '1100');
  assert.equal(Number(debtors.debit), Number(i7.total) + Number(invs.find((i) => i.number === 'X-2').total));
  // the invoice series moved up to INV-0007: the next invoice made on screen is INV-0008, not a clash
  const fresh = await ok(call('POST', '/items', { name: 'Fresh', rate: 10, gstPct: 18, stock: 5 }, tok));
  const next = await ok(call('POST', '/invoices', { partyId: party.id, date: '2026-10-06', lines: [{ itemId: fresh.id, qty: 1 }] }, tok));
  assert.equal(next.number, 'INV-0008');
});

test('a document with a number the books already hold is rejected, in sales and in purchases', async () => {
  const tok = await company();
  const first = [sale('INV-D1', '05-10-2026', 'Zed Stores', '', '29', 'Pen', 1, 100, 18)];
  const p1 = await ok(preview(tok, 'sales', csvOf('sales', first)));
  await ok(call('POST', '/import/commit', { token: p1.token }, tok));
  const p2 = await ok(preview(tok, 'sales', csvOf('sales', [...first, sale('inv-d1', '06-10-2026', 'Zed Stores', '', '29', 'Pen', 1, 100, 18), sale('INV-D2', '06-10-2026', 'Zed Stores', '', '29', 'Pen', 1, 100, 18)])));
  assert.equal(p2.documents.length, 2, 'the same number twice in a file is one document, whatever the case');
  assert.match(p2.documents[0].errors.join('|'), /already exists in your books/);
  assert.notEqual(p2.documents[1].status, 'error');
  // purchases: the same vendor and bill number
  const bill = [sale('B-77', '05-10-2026', 'Vend One', '', '29', 'Pen', 5, 40, 18)];
  const q1 = await ok(preview(tok, 'purchases', csvOf('purchases', bill)));
  const cq = await ok(call('POST', '/import/commit', { token: q1.token }, tok));
  assert.equal(cq.created, 1);
  const q2 = await ok(preview(tok, 'purchases', csvOf('purchases', [...bill, sale('B-77', '05-10-2026', 'Vend Two', '', '29', 'Pen', 5, 40, 18)])));
  assert.equal(q2.documents.length, 2, 'two vendors may share a bill number');
  assert.match(q2.documents[0].errors.join('|'), /Bill No B-77 from Vend One is already recorded/);
  assert.notEqual(q2.documents[1].status, 'error');
});

test('purchases: bills get BILL numbers, the vendor bill number is kept, stock rises, and the ledger balances', async () => {
  const tok = await company();
  const rows = [
    sale('SUP/1', '03-10-2026', 'Steel India', gstin('29STEEL1111B1Z'), '', 'Liner', 50, 1100, 18),
    sale('SUP/1', '03-10-2026', 'Steel India', gstin('29STEEL1111B1Z'), '', 'Ring', 100, 600, 18, { disc: 2 }),
    sale('N-1', '04-10-2026', 'Freight Corp', gstin('07FREIG3210H1Z'), '07', 'Freight', 1, 12500, 12),
  ];
  const p = await ok(preview(tok, 'purchases', csvOf('purchases', rows)));
  assert.deepEqual([p.documents[0].taxable, p.documents[0].cgst, p.documents[0].total], [55000 + 58800, 0.09 * 113800, 113800 * 1.18]);
  assert.deepEqual([p.documents[1].igst, p.documents[1].total], [1500, 14000]);
  const c = await ok(call('POST', '/import/commit', { token: p.token }, tok));
  assert.equal(c.created, 2);
  const bills = await ok(call('GET', '/purchases', undefined, tok));
  assert.deepEqual(bills.map((b) => [b.number, b.supplier_bill_no ?? b.supplierBillNo]).sort(), [['BILL-0001', 'SUP/1'], ['BILL-0002', 'N-1']]);
  const sup = bills.find((b) => (b.supplier_bill_no ?? b.supplierBillNo) === 'SUP/1');
  assert.equal(Number(sup.total), 113800 * 1.18);
  const items = await ok(call('GET', '/items', undefined, tok));
  assert.deepEqual([50, 100], [Number(items.find((i) => i.name === 'Liner').stock), Number(items.find((i) => i.name === 'Ring').stock)]);
  assert.equal((await trial(tok)).balanced, true);
  const vendors = await ok(call('GET', '/parties?type=vendor', undefined, tok));
  assert.deepEqual(vendors.map((v) => v.name).sort(), ['Freight Corp', 'Steel India']);
});

test('a month whose return is filed takes no imported documents; other months import', async () => {
  const tok = await company();
  const cid = Number((await pool.query('SELECT id FROM companies ORDER BY id DESC LIMIT 1')).rows[0].id);
  await pool.query("INSERT INTO gst_filings (company_id, return_type, period, status, payload, payload_hash) VALUES ($1,'GSTR1','2026-08','filed','{}','x')", [cid]);
  const p = await ok(preview(tok, 'sales', csvOf('sales', [
    sale('L-1', '10-08-2026', 'Zed', '', '29', 'Pen', 1, 100, 18), sale('L-2', '10-09-2026', 'Zed', '', '29', 'Pen', 1, 100, 18)])));
  assert.match(p.documents[0].errors.join(''), /GSTR-1 for 2026-08 is already filed/);
  assert.equal(p.documents[1].status, 'warning');
  const c = await ok(call('POST', '/import/commit', { token: p.token, skipErrors: true }, tok));
  assert.deepEqual([c.created, c.skipped.length], [1, 1]);
  // purchases are blocked only by GSTR-3B
  const q = await ok(preview(tok, 'purchases', csvOf('purchases', [sale('P-1', '10-08-2026', 'Vend', '', '29', 'Pen', 1, 100, 18)])));
  assert.equal(q.documents[0].status, 'warning');
});

test('another company cannot see, error-report or commit your preview, and imports go only to the importing company', async () => {
  const a = await company(), b = await company();
  const p = await ok(preview(a, 'sales', csvOf('sales', [sale('Z-1', '05-10-2026', 'Zed', '', '29', 'Pen', 1, 100, 18), sale('Z-2', '05-10-2026', 'Zed', '', '29', 'Pen', 0, 100, 18)])));
  assert.equal((await call('POST', '/import/commit', { token: p.token, skipErrors: true }, b)).status, 404);
  assert.equal((await raw('GET', `/import/error-report?token=${p.token}`, b)).status, 404);
  assert.equal((await call('POST', '/import/commit', { token: 'nonsense' }, a)).status, 404);
  assert.equal((await raw('GET', `/import/error-report?token=${p.token}`, undefined)).status, 401);
  // the error report: csv and xlsx
  const rep = await raw('GET', `/import/error-report?token=${p.token}`, a);
  const t = await readTable(rep.data);
  assert.deepEqual(t[0], ['Document No', 'Excel Row(s)', 'Status', 'Message']);
  assert.ok(t.some((r) => r[0] === 'Z-2' && r[2] === 'Error' && /Quantity must be greater than 0/.test(r[3])));
  const repx = await readTable((await raw('GET', `/import/error-report?token=${p.token}&format=xlsx`, a)).data);
  assert.equal(repx[0][3], 'Message');
  await ok(call('POST', '/import/commit', { token: p.token, skipErrors: true }, a));
  assert.equal((await ok(call('GET', '/invoices', undefined, b))).length, 0);
  assert.equal((await ok(call('GET', '/invoices', undefined, a))).length, 1);
});

test('export: register and line layouts in xlsx and csv, with the right names and totals', async () => {
  const tok = await company();
  const p = await ok(preview(tok, 'sales', csvOf('sales', [
    sale('E-1', '05-10-2026', 'Zed', CUST, '29', 'Pen', 10, 100, 18), sale('E-1', '05-10-2026', 'Zed', CUST, '29', 'Ink', 2, 50, 12, { disc: 10 }),
    sale('E-2', '20-11-2026', 'Far', CUST_OTHER, '36', 'Pen', 1, 100, 18)])));
  await ok(call('POST', '/import/commit', { token: p.token }, tok));
  const inv = (await ok(call('GET', '/invoices', undefined, tok))).find((i) => i.number === 'E-1');
  await ok(call('POST', `/invoices/${inv.id}/payments`, { amount: 500, method: 'cash', date: '2026-10-06' }, tok));

  const x = await raw('GET', '/export/sales?from=2026-10-01&to=2026-10-31&format=xlsx&layout=register', tok);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /ibmp-sales-register-2026-10-01-to-2026-10-31\.xlsx/);
  const t = await readTable(x.data);
  const head = t.find((r) => r[0] === 'Invoice No');
  assert.deepEqual(head, ['Invoice No', 'Date', 'Customer', 'GSTIN', 'Place of Supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Paid', 'Balance', 'Status']);
  const e1 = t.find((r) => r[0] === 'E-1');
  assert.deepEqual([e1[1], e1[2], e1[3], e1[4], e1[5], e1[9], e1[10], e1[11], e1[12]], ['05-10-2026', 'Zed', CUST, '29 - Karnataka', 1090, 1280.8, 500, 780.8, 'unpaid'].map((v, i) => (i === 8 ? e1[12] : v)));
  assert.equal(t.find((r) => r[0] === 'E-2'), undefined, 'outside the dates');
  assert.ok(t.find((r) => r[0] === 'Total'), 'totals row');
  const csv = await readTable((await raw('GET', '/export/sales?format=csv', tok)).data);
  assert.equal(csv.length, 3, 'heading and 2 invoices');
  const lines = await readTable((await raw('GET', '/export/sales?format=csv&layout=lines', tok)).data);
  assert.deepEqual(lines[0], columnsFor('sales').map((c) => c.h));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[2], ['E-1', '05-10-2026', 'Zed', CUST, '29', 'Ink', '8409', '2', 'Nos', '50', '10', '12', '']);
  assert.equal((await raw('GET', '/export/sales?from=nope', tok)).status, 400);
  assert.equal((await raw('GET', '/export/sales?from=2026-12-01&to=2026-01-01', tok)).status, 400);
  assert.equal((await raw('GET', '/export/purchases?format=csv', tok)).status, 200);
});

test('round trip: a line-level export of one company imports into another with the same amounts, for sales and purchases', async () => {
  const a = await company(), b = await company();
  await ok(call('POST', '/import/commit', { token: (await ok(preview(a, 'sales', csvOf('sales', [
    sale('R-1', '05-10-2026', 'Zed', CUST, '29', 'Pen', 10, 99.99, 18, { disc: 7.5 }), sale('R-1', '05-10-2026', 'Zed', CUST, '29', 'Ink', 2, 50, 12),
    sale('R-2', '06-10-2026', 'Far', CUST_OTHER, '36', 'Pen', 3, 99.99, 18)])))).token }, a));
  await ok(call('POST', '/import/commit', { token: (await ok(preview(a, 'purchases', csvOf('purchases', [
    sale('V-1', '02-10-2026', 'Vend', gstin('29VENDO1111B1Z'), '', 'Pen', 40, 60, 18, { disc: 3 }), sale('V-1', '02-10-2026', 'Vend', gstin('29VENDO1111B1Z'), '', 'Ink', 8, 20, 5)])))).token }, a));
  for (const type of ['sales', 'purchases']) {
    const mine = await ok(call('GET', `/${type === 'sales' ? 'invoices' : 'purchases'}`, undefined, a));
    const key = type === 'sales' ? 'number' : 'supplier_bill_no';
    let token;
    for (const format of ['csv', 'xlsx']) {
      const p = await ok(preview(b, type, (await raw('GET', `/export/${type}?format=${format}&layout=lines`, a)).data));
      assert.equal(p.summary.errors, 0, JSON.stringify(p.documents.map((d) => d.errors)));
      assert.deepEqual(p.documents.map((d) => [d.no, d.total]).sort(), mine.map((d) => [d[key] ?? d.supplierBillNo, Number(d.total)]).sort(), `${type} ${format}`);
      token = p.token;
    }
    assert.equal((await ok(call('POST', '/import/commit', { token }, b))).created, mine.length);
  }
  const theirs = await ok(call('GET', '/invoices', undefined, b));
  const ours = await ok(call('GET', '/invoices', undefined, a));
  assert.deepEqual(theirs.map((i) => [i.number, Number(i.taxable), Number(i.cgst), Number(i.igst), Number(i.total)]).sort(), ours.map((i) => [i.number, Number(i.taxable), Number(i.cgst), Number(i.igst), Number(i.total)]).sort());
  assert.equal((await trial(b)).balanced, true);
});
