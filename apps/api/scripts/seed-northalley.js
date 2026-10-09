// Fills an EMPTY company with a realistic year of dummy data (an IT services company in Hyderabad, FY 2026-27 up to 9 October 2026):
// profile, customers, vendors, items, sales invoices with part and full receipts, a credit note, purchase bills with payments, capital and
// expense journals, staff with payroll for July to September, compliance records and tasks. Everything goes through the public API
// (so every rule and posting is the app's own), signed in as the company owner with a short-lived token.
//   API=https://ibmp.apbiz.in/v1 TOKEN=<owner token> node scripts/seed-northalley.js
// It refuses to run if the company already has invoices, purchases or items.
import { gstinCheckChar } from '../src/gstin.js';

const API = process.env.API || 'http://localhost:4000/v1';
const token = process.env.TOKEN;
if (!token) { console.error('Set TOKEN to the owner\'s session token.'); process.exit(2); }
const gst = (first14) => first14 + gstinCheckChar(first14);
const call = async (method, path, body, soft = false) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (soft) { console.log(`  (skipped ${method} ${path}: ${j.error ?? r.status})`); return null; } throw new Error(`${method} ${path}: ${JSON.stringify(j)}`); }
  return j;
};
const step = (s) => console.log(`- ${s}`);

const have = { items: (await call('GET', '/items')).length, invoices: (await call('GET', '/invoices')).length, purchases: (await call('GET', '/purchases')).length };
if (have.items || have.invoices || have.purchases) { console.error('This company already has data; not seeding.', have); process.exit(1); }

step('profile');
const prof = await call('GET', '/company/profile');
await call('PUT', '/company/profile', {
  legalName: 'NorthAlley India Private Limited', tradeName: 'NorthAlley', entityType: 'private_limited', cin: 'U72900TG2020PTC141236', tan: 'HYDN04512B', incorporatedOn: '2020-06-15',
  addr1: 'Plot 42, Road No. 36, Jubilee Hills', loc: 'Hyderabad', pin: '500033', contactPerson: 'Accounts Team', phone: '4023550000', email: 'accounts@northalley.example', website: 'https://northalley.example',
  bankName: 'HDFC Bank', bankBranch: 'Jubilee Hills', bankAccount: '50200012345678', bankIfsc: 'HDFC0000123', upiId: 'northalley@hdfcbank',
  invoicePrefix: 'NA', paymentDays: 30, signatory: 'Authorised Signatory', invoiceTerms: 'Payment within 30 days of the invoice date. Interest at 18% a year on overdue amounts. Subject to Hyderabad jurisdiction.',
  ...(prof.pan ? {} : {}),
});

step('items');
const svc = async (name, hsn, rate, gstPct, unit = 'Nos') => call('POST', '/items', { name, hsn, rate, gstPct, unit, stock: 99999 });
const dev = await svc('Software development services', '998314', 150000, 18, 'Hrs');
const amc = await svc('Annual maintenance contract', '998313', 60000, 18);
const con = await svc('IT consulting (per day)', '998311', 25000, 18, 'Day');
const cld = await svc('Cloud hosting and managed services', '998315', 40000, 18);
const trn = await svc('Corporate training (per batch)', '999293', 35000, 18);
const lap = await call('POST', '/items', { name: 'Laptop', hsn: '8471', rate: 70000, gstPct: 18, unit: 'Nos', stock: 0 });
const fur = await call('POST', '/items', { name: 'Office furniture set', hsn: '9403', rate: 15000, gstPct: 18, unit: 'Nos', stock: 0 });
const sta = await call('POST', '/items', { name: 'Office stationery', hsn: '4820', rate: 250, gstPct: 12, unit: 'Nos', stock: 0 });

