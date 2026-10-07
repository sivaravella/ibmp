// Runtime configuration, read once at startup. In production this refuses to start with settings that would be unsafe
// (a default or short JWT secret, no database, no encryption key, wildcard CORS) rather than running with them quietly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_JWT = 'dev-only-secret-change-me';

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; };
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

/**
 * IBMP_-prefixed variables are the canonical names (IBMP_JWT_SECRET, IBMP_DATABASE_URL, ...); the unprefixed names still work as
 * fallbacks so platforms that inject DATABASE_URL, PORT or NODE_ENV need no mapping. Returns the merged environment.
 */
export function normaliseEnv(env = process.env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) if (k.startsWith('IBMP_') && v !== undefined && v !== '') out[k.slice(5)] = v;
  return out;
}

export function loadConfig(raw = process.env) {
  const env = normaliseEnv(raw);
  const production = env.NODE_ENV === 'production';
  const cfg = {
    production,
    port: int(env.PORT, 4000),
    databaseUrl: env.DATABASE_URL || (production ? '' : 'postgres://ibmp:ibmp@localhost:5432/ibmp'),
    databaseSsl: bool(env.DATABASE_SSL),
    poolMax: int(env.DB_POOL_MAX, 10),
    jwtSecret: env.JWT_SECRET || (production ? '' : DEV_JWT),
    secretsKey: env.SECRETS_KEY || '',
    corsOrigins: list(env.CORS_ORIGINS),
    trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? false : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : bool(env.TRUST_PROXY),
    rateLimit: bool(env.RATE_LIMIT, production),
    authRateLimitPerMin: int(env.AUTH_RATE_LIMIT_PER_MIN, 20),
    apiRateLimitPerMin: int(env.API_RATE_LIMIT_PER_MIN, 600),
    bcryptRounds: int(env.BCRYPT_ROUNDS, production ? 12 : 10),
    // Directory of the built web app to serve from the same origin. Defaults to ../web/dist when it exists.
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : (fs.existsSync(path.join(here, '..', '..', 'web', 'dist')) ? path.join(here, '..', '..', 'web', 'dist') : ''),
    logRequests: bool(env.LOG_REQUESTS, production),
    // Lets the simulated payment gateway and GSP run outside development. Never set this for a real deployment.
    enableSimulators: bool(env.ENABLE_SIMULATORS),
    adminKeySet: !!env.ADMIN_API_KEY,
    publicUrl: env.PUBLIC_URL || '',                 // the address users open: put in reminder emails
    reminders: bool(env.REMINDERS_JOB, true),
    // Sign in with Google / LinkedIn: a provider is offered only when both its client id and secret are set.
    social: Object.fromEntries([['google', 'GOOGLE'], ['linkedin', 'LINKEDIN']].map(([k, P]) => [k, { clientId: env[`${P}_CLIENT_ID`] || '', clientSecret: env[`${P}_CLIENT_SECRET`] || '' }]).filter(([, v]) => v.clientId && v.clientSecret)),
  };

  const problems = [];
  if (production) {
    if (!cfg.databaseUrl) problems.push('DATABASE_URL is required.');
    if (!cfg.jwtSecret || cfg.jwtSecret === DEV_JWT || cfg.jwtSecret.length < 32) problems.push('JWT_SECRET must be set to a random value of at least 32 characters.');
    if (!cfg.secretsKey || cfg.secretsKey.length < 16) problems.push('SECRETS_KEY must be set to a random value of at least 16 characters (it encrypts GST portal session tokens).');
    if (cfg.corsOrigins.includes('*')) problems.push('CORS_ORIGINS must list explicit origins, not *.');
    if (cfg.adminKeySet && String(env.ADMIN_API_KEY).length < 24) problems.push('ADMIN_API_KEY must be at least 24 characters when set.');
  }
  if (problems.length) throw Object.assign(new Error(`Refusing to start with unsafe configuration:\n - ${problems.join('\n - ')}`), { problems });
  return cfg;
}
