// Runs the whole test suite against a real PostgreSQL instead of pg-mem: starts a throwaway embedded PostgreSQL, points the
// tests at it through a loader shim (test/support), and removes it afterwards. Extra arguments are passed to `node --test`.
//   npm run test:pg                      everything
//   npm run test:pg -- test/tds.test.js  one file
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmp-test-pg-'));
const port = Number(process.env.IBMP_TEST_PG_PORT || 54330);
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  const register = pathToFileURL(path.join(root, 'test', 'support', 'pg-shim-register.mjs')).href;
  const files = process.argv.slice(2);
  const child = spawn(process.execPath, ['--test', ...(files.length ? files : ['test/*.test.js'])], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, IBMP_TEST_PG_URL: `postgres://postgres:test@localhost:${port}/postgres`, NODE_OPTIONS: `--import ${register}` },
  });
  code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
} finally {
  await pg.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