step('customers and vendors');
const cust = async (name, gstin, stateCode, extra = {}) => call('POST', '/parties', { type: 'customer', name, ...(gstin ? { gstin } : { stateCode }), ...extra });
const vend = async (name, gstin, stateCode, extra = {}) => call('POST', '/parties', { type: 'vendor', name, ...(gstin ? { gstin } : { stateCode }), ...extra });
const orbit = await cust('Orbit Technologies Pvt Ltd', gst('36AAACO1234B1Z'), null, { phone: '9848012345', email: 'ap@orbit.example', addr1: '8-2-120, Banjara Hills', loc: 'Hyderabad', pin: '500034' });
const zenith = await cust('Zenith Retail Solutions Pvt Ltd', gst('29AABCZ5678C1Z'), null, { phone: '9845098450', email: 'finance@zenith.example', addr1: '14, Brigade Road', loc: 'Bengaluru', pin: '560025' });
const meridian = await cust('Meridian Pharma Ltd', gst('27AAECM4321D1Z'), null, { phone: '9820098200', email: 'accounts@meridian.example', addr1: 'B-12, Andheri East', loc: 'Mumbai', pin: '400069' });
const coastal = await cust('Coastal Logistics LLP', gst('33AAJFC8765E1Z'), null, { phone: '9444094440', email: 'billing@coastal.example', addr1: '27, Anna Salai', loc: 'Chennai', pin: '600002' });
const leaf = await cust('Green Leaf Foundation', null, '36', { phone: '9848099999', email: 'office@greenleaf.example', addr1: '5-9-14, Abids', loc: 'Hyderabad', pin: '500001' });
const cloudnine = await vend('CloudNine Hosting Services', gst('29AAFCC1111A1Z'), null, { phone: '8044001100', email: 'billing@cloudnine.example', addr1: '3rd Floor, Embassy Tech Village', loc: 'Bengaluru', pin: '560103' });
const techmart = await vend('TechMart Computers', gst('36AAGCT3333C1Z'), null, { phone: '4027660000', email: 'sales@techmart.example', addr1: 'SD Road, Secunderabad', loc: 'Hyderabad', pin: '500003' });
const ravi = await vend('Ravi Kumar (freelance designer)', null, '36', { phone: '9000011111', pan: 'BQRPK4521L' });

step('capital and expenses (journals)');
const accts = Object.fromEntries((await call('GET', '/accounts')).map((a) => [a.code, a.id]));
const mk = async (code, name, type) => accts[code] ?? (accts[code] = (await call('POST', '/accounts', { code, name, type })).id);
await mk('5500', 'Software subscriptions', 'expense'); await mk('5510', 'Electricity and internet', 'expense'); await mk('5520', 'Travel and conveyance', 'expense'); await mk('5530', 'Bank charges', 'expense');
const jr = (date, narration, dr, cr, amount) => call('POST', '/journal', { date, narration, lines: [{ accountId: accts[dr], debit: amount }, { accountId: accts[cr], credit: amount }] });
await jr('2026-04-01', 'Share capital brought in by the directors', '1010', '3000', 3000000);
for (const m of ['04', '05', '06', '07', '08', '09', '10']) {
  await jr(`2026-${m}-05`, `Office rent for ${m}/2026`, '5410', '1010', 60000);
  await jr(`2026-${m}-12`, `Electricity and internet for ${m}/2026`, '5510', '1010', 14500 + Number(m) * 150);
}
await jr('2026-05-20', 'Annual accounting and ROC compliance fees', '5420', '1010', 42000);
await jr('2026-08-18', 'Quarterly GST and TDS return fees', '5420', '1010', 18000);
for (const [d, n, a] of [['2026-04-22', 'Project tools and licences', 24000], ['2026-07-14', 'Annual repository and CI subscription', 36000], ['2026-09-10', 'Design tool licences', 18500]]) await jr(d, n, '5500', '1010', a);
for (const [d, n, a] of [['2026-05-14', 'Client visit, Bengaluru', 21400], ['2026-07-28', 'Client visit, Mumbai', 26800], ['2026-09-24', 'Client visit, Chennai', 19250]]) await jr(d, n, '5520', '1010', a);
for (const m of ['06', '09']) await jr(`2026-${m}-30`, 'Bank charges and fees', '5530', '1010', 1180);
await jr('2026-09-30', 'Loan interest', '5450', '1010', 8400);

