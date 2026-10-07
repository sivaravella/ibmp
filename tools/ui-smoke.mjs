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

// A screen is its menu text, or [menu text, { subs: other views to open (exact button text), opens: buttons that open a drawer }].
// A drawer button written as 'View>Button' first opens the view, then the drawer.
const BUSINESS_TABS = ['Dashboard', ['Invoices', { screens: ['New invoice', 'first row'] }], ['Purchases', { opens: ['New bill'] }], 'Returns', ['Parties', { opens: ['Add party'] }], ['Items', { opens: ['Add item'] }],
  ['Ledger', { subs: ['Journal', 'Trial balance', 'Party statements'], opens: ['Chart of accounts>Add account', 'Journal>Manual journal'] }], ['GST reports', { subs: ['GSTR-3B summary'] }], 'GST filing',
  ['E-invoice & e-way', { subs: ['E-way bills', 'Setup'] }], ['TDS & Form 16', { subs: ['Form 16', 'Other payments & 26Q', 'Setup & challans'] }], 'Compliance',
  ['Payroll', { subs: ['Employees'], opens: ['Employees>Add employee'] }], 'Attendance', ['Leave', { subs: ['Balances', 'Leave types'], opens: ['Applications>Apply for leave'] }], 'PF & ESI', 'Companies', ['Billing', { subs: ['Invoices'] }]];
