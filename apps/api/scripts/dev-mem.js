// Dev helper: run the API on an in-memory database (no PostgreSQL needed). Data resets on restart.
import { newDb } from 'pg-mem';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';

const { Pool } = newDb().adapters.createPg();
const pool = new Pool();
await migrate(pool);
const port = process.env.PORT || 4000;
createApp(pool).listen(port, () => console.log(`IBMP API (in-memory DB) on :${port}`));