step('sales invoices and receipts');
// Quantities are scaled so the year shows a healthy profit once payroll and expenses are counted.
const SCALE = 2.2;
const L = (item, qty, rate) => ({ itemId: item.id, qty: Math.max(1, Math.round(qty * SCALE)), ...(rate ? { rate } : {}) });
const sales = [
  ['2026-04-12', orbit, [L(dev, 2)], 'full'], ['2026-04-28', zenith, [L(amc, 1)], 'full'], ['2026-05-10', meridian, [L(con, 8)], 'full'],
  ['2026-05-24', coastal, [L(cld, 3)], 'full'], ['2026-06-05', orbit, [L(trn, 2)], 'full'], ['2026-06-18', leaf, [L(trn, 1)], 'full'],
  ['2026-06-30', zenith, [L(dev, 1, 180000)], 'full'], ['2026-07-09', meridian, [L(amc, 2)], 'full'], ['2026-07-22', orbit, [L(cld, 2), L(con, 4)], 'full'],
  ['2026-08-06', coastal, [L(dev, 1)], 'part'], ['2026-08-19', zenith, [L(con, 10)], 'full'], ['2026-08-31', orbit, [L(amc, 1), L(trn, 1)], 'part'],
  ['2026-09-08', meridian, [L(dev, 2)], 'none'], ['2026-09-20', leaf, [L(con, 2)], 'none'], ['2026-09-27', coastal, [L(cld, 4)], 'none'],
  ['2026-10-03', orbit, [L(dev, 1), L(trn, 1)], 'none'], ['2026-10-07', zenith, [L(amc, 2)], 'none'],
];
const made = [];
for (const [date, party, lines, pay] of sales) {
  const inv = await call('POST', '/invoices', { partyId: party.id, date, lines, reference: `PO-${1000 + made.length * 7}` });
  made.push(inv);
  const total = Number(inv.total);
  const payDate = (days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
  if (pay === 'full') await call('POST', `/invoices/${inv.id}/payments`, { amount: total, mode: 'bank', date: payDate(26 + (made.length % 9)) });
  if (pay === 'part') await call('POST', `/invoices/${inv.id}/payments`, { amount: Math.round(total * 0.5), mode: 'bank', date: payDate(24) });
}
step('a credit note');
const inv7 = made[7];
const ret = await call('GET', `/invoices/${inv7.id}/returnable`, undefined, true);
if (ret) await call('POST', `/invoices/${inv7.id}/returns`, { date: '2026-07-30', type: 'value', lines: [{ lineId: ret.lines[0].id, amount: 5000 }] }, true);

const P = (item, qty, rate) => ({ itemId: item.id, qty, ...(rate ? { rate } : {}) });
step('purchase bills and payments');
const buys = [
  ['2026-04-03', techmart, 'TM/26/0412', [P(lap, 5, 68000)], 'full'], ['2026-04-15', techmart, 'TM/26/0455', [P(fur, 10, 14000)], 'full'], ['2026-05-02', cloudnine, 'CN-26-1187', [P(cld, 6, 28000)], 'full'],
  ['2026-06-11', ravi, 'RK-001', [{ itemId: con.id, qty: 6, rate: 8000, gstPct: 0 }], 'full'], ['2026-07-04', cloudnine, 'CN-26-1302', [P(cld, 6, 28500)], 'full'],
  ['2026-08-10', techmart, 'TM/26/0911', [P(lap, 2, 69000)], 'full'], ['2026-08-25', techmart, 'TM/26/0954', [P(sta, 40, 250)], 'full'],
  ['2026-09-06', cloudnine, 'CN-26-1455', [P(cld, 6, 29000)], 'part'], ['2026-10-02', ravi, 'RK-002', [{ itemId: con.id, qty: 4, rate: 8500, gstPct: 0 }], 'none'],
];
for (const [date, party, no, lines, pay] of buys) {
  const lns = lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, ...(l.gstPct !== undefined ? { gstPct: l.gstPct } : { gstPct: 18 }) }));
  if (lns[0].itemId === sta.id) lns[0].gstPct = 12;
  const b = await call('POST', '/purchases', { partyId: party.id, supplierBillNo: no, date, lines: lns });
  const total = Number(b.total);
  const payDate = (days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
  if (pay === 'full') await call('POST', `/purchases/${b.id}/payments`, { amount: total, mode: 'bank', date: payDate(20) });
  if (pay === 'part') await call('POST', `/purchases/${b.id}/payments`, { amount: Math.round(total * 0.4), mode: 'bank', date: payDate(15) });
}

step('staff, attendance and payroll');
const staff = [
  ['Anil Reddy', 'Engineering Manager', 'Engineering', '2020-07-01', 90000, 36000, 30000, 3200, 1250], ['Divya Sharma', 'Senior Software Engineer', 'Engineering', '2021-02-15', 70000, 28000, 20000, 3200, 1250],
  ['Karthik Rao', 'Software Engineer', 'Engineering', '2022-06-01', 48000, 19200, 12000, 3200, 1250], ['Meghana Iyer', 'QA Engineer', 'Engineering', '2023-01-09', 38000, 15200, 8000, 3200, 1250],
  ['Naveen Kumar', 'DevOps Engineer', 'Engineering', '2022-11-21', 52000, 20800, 14000, 3200, 1250], ['Pooja Nair', 'UI/UX Designer', 'Design', '2023-08-01', 42000, 16800, 9000, 3200, 1250],
  ['Sandeep Varma', 'Sales Manager', 'Sales', '2021-09-13', 60000, 24000, 18000, 3200, 1250], ['Swathi Reddy', 'Accounts Executive', 'Finance', '2024-02-01', 26000, 10400, 5000, 1600, 1250],
];
for (const [i, [name, designation, department, doj, basic, hra, special, travel, medical]] of staff.entries())
  await call('POST', '/payroll/employees', { name, designation, department, doj, basic, hra, special, travel, medical, ptMonthly: 200, uan: String(101200300400 + i) }, true);
