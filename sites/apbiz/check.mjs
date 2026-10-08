// Checks the built site: node sites/apbiz/check.mjs   (build first: node sites/apbiz/build.mjs)
// Fails (exit 1) on a broken internal link, a page without exactly one h1, a missing or duplicated title or description,
// a title or description that search results would cut off, invalid structured data, or a leftover placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(root), pages = files.filter((f) => f.endsWith('.html'));
const urlOf = (f) => { const r = '/' + path.relative(root, f).replace(/\\/g, '/'); return r.endsWith('/index.html') ? r.slice(0, -10) || '/' : r; };
const known = new Set(files.map((f) => '/' + path.relative(root, f).replace(/\\/g, '/')));
pages.forEach((f) => known.add(urlOf(f)));
const problems = [], titles = new Map(), descs = new Map();
const fail = (page, msg) => problems.push(`${urlOf(page)}: ${msg}`);

for (const f of pages) {
  const html = fs.readFileSync(f, 'utf8');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1], desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  const h1 = (html.match(/<h1[ >]/g) || []).length;
  if (h1 !== 1) fail(f, `${h1} h1 elements`);
  if (!title) fail(f, 'no title'); else { if (title.length > 70) fail(f, `title is ${title.length} characters`); if (titles.has(title)) fail(f, `same title as ${titles.get(title)}`); titles.set(title, urlOf(f)); }
  if (!desc) fail(f, 'no description'); else if (f.endsWith('404.html')) { /* not indexed */ } else { if (desc.length > 165) fail(f, `description is ${desc.length} characters`); if (desc.length < 70) fail(f, `description is only ${desc.length} characters`); if (descs.has(desc)) fail(f, `same description as ${descs.get(desc)}`); descs.set(desc, urlOf(f)); }
  if (!/<link rel="canonical"/.test(html)) fail(f, 'no canonical link');
  if (/XXXX|TODO|lorem/i.test(html)) fail(f, 'placeholder text left in');
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { JSON.parse(m[1]); } catch { fail(f, 'invalid JSON-LD'); } }
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    let h = m[1]; if (/^(https?:|mailto:|tel:|#)/.test(h)) continue;
    h = h.split('#')[0].split('?')[0]; if (!h) continue;
    if (!known.has(h)) fail(f, `broken link ${m[1]}`);
  }
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/href="#([^"]+)"/g)) if (!ids.has(m[1])) fail(f, `link to a missing section #${m[1]}`);
}
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
for (const f of pages.filter((p) => !p.endsWith('404.html'))) if (!sitemap.includes(`<loc>https://apbiz.in${urlOf(f)}</loc>`)) fail(f, 'missing from sitemap.xml');

console.log(`${pages.length} pages checked`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('no problems found');
