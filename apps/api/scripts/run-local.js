// Runs the whole portal locally the way production runs it: a real PostgreSQL (embedded, data kept in .data/), the API in
// production mode serving the built web app from the same origin. Secrets are generated once and kept in .data/secrets.json.
// Payments and GST filing are simulated here (ENABLE_SIMULATORS) because no real provider credentials exist on a laptop.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Settings kept in a git-ignored .env at the repository root (email, social sign-in...) join the environment; real variables win.
const envFile = path.resolve(root, '..', '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const dataDir = path.resolve(process.env.IBMP_DATA_DIR || path.join(root, '..', '..', '.data'));
const pgDir = path.join(dataDir, 'postgres');
fs.mkdirSync(dataDir, { recursive: true });

const secretsFile = path.join(dataDir, 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {
  jwtSecret: crypto.randomBytes(48).toString('hex'),
  secretsKey: crypto.randomBytes(32).toString('hex'),
  dbPassword: crypto.randomBytes(16).toString('hex'),
};
// The platform owner's back-office key (x-admin-key) for the /v1/admin API; older installs get one added.
secrets.adminKey ??= crypto.randomBytes(24).toString('hex');
fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));

const pgPort = Number(process.env.PG_PORT || 54329);
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'ibmp', password: secrets.dbPassword, port: pgPort, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (!fs.existsSync(path.join(pgDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try { await pg.createDatabase('ibmp'); } catch { /* already exists */ }

const port = process.env.PORT || '4000';
const api = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    IBMP_PORT: port,
    IBMP_DATABASE_URL: `postgres://ibmp:${secrets.dbPassword}@localhost:${pgPort}/ibmp`,
    IBMP_JWT_SECRET: secrets.jwtSecret,
    IBMP_SECRETS_KEY: secrets.secretsKey,
    IBMP_PUBLIC_URL: process.env.IBMP_PUBLIC_URL || `http://localhost:${port}`,
    IBMP_ENABLE_SIMULATORS: 'true',
    IBMP_ADMIN_API_KEY: secrets.adminKey,
  },
});
console.log(`IBMP: http://localhost:${port}  (PostgreSQL on ${pgPort}, data in ${dataDir})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => { if (!stopping) { console.error(`API exited (${code}); stopping PostgreSQL.`); stopping = true; pg.stop().finally(() => process.exit(code ?? 1)); } });
