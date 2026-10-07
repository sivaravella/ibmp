// Needs a real PostgreSQL (npm run test:pg): pg-mem has no advisory locks and does not run concurrent sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';

const url = process.env.IBMP_TEST_PG_URL;
const files = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

async function freshDb() {
  const name = `m_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

test('several instances starting together apply every migration exactly once', { skip: !url && 'needs real PostgreSQL (npm run test:pg)' }, async () => {
  const db = await freshDb();
  const pools = Array.from({ length: 5 }, () => new pg.Pool({ connectionString: db, max: 2 }));
  const results = await Promise.all(pools.map((p) => migrate(p, { lock: true })));
  assert.equal(results.flat().length, files.length, 'each migration was applied by exactly one instance');
  assert.deepEqual(results.flat().sort(), files);
  const rows = (await pools[0].query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(rows, files);
  assert.deepEqual(await migrate(pools[1], { lock: true }), [], 'a later start finds nothing to do');
  await Promise.all(pools.map((p) => p.end()));
});

test('a failing migration is rolled back completely and leaves no bookkeeping row', { skip: !url && 'needs real PostgreSQL (npm run test:pg)' }, async () => {
  const db = await freshDb();
  const p = new pg.Pool({ connectionString: db, max: 2 });
  await migrate(p, { lock: true });
  // a statement that would fail halfway: the table must not survive the rollback
  const c = await p.connect();
  await c.query('BEGIN');
  await c.query('CREATE TABLE half_done (id INT)');
  await assert.rejects(() => c.query('INSERT INTO half_done (nope) VALUES (1)'));
  await c.query('ROLLBACK');
  c.release();
  assert.equal((await p.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
  await p.end();
});

test('the schema has the constraints the application relies on', { skip: !url && 'needs real PostgreSQL (npm run test:pg)' }, async () => {
  const db = await freshDb();
  const p = new pg.Pool({ connectionString: db, max: 2 });
  await migrate(p, { lock: true });
  const co = (await p.query("INSERT INTO companies (name, sector, state_code) VALUES ('A','x','29') RETURNING id")).rows[0].id;
  await p.query("INSERT INTO users (company_id, name, email, password_hash) VALUES ($1,'U','dup@example.com','x')", [co]);
  await assert.rejects(() => p.query("INSERT INTO users (company_id, name, email, password_hash) VALUES ($1,'U2','dup@example.com','x')", [co]), /unique/i);
  await assert.rejects(() => p.query("INSERT INTO users (company_id, name, email, password_hash) VALUES (999999,'U3','fk@example.com','x')"), /foreign key/i);
  await p.end();
});
