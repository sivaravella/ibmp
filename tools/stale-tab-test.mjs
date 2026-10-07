// Reproduces "This screen hit a problem" after a new version is deployed: opens the app, rebuilds the web app underneath it (so the screen
// files get new names), then opens a screen the tab had not loaded yet. The page must recover on its own.
//   node tools/stale-tab-test.mjs      (the portal must be running with seeded demo users; this rebuilds apps/web/dist)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:4000';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (await (await fetch(BASE + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@ibmp.in', password: 'password123' }) })).json()).token;

const port = 9700 + Math.floor(Math.random() * 250), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmp-stale-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let failed = false;
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(200); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ibmp_token', ${JSON.stringify(token)})` });
  await send('Page.navigate', { url: BASE + '/' }); await sleep(2000);
  const nav = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('aside nav button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
  await nav('Invoices'); await sleep(1200);
  console.log('before the new version: Invoices open =', /Export CSV/.test(await evaluate('document.body.innerText')));

  console.log('building a new version underneath the open tab...');
  // File names carry a hash of the content, so change the source a little to get new names, then put it back.
  const root = path.resolve(import.meta.dirname, '..');
  const touched = ['apps/web/src/pages/Ledger.jsx', 'apps/web/src/App.jsx'].map((f) => path.join(root, f));
  const original = touched.map((f) => fs.readFileSync(f, 'utf8'));
  try {
    touched.forEach((f, i) => fs.writeFileSync(f, original[i] + '\nwindow.__staleTabTest = ' + Date.now() + ';\n'));     // a comment would be stripped and the build would keep its names
    execSync('npm run build', { cwd: root, stdio: 'ignore' });
  } finally { touched.forEach((f, i) => fs.writeFileSync(f, original[i])); }
  await sleep(500);
  const bust = fs.readdirSync(path.resolve(import.meta.dirname, '../apps/web/dist/assets')).length;     // index.html now names different files

  await nav('Ledger'); await sleep(4500);        // a screen this tab never loaded: its old file no longer exists
  const text = await evaluate('document.body.innerText'), hash = await evaluate('location.hash');
  const ok = !/This screen hit a problem|IBMP has been updated/.test(text) && /Ledger|Journal|Trial balance/.test(text) && hash === '#/ledger';
  console.log(`after the new version: address ${hash}, Ledger open without an error = ${ok} (${bust} files in the new build)`);
  failed = !ok;
  ws.close();
} finally { proc.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still releasing */ } }
process.exit(failed ? 1 : 0);
