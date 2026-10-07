// One-off: undo camel-codemod in the unit-test region (everything before the first before(...) / const api) of the given test files,
// restoring a key to snake_case only when the engine sources use that snake_case name and never the camelCase one.
import fs from 'node:fs';
import path from 'node:path';
const srcDir = path.resolve('apps/api/src');
const ids = new Set();
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))) for (const m of fs.readFileSync(path.join(srcDir, f), 'utf8').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) ids.add(m[0]);
const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const restore = (k) => { const s = snake(k); return s !== k && ids.has(s) && (!ids.has(k) || process.env.RELAX) ? s : k; };
const CAMEL = String.raw`[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+`;
const dotAccess = new RegExp(String.raw`(?<=[\w)\]?]\.)(${CAMEL})\b(?!\s*\()`, 'g');
const objKey = new RegExp(String.raw`(?<=[{,\s])(${CAMEL})(?=\s*:(?!:))`, 'g');
for (const f of process.argv.slice(2)) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const end = lines.findIndex((l) => /^(before\(|const api\b)/.test(l));
  if (end < 0) continue;
  let n = 0;
  for (let i = 0; i < end; i++) {
    const b = lines[i];
    if (/\b(SELECT|INSERT|UPDATE|FROM)\b/.test(b)) continue;
    lines[i] = b.replace(dotAccess, restore).replace(objKey, restore);
    if (lines[i] !== b) n++;
  }
  fs.writeFileSync(f, lines.join('\n'));
  console.log(path.basename(f), 'restored lines:', n);
}
