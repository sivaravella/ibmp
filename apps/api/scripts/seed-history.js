// Fills a demo business with twelve months of varied activity (seasonal sales, collections, bills, returns) so the analytics
// dashboards have something to show. Uses the public API only. Safe to run again: it does nothing if the business already has history.
//   node scripts/seed-history.js [email] [password]        defaults to owner@ibmp.in
import { gstinCheckChar } from '../src/gstin.js';

const API = process.env.API || 'http://localhost:4000/v1';
const [email = 'owner@ibmp.in', password = 'password123'] = process.argv.slice(2);
let token;
const call = async (method, p, body) => {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
  return j;
};
token = (await call('POST', '/auth/login', { email, password })).token;
if ((await call('GET', '/invoices')).length > 10) { console.log('Already has history: nothing to do.'); process.exit(0); }

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gst = (p) => p + gstinCheckChar(p);

const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const dateIn = (monthsAgo, day) => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1)); d.setUTCDate(Math.min(day, monthsAgo === 0 ? today.getUTCDate() : 28)); return ymd(d); };

const items = [];
for (const [name, hsn, rate, gstPct] of [['Cotton kurta', '6109', 650, 5], ['Denim jeans', '6203', 1400, 12], ['Sports shoes', '6404', 2200, 18], ['Leather wallet', '4202', 900, 18], ['Silk saree', '5007', 4200, 5], ['Backpack', '4202', 1800, 18]]) {
  items.push(await call('POST', '/items', { name, hsn, rate, gstPct, stock: 5000 }));
}
const customers = [];
for (const [name, g] of [['Metro Fashions', '29AABCM1234A1Z'], ['Urban Threads LLP', '29AABFU5678B1Z'], ['Sri Lakshmi Stores', '36AAACS9012C1Z'], ['Orbit Retail', '27AAACO3456D1Z'], ['Green Valley Mart', '29AAACG7890E1Z'], ['Walk-in customers', null]]) {
  customers.push(await call('POST', '/parties', { type: 'customer', name, ...(g ? { gstin: gst(g) } : { stateCode: '29' }) }));
}
const vendors = [];
for (const [name, g] of [['Textile Mills Co', '29AAACT1111F1Z'], ['Footwear Wholesale', '33AAACF2222G1Z'], ['Packaging Depot', '29AAACP3333H1Z']]) {
  vendors.push(await call('POST', '/parties', { type: 'vendor', name, gstin: gst(g) }));
}

let billNo = 0, invoices = 0, bills = 0;
for (let m = 11; m >= 0; m--) {
  const season = 1 + 0.35 * Math.sin(((11 - m) / 12) * Math.PI * 2 - 1) + (11 - m) * 0.03;     // gentle growth with a seasonal wave
  const count = Math.max(2, Math.round((m === 0 ? 4 : 7) * season));
  const made = [];
  for (let i = 0; i < count; i++) {
    const day = 2 + Math.floor((i / count) * 24) + (rnd() < 0.5 ? 1 : 0);
    const date = dateIn(m, day);
    if (date > ymd(today)) continue;
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ itemId: pick(items).id, qty: 1 + Math.floor(rnd() * 14 * season) }));
    const inv = await call('POST', '/invoices', { partyId: pick(customers).id, date, lines });
    invoices++; made.push({ inv, date });
  }
  // collections: most older invoices are paid in full, some in part, recent ones mostly open
  for (const { inv, date } of made) {
    const age = m, r = rnd();
    const payDate = dateIn(Math.max(0, m - (rnd() < 0.3 ? 1 : 0)), 20 + Math.floor(rnd() * 6));
    const when = payDate < date ? date : payDate > ymd(today) ? ymd(today) : payDate;
    const full = age >= 2 ? r < 0.8 : age === 1 ? r < 0.5 : r < 0.25, part = !full && r < (age >= 2 ? 0.92 : 0.6);
    if (full) await call('POST', `/invoices/${inv.id}/payments`, { amount: Number(inv.total), mode: rnd() < 0.7 ? 'bank' : 'cash', date: when });
    else if (part) await call('POST', `/invoices/${inv.id}/payments`, { amount: Math.round(Number(inv.total) * (0.3 + rnd() * 0.4)), mode: 'bank', date: when });
  }
  // an occasional return
  if (made.length > 3 && rnd() < 0.5) {
    const { inv, date } = made[1];
    try {
      const lines = (await call('GET', `/invoices/${inv.id}/returnable`)).lines;
      await call('POST', `/invoices/${inv.id}/returns`, { date: date > dateIn(m, 27) ? date : dateIn(m, 27), lines: [{ lineId: lines[0].id, qty: 1 }] });
    } catch { /* nothing returnable */ }
  }
  // vendor bills, mostly paid
  for (let b = 0; b < (m === 0 ? 1 : 2 + Math.floor(rnd() * 2)); b++) {
    const date = dateIn(m, 3 + b * 9);
    if (date > ymd(today)) continue;
    const it = pick(items);
    const bill = await call('POST', '/purchases', { partyId: pick(vendors).id, supplierBillNo: `SUP-${++billNo}`, date, lines: [{ itemId: it.id, qty: 20 + Math.floor(rnd() * 60 * season), rate: Math.round(it.rate * 0.62) }] });
    bills++;
    if (m >= 1 && rnd() < 0.85) await call('POST', `/purchases/${bill.id}/payments`, { amount: Number(bill.total), mode: 'bank', date: dateIn(m, 24) > ymd(today) ? ymd(today) : dateIn(m, 24) });
  }
}
console.log(`Seeded ${invoices} invoices and ${bills} bills for ${email}.`);
