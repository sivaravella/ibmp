// Seeds a demo company into a running API (npm run dev:mem, then: node seed-demo.js).
// Login: demo@ibmp.in / password123. The GST scenario is dated September 2026 (so GSTR-1 / GSTR-3B can be filed in the simulated GSP); GSTINs have valid check characters.
import { gstinCheckChar } from '../src/gstin.js';
const gst = (first14) => first14 + gstinCheckChar(first14);   // GSTINs with a valid check character, as the GST portal requires
const API = process.env.API || 'http://localhost:4000/v1';
let token;
const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
  return j;
};

token = (await call('POST', '/auth/register', { name: 'Demo', email: 'demo@ibmp.in', password: 'password123', company: 'Demo Traders', sector: 'trading', gstin: gst('29ABCDE1234F1Z') })).token;
const A = await call('POST', '/items', { name: 'Laptop', hsn: '8471', rate: 1000, gstPct: 18, stock: 0 });
const B = await call('POST', '/items', { name: 'T-shirt', hsn: '6109', rate: 500, gstPct: 12, stock: 0 });
const C = await call('POST', '/items', { name: 'Wheat', hsn: '1001', rate: 100, gstPct: 0, stock: 100 });
const v1 = await call('POST', '/parties', { type: 'vendor', name: 'Reg Vendor', gstin: gst('29AAAAA0000A1Z') });
const v2 = await call('POST', '/parties', { type: 'vendor', name: 'Unreg Vendor', stateCode: '29' });
const r1 = await call('POST', '/parties', { type: 'customer', name: 'Reg Local', gstin: gst('29BBBBB1111B1Z') });
const r2 = await call('POST', '/parties', { type: 'customer', name: 'Reg Inter', gstin: gst('27CCCCC2222C1Z') });
const u1 = await call('POST', '/parties', { type: 'customer', name: 'Unreg Local', stateCode: '29' });
const u2 = await call('POST', '/parties', { type: 'customer', name: 'Unreg Inter', stateCode: '27' });
const bill = await call('POST', '/purchases', { partyId: v1.id, supplierBillNo: 'V1', date: '2026-09-02', lines: [{ itemId: A.id, qty: 20, rate: 600 }, { itemId: B.id, qty: 50, rate: 300 }] });
await call('POST', '/purchases', { partyId: v2.id, supplierBillNo: 'V2', date: '2026-09-03', lines: [{ itemId: B.id, qty: 10, rate: 300 }] });
const sale = (partyId, lines) => call('POST', '/invoices', { partyId, date: '2026-09-10', lines });
const s1 = await sale(r1.id, [{ itemId: A.id, qty: 2 }, { itemId: B.id, qty: 4 }]);
await sale(r2.id, [{ itemId: A.id, qty: 1 }]);
const s3 = await sale(u1.id, [{ itemId: B.id, qty: 2 }]);
await sale(u2.id, [{ itemId: B.id, qty: 4 }]);
const s5 = await sale(u2.id, [{ itemId: A.id, qty: 1, rate: 250000 }]);
await sale(u1.id, [{ itemId: C.id, qty: 10 }]);
const line = async (kind, id, name) => (await call('GET', `/${kind}/${id}/returnable`)).lines.find((l) => l.description === name).id;
await call('POST', `/invoices/${s1.id}/returns`, { date: '2026-09-20', lines: [{ lineId: await line('invoices', s1.id, 'Laptop'), qty: 1 }] });
await call('POST', `/invoices/${s3.id}/returns`, { date: '2026-09-20', lines: [{ lineId: await line('invoices', s3.id, 'T-shirt'), qty: 1 }] });
await call('POST', `/invoices/${s5.id}/returns`, { date: '2026-09-20', type: 'value', lines: [{ lineId: await line('invoices', s5.id, 'Laptop'), amount: 10000 }] });
await call('POST', `/purchases/${bill.id}/returns`, { date: '2026-09-21', lines: [{ lineId: await line('purchases', bill.id, 'T-shirt'), qty: 10 }] });
// E-invoice and e-way bill: business details, buyer addresses, e-invoicing switched on from September, an IRN for the first
// invoice and an e-way bill for the large inter-state one (both through the simulated GSP). INV-0002 is left needing an IRN.
await call('PUT', '/company/profile', { legalName: 'Demo Traders Pvt Ltd', addr1: '12-4-56, MG Road', loc: 'Bengaluru', pin: '560001', phone: '9876543210', email: 'accounts@demo.in' });
await call('PUT', `/parties/${r1.id}`, { addr1: '5 Brigade Road', loc: 'Bengaluru', pin: '560025' });
await call('PUT', `/parties/${r2.id}`, { addr1: '1 Marine Drive', loc: 'Mumbai', pin: '400001' });
await call('PUT', `/parties/${u2.id}`, { addr1: '44 Park Street', loc: 'Pune', pin: '411001' });
await call('PUT', '/einvoice/settings', { enabled: true, applicableFrom: '2026-09-01' });
await call('POST', '/filing/gsp/otp', { username: 'demo.gst' });
await call('POST', '/filing/gsp/session', { otp: '123456' });
const e1 = await call('POST', '/einvoice/prepare', { type: 'INV', docId: s1.id });
await call('POST', `/einvoice/${e1.id}/generate`, {});
const w5 = await call('POST', '/ewb/prepare', { invoiceId: s5.id, transport: { mode: 1, distance: 150, vehicleNo: 'KA01AB1234' } });
await call('POST', `/ewb/${w5.id}/generate`, {});
await call('DELETE', '/filing/gsp/session');       // leave the portal disconnected so the connect step can be demonstrated

