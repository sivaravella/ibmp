// Stands in for `pg-mem` so the unchanged test files run against a REAL PostgreSQL (see scripts/test-pg.js).
// Each `newDb().adapters.createPg()` pool gets its own freshly created database, so test files stay isolated exactly as
// they are with the in-memory database.
import pg from 'pg';
import crypto from 'node:crypto';

const admin = () => new pg.Pool({ connectionString: process.env.IBMP_TEST_PG_URL, max: 1 });

class ShimPool {
  constructor() {
    this.ready = (async () => {
      const name = `t_${crypto.randomBytes(6).toString('hex')}`;
      const a = admin();
      await a.query(`CREATE DATABASE ${name}`);
      await a.end();
      const url = new URL(process.env.IBMP_TEST_PG_URL);
      url.pathname = `/${name}`;
      return new pg.Pool({ connectionString: url.toString(), max: 10 });
    })();
  }
  async query(...a) { return (await this.ready).query(...a); }
  async connect() { return (await this.ready).connect(); }
  async end() { return (await this.ready).end(); }
  on() { return this; }
}

export function newDb() {
  return { adapters: { createPg: () => ({ Pool: ShimPool }) } };
}
