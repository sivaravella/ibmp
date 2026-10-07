// Creates a platform console login straight in the database (no admin key needed).
//   IBMP_DATABASE_URL=... node scripts/create-platform-admin.js --email you@company.com --name "Your Name" [--role owner|support]
// The password comes from IBMP_PLATFORM_ADMIN_PASSWORD, or a strong random one is generated and printed once.
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { normaliseEnv } from '../src/config.js';
import { createPlatformAdmin } from '../src/platform.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg('email'), name = arg('name'), role = arg('role') ?? 'owner';
if (!email || !name) { console.error('Usage: node scripts/create-platform-admin.js --email <email> --name <name> [--role owner|support]'); process.exit(2); }

const env = normaliseEnv();
const generated = !env.PLATFORM_ADMIN_PASSWORD;
const password = env.PLATFORM_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
const pool = createPool({ databaseUrl: env.DATABASE_URL });
try {
  const a = await createPlatformAdmin(pool, { email, name, password, role });
  console.log(`Created platform ${a.role}: ${a.email}`);
  if (generated) console.log(`Password (shown once, change it after signing in): ${password}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