await call('POST', '/attendance/holidays', { date: '2026-08-15', name: 'Independence Day' }, true);
await call('POST', '/attendance/holidays', { date: '2026-09-14', name: 'Ganesh Chaturthi' }, true);
await call('POST', '/attendance/holidays', { date: '2026-10-02', name: 'Gandhi Jayanti' }, true);
for (const m of ['2026-07', '2026-08', '2026-09']) await call('POST', '/attendance/autofill', { month: m, presentByDefault: true }, true);
for (const m of ['2026-07', '2026-08', '2026-09']) {
  const run = await call('POST', '/payroll/runs', { month: m }, true);
  if (!run) continue;
  await call('POST', `/payroll/runs/${run.id}/finalize`, {}, true);
  const [y, mo] = m.split('-').map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  await call('POST', `/payroll/runs/${run.id}/pay`, { mode: 'bank', date: `${m}-${String(last).padStart(2, '0')}` }, true);
  const next = new Date(Date.UTC(y, mo, 7)).toISOString().slice(0, 10);
  if (next <= '2026-10-09') for (const head of ['pf', 'esi', 'tds', 'pt']) await call('POST', `/payroll/runs/${run.id}/remit`, { head, mode: 'bank', date: next }, true);
}

step('compliance records');
await call('PUT', '/compliance/settings', { track_from: '2026-04-01', tds_deductor: true }, true);
for (const [m, g1, g3] of [['2026-04', '2026-05-10', '2026-05-19'], ['2026-05', '2026-06-09', '2026-06-20'], ['2026-06', '2026-07-10', '2026-07-19'], ['2026-07', '2026-08-09', '2026-08-18'], ['2026-08', '2026-09-10', '2026-09-19']]) {
  await call('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR1_M', periodKey: m, completedOn: g1, reference: `ARN-NA-${m}-R1` }, true);
  await call('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR3B_M', periodKey: m, completedOn: g3, reference: `ARN-NA-${m}-3B` }, true);
}

step('tasks');
const task = async (t, checklist = [], comments = []) => {
  const made1 = await call('POST', '/tasks', t, true);
  if (!made1) return;
  for (const text of checklist) await call('POST', `/tasks/${made1.id}/checklist`, { text }, true);
  for (const body of comments) await call('POST', `/tasks/${made1.id}/comments`, { body }, true);
  return made1;
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
await task({ title: 'File GSTR-1 for September', description: 'Prepare the sales register, check the e-invoices and file before the due date.', status: 'inprogress', priority: 'high', category: 'GST', assignee: 'Swathi Reddy', dueDate: day(1) },
  ['Reconcile the sales register', 'Check HSN summary', 'File and download the acknowledgement'], ['Orbit invoices are ready; waiting for the Coastal credit note.']);
await task({ title: 'Reconcile input tax credit for September', status: 'todo', priority: 'high', category: 'GST', assignee: 'Swathi Reddy', dueDate: day(5) }, ['Download the supplier statement (GSTR-2B)', 'Match against purchase bills', 'Chase the missing vendor bills']);
await task({ title: 'Deposit TDS for September', status: 'review', priority: 'critical', category: 'TDS', assignee: 'Anil Reddy', dueDate: day(-1) }, ['Prepare the challan', 'Get approval', 'Pay and save the receipt'], ['Challan prepared; please approve.']);
await task({ title: 'Renew cloud hosting contract', description: 'The CloudNine contract ends in December. Compare two quotes.', status: 'todo', priority: 'medium', category: 'Vendors', assignee: 'Naveen Kumar', dueDate: day(25) });
await task({ title: 'Collect pending payments from Meridian and Coastal', status: 'inprogress', priority: 'medium', category: 'Collections', assignee: 'Sandeep Varma', dueDate: day(3) }, ['Send reminder emails', 'Call the finance contact'], ['Meridian promised payment by next week.']);
await task({ title: 'Year-end planning with the auditor', status: 'todo', priority: 'low', category: 'Accounts', assignee: 'Anil Reddy', dueDate: day(60) });
await task({ title: 'Update the employee handbook', status: 'done', priority: 'low', category: 'HR', assignee: 'Pooja Nair', dueDate: day(-10) }, ['Review leave policy', 'Publish to the team']);
await task({ title: 'Renew the Udyam registration details', status: 'done', priority: 'medium', category: 'Registrations', assignee: 'Swathi Reddy', dueDate: day(-20) });

console.log('Done.');
