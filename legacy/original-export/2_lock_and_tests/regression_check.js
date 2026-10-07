// IBMP regression check — compares a candidate build against the locked v6.0 baseline.
// Usage: node regression_check.js <file.html> [--baseline baseline.json] [--write-baseline]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2);
const file = path.resolve(args[0]);
const bIdx = args.indexOf('--baseline');
const baselinePath = bIdx > -1 ? args[bIdx + 1] : path.join(__dirname, 'baseline.json');
const writeBaseline = args.includes('--write-baseline');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.dismiss().catch(() => {}));

  await page.goto('file://' + file, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const result = { file: path.basename(file), steps: {} };

  // 1. Every inline handler must point to a defined global function
  result.missingHandlers = await page.evaluate(() => {
    const miss = new Set();
    const attrs = ['onclick', 'onchange', 'oninput', 'onkeyup', 'onkeydown', 'onsubmit', 'onblur', 'onfocus'];
    document.querySelectorAll('*').forEach(el => attrs.forEach(a => {
      const v = el.getAttribute(a); if (!v) return;
      (v.match(/(?:^|[;\s(!])([A-Za-z_$][\w$]*)\s*\(/g) || []).forEach(m => {
        const n = m.replace(/^[;\s(!]/, '').replace(/\s*\($/, '');
        if (['if', 'return', 'function', 'parseInt', 'parseFloat', 'alert', 'confirm', 'event', 'Number', 'String'].includes(n)) return;
        if (typeof window[n] !== 'function') miss.add(n);
      });
    }));
    return [...miss].sort();
  });

  // 2. Inventory: global functions and element IDs (baseline ones must survive)
  result.functions = await page.evaluate(() => Object.keys(window).filter(k => { try { return typeof window[k] === 'function' && !/^(webkit|on)/.test(k) && window[k].toString().indexOf('[native code]') < 0; } catch (e) { return false; } }).sort());
  result.ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map(e => e.id).sort());
  result.tabs = await page.evaluate(() => [...document.querySelectorAll('.tab[id^="tab-"]')].map(e => e.id.slice(4)));

  // 3. Navigate: landing -> demo -> every tab
  const step = async (name, fn) => {
    const before = errors.length;
    try { await page.evaluate(fn); await page.waitForTimeout(150); result.steps[name] = 'ok'; }
    catch (e) { result.steps[name] = 'THREW: ' + e.message.split('\n')[0]; }
    if (errors.length > before) result.steps[name] = 'ERRORS: ' + errors.slice(before).join(' | ');
  };
  await step('loadDemo', () => { if (typeof loadDemo === 'function') loadDemo(); goTo('screen-app'); });
  for (const t of result.tabs) await step('tab:' + t, `showTab(${JSON.stringify(t)})`);

  result.errors = errors;
  await browser.close();

  if (writeBaseline) {
    fs.writeFileSync(baselinePath, JSON.stringify(result, null, 2));
    console.log('Baseline written:', baselinePath);
    console.log('Functions:', result.functions.length, '| IDs:', result.ids.length, '| Tabs:', result.tabs.length, '| Errors:', errors.length, '| Missing handlers:', result.missingHandlers.length);
    console.log(JSON.stringify(result.steps, null, 1));
    return;
  }

  // Compare against baseline
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const fails = [];
  const lost = (a, b) => a.filter(x => !b.includes(x));
  lost(base.functions, result.functions).forEach(f => fails.push('Removed/renamed function: ' + f));
  lost([...new Set(base.ids)], result.ids).forEach(i => fails.push('Removed element id: ' + i));
  lost(base.tabs, result.tabs).forEach(t => fails.push('Removed tab: ' + t));
  lost(result.missingHandlers, base.missingHandlers).forEach(h => fails.push('Handler calls undefined function: ' + h));
  for (const [k, v] of Object.entries(base.steps)) if (v === 'ok' && result.steps[k] !== 'ok') fails.push(`Step "${k}" was ok, now: ${result.steps[k] || 'missing'}`);
  lost(result.errors, base.errors).forEach(e => fails.push('New error: ' + e));

  console.log(`\nIBMP regression check: ${result.file} vs baseline ${base.file}`);
  console.log(`Functions ${result.functions.length} (base ${base.functions.length}) | IDs ${result.ids.length} (base ${base.ids.length}) | Tabs ${result.tabs.length} (base ${base.tabs.length})`);
  if (fails.length) { console.log('\nFAIL — ' + fails.length + ' regression(s):'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\nPASS — all baseline features intact, no new errors.');
})();
