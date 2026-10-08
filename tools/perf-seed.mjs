// Fills a throwaway company with many invoices, bills and parties through the API, then times the main endpoints.
//   node tools/perf-seed.mjs [invoices=3000] [parties=300]      (the portal must be running; it registers perf<timestamp>@example.com)
const B = process.env.BASE || 'http://localhost:4000/v1';
const N = Number(process.argv[2] || 3000), P = Number(process.argv[3] || 300);
const call = async (m, p, b, t) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const email = `perf${Date.now()}@example.com`;
const { token: t } = await call('POST', '/auth/register', { name: 'Perf', email, password: 'password123', company: 'Perf Traders', sector: 'trading', stateCode: '29' });
const items = []; for (let i = 0; i < 40; i++) items.push(await call('POST', '/items', { name: `Item ${i}`, hsn: String(1000 + (i % 30)), rate: 100 + i * 17, gstPct: [0, 5, 12, 18, 28][i % 5], stock: 1_000_000, unit: 'Nos' }, t));
const parties = []; const states = ['29', '27', '36', '33', '07'];
for (let i = 0; i < P; i++) parties.push(await call('POST', '/parties', { type: i % 4 === 3 ? 'vendor' : 'customer', name: `Party ${i}`, stateCode: states[i % 5] }, t));
const customers = parties.filter((p) => p.type === 'customer'), vendors = parties.filter((p) => p.type === 'vendor');
const rnd = (n) => Math.floor(Math.random() * n);
const day = (k) => new Date(Date.UTC(2026, 3, 1) + k * 86400000).toISOString().slice(0, 10);       // spread over 1 April .. 8 Oct
console.log(`seeding ${N} invoices and ${Math.round(N / 5)} bills for ${email} ...`);
const t0 = Date.now();
const pool = []; let done = 0;
const run = async (n, fn) => { const q = Array.from({ length: n }, (_, i) => i); await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const i = q.shift(); await fn(i); done++; } })); };
await run(N, (i) => call('POST', '/invoices', { partyId: customers[rnd(customers.length)].id, date: day(rnd(190)), lines: Array.from({ length: 1 + rnd(4) }, () => ({ itemId: items[rnd(items.length)].id, qty: 1 + rnd(5) })) }, t));
await run(Math.round(N / 5), (i) => call('POST', '/purchases', { partyId: vendors[rnd(vendors.length)].id, supplierBillNo: `PB-${i}`, date: day(rnd(190)), lines: [{ itemId: items[rnd(items.length)].id, qty: 1 + rnd(20), rate: 80, gstPct: 18 }] }, t));
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const time = async (label, path) => { const s = Date.now(); const r = await fetch(B + path, { headers: { authorization: 'Bearer ' + t } }); const b = await r.arrayBuffer(); console.log(`${String(Date.now() - s).padStart(6)} ms  ${String(Math.round(b.byteLength / 1024)).padStart(6)} KB  ${r.status}  ${label}`); };
console.log('\nendpoint timings:');
for (const [l, p] of [['invoices list', '/invoices'], ['purchases list', '/purchases'], ['parties', '/parties'], ['items', '/items'], ['analytics (dashboard)', '/analytics'], ['GSTR-1 for September', '/gst/gstr1?period=2026-09'], ['GSTR-3B for September', '/gst/gstr3b?period=2026-09'], ['GSTR-1 JSON export', '/filing/export/GSTR1?period=2026-09'], ['trial balance', '/ledger/trial'], ['journal', '/ledger/journal?limit=200'], ['accounts', '/ledger/accounts'], ['compliance', '/compliance'], ['returns', '/returns']]) { try { await time(l, p); } catch (e) { console.log('   error', l, e.message); } }
console.log(`\nlogin: ${email} / password123`);
