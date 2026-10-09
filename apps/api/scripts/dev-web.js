// Dev helper: the API on an in-memory database WITH the built web app, and simulated email/GST/payment channels, on one port (default 4100).
// Nothing is sent to anyone: verification codes are shown on screen ("Test mode: code is ..."). Use it to try sign-up flows safely.
//   npm run build (in the repo root), then: node apps/api/scripts/dev-web.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { simulatedChannels } from '../src/notify.js';
import { simulatedGsp } from '../src/gsp.js';
import { mockProvider } from '../src/gateway.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const { Pool } = newDb().adapters.createPg();
const pool = new Pool();
await migrate(pool);
const port = Number(process.env.PORT || 4100);
createApp(pool, { channels: simulatedChannels(), gsp: simulatedGsp(), gateway: mockProvider(), config: { webDir, port, corsOrigins: [], bcryptRounds: 4 } })
  .listen(port, () => console.log(`IBMP (in-memory DB, simulated channels, web app) on http://localhost:${port}`));
