import { loadConfig, normaliseEnv } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { resolveGateway } from './gateway.js';
import { resolveGsp } from './gsp.js';
import { setJwtSecret } from './auth.js';
import { resolveChannels } from './notify.js';

let config;
try { config = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
setJwtSecret(config.jwtSecret);
Object.assign(process.env, normaliseEnv(process.env));   // IBMP_* names reach the modules that read SECRETS_KEY, ADMIN_API_KEY, RAZORPAY_* directly

const log = (level, message, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, message, ...extra }));
const pool = createPool(config);
pool.on('error', (e) => log('error', 'Idle database client error', { error: e.message }));

try {
  const applied = await migrate(pool, { lock: true });
  if (applied.length) log('info', 'Applied migrations', { migrations: applied });
} catch (e) {
  log('error', 'Database is not ready', { error: e.message });
  process.exit(1);
}

// Simulated gateways exist for development. Outside production they are the default; in production they need an explicit opt-in.
const env = { ...process.env, ...(config.enableSimulators ? { ENABLE_SIMULATORS: 'true' } : {}) };
const gateway = resolveGateway(env), gsp = resolveGsp(env);
if (config.production && config.enableSimulators)
  log('warn', 'ENABLE_SIMULATORS is on: payments and GST filing are SIMULATED. Nothing is really charged or filed. Never use this for a real deployment.');
if (config.production && !gateway) log('warn', 'No payment gateway is configured: subscriptions cannot be bought online.');
if (config.production && !gsp) log('warn', 'No GSP is configured: returns, e-invoices and e-way bills cannot be sent to the government portals.');

const channels = resolveChannels(env);
if (config.production && !channels.email) log('warn', 'No email is configured (IBMP_SMTP_URL, IBMP_MAIL_FROM): email reminders cannot be sent.');
if (config.production && !channels.sms) log('warn', 'No SMS is configured (IBMP_TWILIO_ACCOUNT_SID, _AUTH_TOKEN, IBMP_SMS_FROM or _TWILIO_MESSAGING_SERVICE_SID, and a DLT-registered IBMP_SMS_TEMPLATE): SMS reminders cannot be sent.');
if (config.production && !channels.whatsapp) log('warn', 'No WhatsApp is configured (IBMP_WHATSAPP_TOKEN, _PHONE_ID, _TEMPLATE): WhatsApp reminders cannot be sent.');

const app = createApp(pool, { gateway, gsp, channels, config });
const server = app.listen(config.port, () => log('info', 'IBMP is running', { port: config.port, production: config.production, web: config.webDir || null, gateway: gateway?.name ?? null, gsp: gsp?.name ?? null }));

// Reminders go out once a day, from 09:00 IST (03:30 UTC) to 21:00 IST. The job runs hourly in that window; every message is logged, so a
// second run, a restart or a second instance never sends the same reminder twice. A database lock keeps instances from running it at once.
let reminderTimer = null;
async function reminderTick() {
  const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  if (h < 3.5 || h >= 15.5) return;
  const c = await pool.connect();
  try {
    if (!(await c.query('SELECT pg_try_advisory_lock(727275) AS ok')).rows[0].ok) return;
    try {
      const done = await app.locals.runReminders(undefined, (companyId, e) => log('error', 'Reminder run failed for a company', { companyId, error: e.message }));
      const results = done.flatMap((d) => d.results);
      if (results.length) log('info', 'Reminders processed', { sent: results.filter((r) => r.status === 'sent').length, failed: results.filter((r) => r.status === 'failed').length, skipped: results.filter((r) => r.status === 'skipped').length });
    } finally { await c.query('SELECT pg_advisory_unlock(727275)').catch(() => {}); }
  } catch (e) { log('error', 'Reminder job failed', { error: e.message }); } finally { c.release(); }
}
if (config.reminders) { reminderTimer = setInterval(reminderTick, 60 * 60 * 1000); reminderTimer.unref(); setTimeout(reminderTick, 30_000).unref(); }

server.requestTimeout = 60_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

// Finish in-flight requests, then close the pool, so a deploy or restart never cuts a request (or a journal posting) in half.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('info', 'Shutting down', { signal });
  if (reminderTimer) clearInterval(reminderTimer);
  const force = setTimeout(() => { log('error', 'Forced exit after timeout'); process.exit(1); }, 15_000);
  force.unref();
  server.close(async () => { await pool.end().catch(() => {}); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('error', 'Unhandled rejection', { error: String(e?.stack ?? e) }));
process.on('uncaughtException', (e) => { log('error', 'Uncaught exception', { error: String(e?.stack ?? e) }); shutdown('uncaughtException'); });