// Payroll: the prototype's six employees; August paid and remitted, September left as a draft to edit.
const staff = [
  ['Ramesh Kumar', 'Senior Accountant', 'Accounts', '2021-03-15', 35000, 14000, 8000, 1600, 1250],
  ['Priya Sharma', 'HR Manager', 'HR', '2020-07-01', 40000, 16000, 10000, 1600, 1250],
  ['Suresh Rao', 'Sales Executive', 'Sales', '2022-01-10', 28000, 11200, 5000, 2000, 1250],
  ['Anitha Devi', 'Data Entry Operator', 'Accounts', '2023-06-01', 22000, 8800, 3000, 1600, 1250],
  ['Vijay Krishnan', 'IT Executive', 'IT', '2022-09-15', 32000, 12800, 7000, 1600, 1250],
  ['Lakshmi Nair', 'Admin Executive', 'Admin', '2021-11-01', 25000, 10000, 4000, 1600, 1250],
  ['Meera Iyer', 'Finance Director', 'Finance', '2022-05-01', 150000, 75000, 75000, 0, 0],   // high enough for TDS to apply
];
staff.push(['Ravi Kumar', 'Office Helper', 'Admin', '2024-02-01', 12000, 4000, 3000, 0, 0]);   // under ₹21,000 a month: covered by ESI
for (const [i, [name, designation, department, doj, basic, hra, special, travel, medical]] of staff.entries())
  await call('POST', '/payroll/employees', {
    name, designation, department, doj, basic, hra, special, travel, medical, ptMonthly: 200, uan: String(100200300400 + i),
    ...(basic + hra + special + travel + medical <= 21000 ? { esiNo: '2100123456' } : {}),
  });
// Attendance: Sundays off, two holidays, everyone else present by default; Suresh absent twice and Anitha a half day in September.
const team = await call('GET', '/payroll/employees');
await call('POST', '/attendance/holidays', { date: '2026-08-15', name: 'Independence Day' });
await call('POST', '/attendance/holidays', { date: '2026-09-14', name: 'Ganesh Chaturthi' });
for (const m of ['2026-08', '2026-09']) await call('POST', '/attendance/autofill', { month: m, presentByDefault: true });
const who = (name) => team.find((e) => e.name.startsWith(name)).id;
for (const [name, date, status] of [['Suresh', '2026-09-08', 'A'], ['Suresh', '2026-09-09', 'A'], ['Anitha', '2026-09-21', 'HD'], ['Vijay', '2026-09-22', 'L']])
  await call('PUT', '/attendance/mark', { employeeId: who(name), date, status });
