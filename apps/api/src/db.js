import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Return DATE columns as 'YYYY-MM-DD' strings. node-pg's default (a local-midnight Date) shifts the day when JSON-serialised.
pg.types.setTypeParser(1082, (v) => v);

/** A connection pool. Pass the config from config.js; with no argument it reads DATABASE_URL (used by the migrate script). */
export function createPool(cfg = {}) {
  return new pg.Pool({
    connectionString: cfg.databaseUrl || process.env.DATABASE_URL || 'postgres://ibmp:ibmp@localhost:5432/ibmp',
    max: cfg.poolMax ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ...(cfg.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

const LOCK_ID = 727274;      // arbitrary constant: serialises migrations when several instances start together

/**
 * Apply pending SQL migrations in order, each in its own transaction together with its bookkeeping row, so a failed migration
 * leaves nothing half-applied. With { lock: true } (real PostgreSQL) an advisory lock makes concurrent starts take turns.
 */
export async function migrate(pool, { lock = false } = {}) {
  const client = await pool.connect();
  try {
    if (lock) await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw Object.assign(new Error(`Migration ${f} failed: ${e.message}`), { cause: e });
      }
    }
    return applied;
  } finally {
    if (lock) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
