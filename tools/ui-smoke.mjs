// UI smoke test: signs in as each demo role in headless Chrome, opens every screen and fails on a crash, a console or page
// error, the error-boundary message, or values that should never reach a user (undefined, NaN, [object Object]).
//   node tools/ui-smoke.mjs [role filter]     e.g. node tools/ui-smoke.mjs platform
//   (the portal must be running: npm run local, then npm run seed:users)
// Exit code 1 if anything fails, so it can gate a release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:4000';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('No Chrome or Edge found'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUSINESS_TABS = ['Dashboard', 'Invoices', 'Purchases', 'Returns', 'Parties', 'Items', 'Ledger', 'GST reports', 'GST filing', 'E-invoice & e-way', 'TDS & Form 16', 'Compliance', 'Payroll', 'Attendance', 'Leave', 'PF & ESI', 'Companies', 'Billing'];
const PLATFORM_TABS = ['Overview', 'Consultants', 'Companies', 'Billing', 'Audit log', 'Staff & account'];
const ROLES = [
  { name: 'business owner (rich data)', url: '/v1/auth/login', body: { email: 'demo@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: BUSINESS_TABS },
  { name: 'business owner (12-month history)', url: '/v1/auth/login', body: { email: 'owner@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: ['Dashboard', 'Invoices', 'Ledger', 'GST reports'] },
  { name: 'professional (practice)', url: '/v1/auth/login', body: { email: 'consultant@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: ['Dashboard', 'Companies', 'Compliance'] },
  { name: 'platform owner', url: '/v1/platform/login', body: { email: 'platform@ibmp.in', password: 'platform-demo-123' }, key: 'ibmp_platform_token', path: '/platform', tabs: PLATFORM_TABS },
  { name: 'platform support (read-only)', url: '/v1/platform/login', body: { email: 'support@ibmp.in', password: 'platform-demo-123' }, key: 'ibmp_platform_token', path: '/platform', tabs: PLATFORM_TABS },
];

async function session(role, run) {
  const login = await fetch(BASE + role.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(role.body) });
  if (!login.ok) throw new Error(`sign-in failed (${login.status}): run npm run seed:users first`);
  const token = (await login.json()).token;
  const port = 9700 + Math.floor(Math.random() * 250), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmp-smoke-'));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(200); }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map(); let problems = [];
    const line = (t) => String(t ?? '').split(String.fromCharCode(10))[0];
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.exceptionThrown') problems.push(`page error: ${line(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)}`);
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(`console error: ${d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 160)}`);
      if (d.method === 'Network.responseReceived' && d.params.response.status >= 500) problems.push(`server error ${d.params.response.status}: ${d.params.response.url.replace(BASE, '')}`);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    });
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('${role.key}', ${JSON.stringify(token)})` });
    await send('Page.navigate', { url: BASE + role.path }); await sleep(1800);
    const take = () => { const p = problems; problems = []; return p; };
    const result = await run({ evaluate, take });
    ws.close();
    return result;
  } finally { proc.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still releasing */ } }
}

let failures = 0, checked = 0;
const only = process.argv[2];
for (const role of ROLES.filter((r) => !only || r.name.includes(only))) {
  console.log(`\n${role.name}`);
  await session(role, async ({ evaluate, take }) => {
    take();
    for (const tab of role.tabs) {
      const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('aside nav button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(tab)})); if (!b) return false; b.click(); return true; })()`);
      await sleep(1500);
      const text = await evaluate('document.body.innerText');
      const issues = take();
      if (!clicked) issues.push('navigation item not found');
      if (/This screen hit a problem/.test(text)) issues.push('error boundary shown');
      if (/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/.test(text)) issues.push(`bad value on screen: ${text.match(/.{0,25}(undefined|NaN|\[object Object\]|Invalid Date).{0,15}/)?.[0].replace(/\s+/g, ' ')}`);
      if (text.trim().length < 150) issues.push('screen is almost empty');
      checked++;
      if (issues.length) { failures++; console.log(`  FAIL  ${tab}: ${issues.join('; ')}`); } else console.log(`  ok    ${tab}`);
    }
  });
}
console.log(`\n${checked - failures} of ${checked} screens passed${failures ? `, ${failures} FAILED` : ''}.`);
process.exit(failures ? 1 : 0);
