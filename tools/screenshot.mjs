// Design QA: signs in through the API, opens a page of the running portal in headless Chrome and saves a screenshot.
//   node tools/screenshot.mjs <path> <out.png> [--anon] [--as business|platform] [--email e] [--password p] [--w 1440] [--h 900] [--full] [--wait 1500] [--click "Button text" (prefix =Exact for an exact match)]
// Needs the portal running (npm run local) and Chrome or Edge installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let [route, out] = args;
if (/^[A-Za-z]:[\/]/.test(route)) throw new Error('The route was rewritten by Git Bash into a Windows path. Run with MSYS_NO_PATHCONV=1 (or pass the route without a leading slash).');
if (!route.startsWith('/')) route = '/' + route;
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const as = opt('as', route.startsWith('/platform') ? 'platform' : 'business');
const email = opt('email', as === 'platform' ? 'platform@ibmp.in' : 'demo@ibmp.in');
const password = opt('password', as === 'platform' ? 'platform-demo-123' : 'password123');
const W = Number(opt('w', 1440)), H = Number(opt('h', 900)), wait = Number(opt('wait', 1500)), full = args.includes('--full'), clicks = args.filter((a, i) => args[i - 1] === '--click' && a);   // --click "Text" (repeatable, in order)
const BASE = process.env.BASE || 'http://localhost:4000';

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('No Chrome or Edge found');

const storage = args.filter((a, i) => args[i - 1] === '--storage').map((kv) => kv.split('='));   // --storage key=value (repeatable): set localStorage before load
const anon = args.includes('--anon');   // show the signed-out screen
const login = anon ? null : await fetch(`${BASE}/v1/${as === 'platform' ? 'platform/login' : 'auth/login'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (login && !login.ok) throw new Error(`login failed: ${login.status}`);
const token = login ? (await login.json()).token : null;

const port = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmp-shot-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(200); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  const firstLine = (t) => String(t ?? '').split(String.fromCharCode(10))[0];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR:', firstLine(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('CONSOLE ERROR:', d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
  // Set the token before any page script runs, so the app starts signed in.
  if (token) await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('${as === 'platform' ? 'ibmp_platform_token' : 'ibmp_token'}', ${JSON.stringify(token)})` });
  if (storage.length) await send('Page.addScriptToEvaluateOnNewDocument', { source: storage.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(';') });
  await send('Page.navigate', { url: `${BASE}${route}` }); await sleep(wait);
  for (const click of clicks) {
    await send('Runtime.evaluate', { expression: `(() => { const b = [...document.querySelectorAll('button, a')].find((x) => (${JSON.stringify(click)}[0] === '=' ? x.textContent.trim() === ${JSON.stringify(click)}.slice(1) : x.textContent.trim().startsWith(${JSON.stringify(click)}))); if (b) b.click(); return !!b; })()` });
    await sleep(wait);
  }
  // Headless Chrome only advances animations when frames are produced, so pump some before capturing.
  await send('Runtime.evaluate', { expression: 'new Promise((r) => { let n = 0; const f = () => (++n > 45 ? r(true) : requestAnimationFrame(f)); f(); })', awaitPromise: true });
  await sleep(450);
  const evals = args.filter((x, i) => args[i - 1] === '--eval');
  for (const ex of evals) console.log('eval:', JSON.stringify((await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true })).result.result.value));
  const errors = await send('Runtime.evaluate', { expression: `document.body.innerText.match(/undefined|NaN|\\[object|Something went wrong/g)?.length ?? 0` });
  let clip;
  if (full) {
    const m = await send('Page.getLayoutMetrics');
    const h = Math.ceil(m.result.cssContentSize?.height ?? m.result.contentSize.height);
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: Math.min(h, 4000), deviceScaleFactor: 1, mobile: W < 700 });
    await sleep(400);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out} (${W}x${H}${full ? ' full' : ''}); suspicious text matches on page: ${errors.result.result.value}`);
  ws.close();
} finally {
  proc.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still releasing */ }
}
