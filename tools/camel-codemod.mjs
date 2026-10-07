// One-off: rewrite snake_case property accesses and object keys to camelCase in the given files (API contract change).
// Skips lines that look like SQL. Run: node tools/camel-codemod.mjs <files...>
import fs from 'node:fs';
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const SNAKE = String.raw`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`;
const sql = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|pool\.query|client\.query|db\.query)\b/;
const dotAccess = new RegExp(String.raw`(?<=[\w)\]?]\.)(${SNAKE})\b(?!\s*\()`, 'g');   // x.some_key (not a method call)
const objKey = new RegExp(String.raw`(?<=[{,\s])(${SNAKE})(?=\s*:(?!:))`, 'g');        // { some_key: ... }
let total = 0;
for (const f of process.argv.slice(2)) {
  const out = fs.readFileSync(f, 'utf8').split('\n').map((line) => {
    if (sql.test(line)) return line;
    const before = line;
    line = line.replace(dotAccess, camel).replace(objKey, camel);
    if (line !== before) total++;
    return line;
  }).join('\n');
  fs.writeFileSync(f, out);
}
console.log('lines changed:', total);
