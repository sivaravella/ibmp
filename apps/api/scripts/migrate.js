import { createPool, migrate } from '../src/db.js';
import { normaliseEnv } from '../src/config.js';
const pool = createPool({ databaseUrl: normaliseEnv().DATABASE_URL });
await migrate(pool);
console.log('migrations applied');
await pool.end();
