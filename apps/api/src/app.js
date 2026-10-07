import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { authRoutes } from './routes/auth.js';
import { socialRoutes } from './social.js';
import { masterRoutes } from './routes/masters.js';
import { invoiceRoutes } from './routes/invoices.js';
import { purchaseRoutes } from './routes/purchases.js';
import { returnRoutes } from './routes/returns.js';
import { ledgerRoutes } from './routes/ledger.js';
import { gstRoutes } from './routes/gst.js';
import { complianceRoutes } from './routes/compliance.js';
import { payrollRoutes } from './routes/payroll.js';
import { attendanceRoutes } from './routes/attendance.js';
import { leaveRoutes } from './routes/leave.js';
import { billingRoutes, subscriptionGate, webhookRoutes } from './routes/billing.js';
import { companyRoutes, adminRoutes } from './routes/companies.js';
import { filingRoutes } from './routes/filing.js';
import { profileRoutes } from './routes/profile.js';
import { edocRoutes } from './routes/edocs.js';
import { tdsRoutes } from './routes/tds.js';
import { tdsNsRoutes } from './routes/tdsns.js';
import { statutoryRoutes } from './routes/statutory.js';
import { resolveGsp } from './gsp.js';
import { requireAuth } from './auth.js';
import { camelizeKeys } from './util.js';
import { resolveGateway } from './gateway.js';
import { reminderRoutes } from './routes/reminders.js';
import { platformRoutes } from './routes/platform.js';
import { analyticsRoutes } from './routes/analytics.js';
import { resolveChannels } from './notify.js';
import { resolvePdf } from './pdf.js';
import { runAll } from './reminders.js';
import { today as todayFn } from './util.js';

/**
 * gateway: a payment provider (see gateway.js); defaults to Razorpay when configured, the simulator outside production, else none.
 * gsp: a GST Suvidha Provider (see gsp.js); defaults to the simulator outside production, else none.
 * channels: reminder delivery (see notify.js); defaults to SMTP / WhatsApp Cloud when configured, the simulator outside production, else none.
 * config: from config.js. Without it the app behaves as in development and tests (permissive CORS, no rate limits, no static files).
 */
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createApp(pool, { gateway = resolveGateway(), gsp = resolveGsp(), channels = resolveChannels(), config = null, social = config?.social ?? {}, socialFetch = fetch, pdf = resolvePdf() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config?.trustProxy) app.set('trust proxy', config.trustProxy);

  // Every request gets an id (returned in X-Request-Id and logged) so a customer report can be matched to a log line.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id']?.toString().slice(0, 64) || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  if (config?.logRequests) {
    app.use((req, res, next) => {
      const t = process.hrtime.bigint();
      res.on('finish', () => {
        if (req.path === '/v1/health') return;
        console.log(JSON.stringify({ t: new Date().toISOString(), id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - t) / 1000000n), ip: req.ip }));
      });
      next();
    });
  }

  // The web app is served from this origin, so the policy can be strict. Razorpay's checkout is the only third party.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],            // React sets inline style attributes
        imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
        connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
        frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    hsts: !!config?.production,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());

  // Same-origin by default in production; list origins in CORS_ORIGINS to allow a separately hosted front end.
  if (!config) app.use(cors());
  else if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins, credentials: false, maxAge: 600 }));

  if (config?.rateLimit) {
    const limited = (limit, message) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: message }, skip: (req) => req.path.startsWith('/webhooks') || req.path === '/health' || req.path === '/ready' });
    app.use('/v1/auth', limited(config.authRateLimitPerMin, 'Too many sign-in attempts. Wait a minute and try again.'));
    app.use('/v1/platform/login', limited(config.authRateLimitPerMin, 'Too many sign-in attempts. Wait a minute and try again.'));
    app.use('/v1', limited(config.apiRateLimitPerMin, 'Too many requests. Slow down and try again shortly.'));
  }

  // Keep the exact bytes of the body: webhook signatures are computed over them.
  app.use(express.json({ limit: '300kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Business data is private: never let a browser or a proxy keep a copy.
  app.use('/v1', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Every JSON response leaves as camelCase (see camelizeKeys).
  app.use('/v1', (_req, res, next) => { const json = res.json.bind(res); res.json = (body) => json(camelizeKeys(body)); next(); });

  const compliance = complianceRoutes(pool);
  const gst = gstRoutes(pool);
  app.get('/v1/health', (_req, res) => res.json({ ok: true, version: VERSION }));                       // liveness: the process is up
  app.get('/v1/ready', async (_req, res) => {                                          // readiness: it can reach its database
    try { await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
  });
  app.use('/v1/auth/social', socialRoutes(pool, { providers: social, publicUrl: config?.publicUrl, bcryptRounds: config?.bcryptRounds, fetchFn: socialFetch }));
  app.use('/v1/auth', authRoutes(pool, { bcryptRounds: config?.bcryptRounds }));
  app.use('/v1/webhooks', webhookRoutes(pool, gateway));
  app.use('/v1/admin', adminRoutes(pool, { bcryptRounds: config?.bcryptRounds }));
  app.use('/v1/platform', platformRoutes(pool));
  app.use('/v1', requireAuth, subscriptionGate(pool), masterRoutes(pool), invoiceRoutes(pool, { channels, pdf, baseUrl: `http://127.0.0.1:${config?.port ?? process.env.PORT ?? 4000}`, appName: 'IBMP' }), analyticsRoutes(pool), purchaseRoutes(pool), returnRoutes(pool), ledgerRoutes(pool),
    gst, filingRoutes(pool, { gsp, reports: gst.reports }), profileRoutes(pool), edocRoutes(pool, { gsp }), tdsRoutes(pool), tdsNsRoutes(pool), statutoryRoutes(pool), compliance, reminderRoutes(pool, { channels, openItems: compliance.openItems, appUrl: config?.publicUrl || null }),
    companyRoutes(pool, { complianceSummary: compliance.summaryFor }), payrollRoutes(pool), attendanceRoutes(pool), leaveRoutes(pool), billingRoutes(pool, gateway));
  app.use('/v1', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // The built web app, with client-side routes falling back to index.html.
  if (config?.webDir && fs.existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, {
      index: false,
      setHeaders: (res, file) => { res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'); },
    }));
    // A missing file is a 404, never the home page: a stale browser tab asking for a screen from an old build must see the failure, not HTML.
    app.get(/^\/(?!v1\/)(assets\/|.*\.[A-Za-z0-9]{1,5}$)/, (_req, res) => res.status(404).type('text/plain').send('Not found'));
    app.get(/^\/(?!v1\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(config.webDir, 'index.html')); });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, ...(typeof err.code === 'string' ? { code: err.code } : {}), ...(err.requiredPlan ? { requiredPlan: err.requiredPlan } : {}) });
    if (err.status) return res.status(err.status).json({ error: err.message, ...(typeof err.code === 'string' ? { code: err.code } : {}) });
    console.error(JSON.stringify({ t: new Date().toISOString(), id: req.id, level: 'error', method: req.method, path: req.path, message: err.message, stack: err.stack }));
    res.status(500).json({ error: 'Something went wrong on our side.', requestId: req.id });
  });
  // The daily reminder job (called by server.js on a timer, and by tests).
  app.locals.runReminders = (today = todayFn(), onError) => runAll(pool, { today, channels, openItems: compliance.openItems, appUrl: config?.publicUrl || null, onError });
  app.locals.channels = channels;
  return app;
}
