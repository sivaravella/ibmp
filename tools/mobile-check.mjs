// Mobile layout check: opens every screen at phone size (390 x 844, touch, mobile user agent) and reports anything that makes the page
// scroll sideways or pushes content past the screen edge, with a screenshot of each screen.
//   node tools/mobile-check.mjs [outDir] [width]      (the portal must be running with the demo data: npm run local, seed-users, seed-demo)
// Exit code 1 if any screen overflows, so it can gate a release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:4000';
const out = path.resolve(process.argv[2] || '.shots/mobile');
const W = Number(process.argv[3] || 390), H = 844;
fs.mkdirSync(out, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [route, what]. The invoice id is looked up from the API.
const SCREENS = ['dashboard', 'invoices', 'invoice-new', 'invoice', 'purchases', 'returns', 'parties', 'items', 'ledger', 'gst', 'filing', 'edocs', 'tds', 'compliance', 'payroll', 'attendance', 'leave', 'statutory', 'companies', 'billing', 'security'];

const login = await (await fetch(BASE + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@ibmp.in', password: 'password123' }) })).json();
const invoices = await (await fetch(BASE + '/v1/invoices', { headers: { authorization: 'Bearer ' + login.token } })).json();

const port = 9700 + Math.floor(Math.random() * 250), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmp-mobile-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let bad = 0;
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
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' });

  // What sticks out past the right edge, ignoring anything that scrolls on purpose (an overflow-x container) or is hidden.
  const probe = `(() => {
    const vw = document.documentElement.clientWidth, over = [];
    const scrolls = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      if (r.right > vw + 1 && !scrolls(el)) over.push((el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')) + ' +' + Math.round(r.right - vw));
    }
    const smallEls = [...document.querySelectorAll('button, a, select, input')].filter((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width && r.height && cs.visibility !== 'hidden' && (r.height < 30 || r.width < 30) && e.type !== 'checkbox' && e.type !== 'radio' && e.type !== 'hidden'; }); const small = smallEls.length; window.__small = smallEls.map((e) => e.tagName + '.' + (e.className || '') + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + ' ' + (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20)));
    return { vw, scrollW: document.documentElement.scrollWidth, over: [...new Set(over)].slice(0, 6), small, which: window.__small };
  })()`;

  const results = [];
  for (const name of ['login', ...SCREENS]) {
    if (name === 'login') {
      await send('Page.navigate', { url: BASE + '/' }); await sleep(1500);          // signed out: the sign-in screen
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ibmp_token', ${JSON.stringify(login.token)})` });
    } else {
      const hash = name === 'invoice' ? `#/invoice?id=${invoices[0].id}` : `#/${name}`;
      if (results.length === 1) {
        // the first signed-in screen needs a fresh document so the token is in place
        await send('Page.navigate', { url: 'about:blank' }); await send('Page.navigate', { url: BASE + '/' + hash }); await sleep(2800);
      } else { await evaluate(`location.hash = ${JSON.stringify(hash)}`); await sleep(1800); }
      // the screen must really have changed: the address and the page title name it
      const here = await evaluate('location.hash');
      if (here !== hash) { console.log(`FAIL  ${name.padEnd(12)} still at ${here}`); bad++; }
    }
    const r = await evaluate(probe);
    const sideways = r.scrollW > r.vw + 1;
    const flagged = sideways || r.over.length > 0;
    if (flagged) bad++;
    results.push({ name, ...r, flagged });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
    await evaluate('window.scrollTo(0, 1100)'); await sleep(250);          // the lists and tables are further down
    const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, `${name}-down.png`), Buffer.from(shot2.result.data, 'base64'));
    await evaluate('window.scrollTo(0, 0)');
    console.log(`${flagged ? 'FAIL' : 'ok  '}  ${name.padEnd(12)} page ${r.scrollW}px of ${r.vw}px${r.over.length ? `  past the edge: ${r.over.join(', ')}` : ''}${r.small ? `  (small tap targets: ${r.which.join('; ')})` : ''}`);
  }
  ws.close();
} finally { proc.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still releasing */ } }
console.log(`\n${SCREENS.length + 1 - bad} of ${SCREENS.length + 1} screens fit a ${W}px phone screen${bad ? `, ${bad} do not` : ''}. Screenshots in ${out}`);
process.exit(bad ? 1 : 0);
