// Turns an invoice into a PDF by opening the app's own print page in a headless Chrome or Chromium, so the PDF is exactly the
// invoice the person sees and prints (one template, nothing duplicated). The browser is started for each PDF and closed after it:
// invoices are emailed one at a time, so nothing is kept running.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { normaliseEnv } from './config.js';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium-headless-shell', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** The browser to use: IBMP_CHROME_PATH if set, otherwise the first common install found, otherwise none. */
export const findChrome = (env = process.env) => {
  const p = env.CHROME_PATH || CANDIDATES.find((c) => fs.existsSync(c));
  return p && fs.existsSync(p) ? p : null;
};

/**
 * A renderer { render({ url, token }) -> Buffer }, or null when there is no browser to drive.
 * The page is signed in with a session token that lives for a couple of minutes, only inside this browser.
 * noSandbox is for containers, where Chrome's own sandbox cannot start; it is safe here because the browser only ever opens our own page.
 */
export function chromePdf({ chromePath, noSandbox = false, timeoutMs = 30000 } = {}) {
  if (!chromePath) return null;
  return {
    name: 'chrome',
    render: async ({ url, token }) => {
      const browser = await puppeteer.launch({
        executablePath: chromePath, headless: /headless-shell/.test(chromePath) ? 'shell' : true,
        args: ['--disable-gpu', '--font-render-hinting=none', ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [])],
      });
      try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument((t) => localStorage.setItem('ibmp_token', t), token);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: timeoutMs });
        await page.waitForFunction('window.__invoiceReady === true', { timeout: timeoutMs });      // set by the print page once the document and its QR codes are drawn
        await page.emulateMediaType('print');
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
        return Buffer.from(pdf);
      } finally { await browser.close().catch(() => {}); }
    },
  };
}

export const resolvePdf = (raw = process.env) => { const env = normaliseEnv(raw); return chromePdf({ chromePath: findChrome(env), noSandbox: ['1', 'true', 'yes'].includes(String(env.CHROME_NO_SANDBOX ?? '').toLowerCase()) }); };