const PLATFORM_TABS = ['Overview', 'Consultants', 'Companies', 'Billing', 'Audit log', 'Staff & account'];
const ROLES = [
  { name: 'business owner (rich data)', url: '/v1/auth/login', body: { email: 'demo@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: BUSINESS_TABS },
  { name: 'business owner (12-month history)', url: '/v1/auth/login', body: { email: 'owner@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: ['Dashboard', 'Invoices', 'Ledger', 'GST reports'] },
  { name: 'brand-new business owner (no data)', url: '/v1/auth/register', body: { name: 'Fresh User', email: `fresh${Date.now()}@example.com`, password: 'password123', company: 'Fresh Co', sector: 'trading', stateCode: '29' }, key: 'ibmp_token', path: '/', tabs: BUSINESS_TABS, rapid: true },
  { name: 'professional (practice)', url: '/v1/auth/login', body: { email: 'consultant@ibmp.in', password: 'password123' }, key: 'ibmp_token', path: '/', tabs: ['Dashboard', 'Companies', 'Compliance'] },
  { name: 'platform owner', url: '/v1/platform/login', body: { email: 'platform@ibmp.in', password: 'platform-demo-123' }, key: 'ibmp_platform_token', path: '/platform', tabs: PLATFORM_TABS },
  { name: 'platform support (read-only)', url: '/v1/platform/login', body: { email: 'support@ibmp.in', password: 'platform-demo-123' }, key: 'ibmp_platform_token', path: '/platform', tabs: PLATFORM_TABS },
];

async function session(role, run) {
  const login = await fetch(BASE + role.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(role.body) });
  if (!login.ok && login.status !== 201) throw new Error(`sign-in failed (${login.status}): run npm run seed:users first`);
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
    // Click a button inside the page content (not the menu) by its exact text.
    const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('main button, main a, .topbar button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const inspect = async (issues) => {
      const text = await evaluate('document.body.innerText');
      issues.push(...take());
      if (/This screen hit a problem/.test(text)) issues.push('error boundary shown');
      if (/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/.test(text)) issues.push(`bad value on screen: ${text.match(/.{0,25}(undefined|NaN|\[object Object\]|Invalid Date).{0,15}/)?.[0].replace(/\s+/g, ' ')}`);
      return text;
    };
    const record = (name, issues) => { checked++; if (issues.length) { failures++; console.log(`  FAIL  ${name}: ${issues.join('; ')}`); } else console.log(`  ok    ${name}`); };
    const closeDrawer = async () => { await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"); await sleep(300); };

    for (const entry of role.tabs) {
      const [tab, extra = {}] = Array.isArray(entry) ? entry : [entry];
      const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('aside nav button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(tab)})); if (!b) return false; b.click(); return true; })()`);
      await sleep(1500);
      const issues = [];
      if (!clicked) issues.push('navigation item not found');
      const text = await inspect(issues);
      if (text.trim().length < 150) issues.push('screen is almost empty');
      record(tab, issues);

      for (const sub of extra.subs ?? []) {
        const i = [];
        if (!(await press(sub))) i.push('view button not found');
        await sleep(1300);
        await inspect(i);
        record(`${tab} › ${sub}`, i);
      }
      // A full screen reached from this one: a button (or the first table row), then back with the "All invoices" button.
      for (const screen of extra.screens ?? []) {
        const i = [];
        const clicked2 = screen === 'first row' ? await evaluate("(() => { const r = document.querySelector('tr.row-click'); if (!r) return false; r.click(); return true; })()") : await press(screen);
        if (!clicked2) i.push(`"${screen}" not found`);
        await sleep(2200);
        const t2 = await inspect(i);
        if (t2.trim().length < 150) i.push('screen is almost empty');
        if (screen === 'New invoice' && !/Preview|TAX INVOICE|Tax Invoice/i.test(t2)) i.push('no invoice preview');
        if (screen === 'first row' && !/Place of supply/i.test(t2)) i.push('no invoice document');
        record(`${tab} › ${screen} (screen)`, i);
        await press('‹ All invoices'); await sleep(900);
      }
      for (const open of extra.opens ?? []) {
        const [view, button] = open.includes('>') ? open.split('>') : [null, open];
        const i = [];
        if (view) { await press(view); await sleep(1000); }
        if (!(await press(button))) i.push(`"${button}" not found`);
        await sleep(900);
        if (!(await evaluate("!!document.querySelector('[role=dialog]')"))) i.push('the drawer did not open');
        await inspect(i);
        record(`${tab} › ${button} (drawer)`, i);
        await closeDrawer();
      }
    }

    // Impatient clicking: every menu item in quick succession (screens still loading when the next is chosen), three times over.
    if (role.rapid || role.tabs === BUSINESS_TABS) {
      const i = [];
      take();
      for (let pass = 0; pass < 3; pass++) {
        const n = await evaluate("document.querySelectorAll('aside nav button').length");
        for (let k = 0; k < n; k++) { await evaluate(`document.querySelectorAll('aside nav button')[${pass % 2 ? n - 1 - k : k}]?.click()`); await sleep(pass === 2 ? 40 : 150); }
      }
      await sleep(3000);
      await inspect(i);
      record('Rapid navigation (3 passes)', i);
    }

    // Routing: the address follows the screen, a refresh stays on the invoice, the back button returns to the list.
    if (role.tabs === BUSINESS_TABS) {
      const i = [];
      await evaluate("[...document.querySelectorAll('aside nav button')].find((x) => x.textContent.trim().startsWith('Invoices')).click()"); await sleep(1200);
      await evaluate("document.querySelector('tr.row-click')?.click()"); await sleep(1500);
      if (!/^#\/invoice\?id=\d+$/.test(await evaluate('location.hash'))) i.push('the address did not follow the invoice screen');
      await evaluate('location.reload()'); await sleep(2500);
      if (!/Place of supply/i.test(await evaluate('document.body.innerText'))) i.push('refresh lost the invoice');
      await evaluate('history.back()'); await sleep(1500);
      if (!/Export CSV/.test(await evaluate('document.body.innerText'))) i.push('back did not return to the invoice list');
      i.push(...take());
      record('Routing (address, refresh, back)', i);
    }
  });
}
console.log(`\n${checked - failures} of ${checked} screens passed${failures ? `, ${failures} FAILED` : ''}.`);
process.exit(failures ? 1 : 0);
