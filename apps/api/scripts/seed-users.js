// Creates (or confirms) the demo logins for trying every role, against a running portal. Safe to run again.
//   Business owner       owner@ibmp.in         an individual account with one company (Sunrise Traders)
//   Professional (CA)    ca.rao@ibmp.in        a consultant account, credentials VERIFIED by the platform owner
//   Professional (new)   cs.mehta@ibmp.in      a consultant account still awaiting verification
//   Platform owner      platform@ibmp.in      the platform console at /platform (owner: can change things)
//   Platform support    support@ibmp.in       the platform console, read-only
// The platform console also has a back-office key for scripts (header x-admin-key, key in .data/secrets.json).
// Demo passwords are fixed values for LOCAL demos only; never use them anywhere real. Real platform admins: npm run admin:create.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API || 'http://localhost:4000/v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const secretsFile = path.resolve(here, '..', '..', '..', '.data', 'secrets.json');
const adminKey = process.env.IBMP_ADMIN_API_KEY || (fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')).adminKey : null);
export const DEMO_PASSWORD = 'password123';

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function ensure(user) {
  const login = await call('POST', '/auth/login', { email: user.email, password: DEMO_PASSWORD });
  if (login.status === 200) return { ...user, created: false };
  const reg = await call('POST', '/auth/register', { ...user.register, email: user.email, password: DEMO_PASSWORD });
  if (reg.status !== 201) throw new Error(`${user.email}: ${JSON.stringify(reg.body)}`);
  return { ...user, created: true };
}

const users = [
  { email: 'owner@ibmp.in', role: 'Business owner', register: { name: 'Anita Sharma', company: 'Sunrise Traders', sector: 'trading', stateCode: '29' } },
  { email: 'ca.rao@ibmp.in', role: 'Professional (verified)', register: { name: 'CA Chandra Rao', company: 'Rao Tax Associates', sector: 'service', stateCode: '36', accountType: 'consultant', consultant: { body: 'ICAI', membershipNo: '210045', registeredName: 'Chandra Rao' } } },
  { email: 'cs.mehta@ibmp.in', role: 'Professional (pending verification)', register: { name: 'CS Neha Mehta', company: 'Mehta Compliance Services', sector: 'service', stateCode: '27', accountType: 'consultant', consultant: { body: 'ICSI', membershipNo: 'A54321', registeredName: 'Neha Mehta' } } },
];

for (const u of users) { const r = await ensure(u); console.log(`${r.created ? 'created' : 'exists '}  ${r.role.padEnd(36)} ${r.email}`); }

const PLATFORM_PASSWORD = 'platform-demo-123';
if (adminKey) {
  const h = { 'x-admin-key': adminKey };
  for (const [email, name, role] of [['platform@ibmp.in', 'Platform Owner', 'owner'], ['support@ibmp.in', 'Platform Support', 'support']]) {
    const login = await call('POST', '/platform/login', { email, password: PLATFORM_PASSWORD });
    if (login.status === 200) { console.log(`exists   Platform ${role.padEnd(28)} ${email}`); continue; }
    const made = await call('POST', '/admin/platform-admins', { email, name, password: PLATFORM_PASSWORD, role }, h);
    console.log(made.status === 201 ? `created  Platform ${role.padEnd(28)} ${email}` : `FAILED   ${email}: ${JSON.stringify(made.body)}`);
  }
  const list = await call('GET', '/admin/consultants', undefined, h);
  if (list.status !== 200) console.log('admin API not reachable:', list.status, list.body.error);
  else {
    const byEmail = new Map(list.body.map((c) => [c.email, c]));
    const rao = byEmail.get('ca.rao@ibmp.in');
    if (rao && rao.status !== 'verified') {
      await call('POST', `/admin/consultants/${rao.user_id ?? rao.userId}/decision`, { status: 'verified', note: 'Demo: credentials checked' }, h);
      console.log('platform owner verified ca.rao@ibmp.in');
    }
    const after = (await call('GET', '/admin/consultants', undefined, h)).body;
    for (const c of after.filter((x) => /@ibmp\.in$/.test(x.email))) console.log(`  consultant ${c.email}: ${c.status}`);
  }
} else console.log('No admin key found (.data/secrets.json): start the portal with npm run local first.');