// Leave: default types are created on first use. Ramesh takes 2 days of CL in September (approved), Vijay is on leave today,
// and Lakshmi has a pending request.
const lt = Object.fromEntries((await call('GET', '/leave/types')).map((t) => [t.code, t.id]));
const leave = async (name, code, from, to, decide) => {
  const a = await call('POST', '/leave/applications', { employeeId: who(name), leaveTypeId: lt[code], fromDate: from, toDate: to, reason: 'Personal' });
  if (decide) await call('POST', '/leave/applications/' + a.id + '/' + decide, {});
};
await leave('Ramesh', 'CL', '2026-09-02', '2026-09-03', 'approve');
await leave('Vijay', 'CL', new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10), 'approve');
await leave('Lakshmi', 'CL', '2026-10-12', '2026-10-13', null);
const aug = await call('POST', '/payroll/runs', { month: '2026-08' });
await call('POST', '/payroll/runs/' + aug.id + '/finalize', {});
await call('POST', '/payroll/runs/' + aug.id + '/pay', { mode: 'bank', date: '2026-08-31' });
for (const head of ['pf', 'esi', 'tds', 'pt']) { try { await call('POST', '/payroll/runs/' + aug.id + '/remit', { head, mode: 'bank', date: '2026-09-07' }); } catch { /* nothing to remit for this head */ } }
// TDS: deductor details and the August challan, so Form 24Q (Q2) has something to show; September is left unrecorded.
await call('PUT', '/tds/settings', { tan: 'BLRD12345B', responsibleName: 'Sree Rao', responsibleDesignation: 'Director', deductorType: 'Company' });
await call('PUT', '/tds/runs/' + aug.id + '/challan', { bsr: '0510308', serial: '00045' });
// PF and ESI: the references the EPFO and ESIC portals returned for August (September is left for the demo).
await call('PUT', '/statutory/runs/' + aug.id + '/refs', { pfTrrn: '2260826000123', esiChallan: '1020260900045' });
await call('POST', '/payroll/runs', { month: '2026-09' });

// Compliance: track from the start of the FY, deduct TDS, and record two filings so the calendar shows every status.
await call('PUT', '/compliance/settings', { track_from: '2026-04-01', tds_deductor: true });
await call('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR1_M', periodKey: '2026-08', completedOn: '2026-09-09', reference: 'ARN-DEMO-0809' });
await call('PUT', '/compliance/records', { fy: '2026-27', ruleCode: 'GSTR3B_M', periodKey: '2026-08', completedOn: '2026-09-24' });
console.log('Demo data seeded. Login: demo@ibmp.in / password123');

// A consultant: Rao & Associates manages three client companies from one login. Login: consultant@ibmp.in / password123.
{
  const reg = await call('POST', '/auth/register', {
    name: 'Chandra Rao', email: 'consultant@ibmp.in', password: 'password123', company: 'Rao & Associates', sector: 'service', gstin: gst('36ABCDE1234F1Z'),
    accountType: 'consultant', consultant: { body: 'ICAI', membershipNo: '123456', registeredName: 'Chandra Rao' },
  });
  token = reg.token;
  await call('PUT', '/compliance/settings', { track_from: '2026-04-01' });
  for (const [name, sector, gstin, stateCode] of [['Sri Lakshmi Traders', 'trading', gst('36AAAAA0000A1Z'), null], ['Kaveri Clinic', 'hospital', null, '29'], ['Bright Retail', 'retail', null, '37']]) {
    const c = await call('POST', '/companies', { name, sector, ...(gstin ? { gstin } : { stateCode }) });
    const t2 = (await call('POST', '/auth/switch', { companyId: c.id })).token;
    const home = token; token = t2;
    await call('PUT', '/compliance/settings', { track_from: '2026-04-01', tds_deductor: name.startsWith('Kaveri') });
    token = home;
  }
  console.log('Consultant seeded. Login: consultant@ibmp.in / password123');
}
