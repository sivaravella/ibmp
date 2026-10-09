// New-business sign-up wizard (public routes, mounted at /v1/onboarding) and the owner's view of what they told us (/v1/company/onboarding).
//   GET  /meta          the lists the wizard shows
//   POST /email-otp     send a 6-digit code to an email address
//   POST /verify-email  trade the code for an email token (60 minutes)
//   POST /extract       read a registration PDF (needs the email token in X-Onboarding-Token)
//   POST /complete      create the business and sign the owner in
import { Router } from 'express';
import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { h, httpError } from '../util.js';
import { SECTOR_LIST } from '../sectors.js';
import { PLANS, TRIAL_DAYS } from '../plans.js';
import { ENTITY_TYPE_LIST, NATURE_LIST, INDUSTRIES, TURNOVER_SLABS, EMPLOYEE_RANGES } from '../industries.js';
import { readDocument } from '../extract.js';
import { emailFromToken, loadOnboarding, normaliseEmail, parseBusiness, registerBusiness, sendEmailOtp, verifyEmailOtp } from '../onboarding.js';

const META = {
  entityTypes: ENTITY_TYPE_LIST.map(({ value, label, description }) => ({ value, label, description })),
  natures: NATURE_LIST.map(({ value, label, description, hint }) => ({ value, label, description, hint })),
  industries: INDUSTRIES,
  sectors: SECTOR_LIST.map(([value, label]) => ({ value, label })),
  turnoverSlabs: TURNOVER_SLABS,
  employeeRanges: EMPLOYEE_RANGES,
  plans: ['trial', 'starter', 'professional', 'enterprise'].map((c) => ({ code: c, name: PLANS[c].name, monthly: PLANS[c].monthly, highlights: PLANS[c].highlights })),
  trialDays: TRIAL_DAYS,
};

const EXTRACT_PER_HOUR = 20;       // uploads per verified email
const EXTRACT_BUSY = 4;            // PDFs read at the same moment on this server

export function onboardingRoutes(pool, { channels = null, bcryptRounds = 10, now = Date.now, today } = {}) {
  const r = Router();
  const reads = new Map();         // email -> times of recent uploads
  let busy = 0;

  r.get('/meta', (_req, res) => res.json(META));

  r.post('/email-otp', h(async (req, res) => {
    const { email } = z.object({ email: z.string().trim().max(254) }).parse(req.body ?? {});
    res.json(await sendEmailOtp(pool, channels, { email, ip: req.ip ?? null, now }));
  }));

  r.post('/verify-email', h(async (req, res) => {
    const b = z.object({ email: z.string().trim().max(254), code: z.union([z.string(), z.number()]) }).parse(req.body ?? {});
    const v = await verifyEmailOtp(pool, { email: b.email, code: String(b.code), now });
    if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code, attemptsLeft: v.attemptsLeft });
    res.json({ emailToken: v.emailToken });
  }));

  // The file is read in memory and dropped: it is not stored and its text is not logged.
  r.post('/extract', express.raw({ type: () => true, limit: '3mb' }), h(async (req, res) => {
    let email;
    try { email = emailFromToken(req.headers['x-onboarding-token']); }
    catch { throw Object.assign(httpError(403, 'Please verify your email before uploading a document.'), { code: 'EMAIL_NOT_VERIFIED' }); }
    const kind = String(req.headers['x-kind'] ?? '').toLowerCase();
    if (!['gst', 'coi', 'mca'].includes(kind)) throw httpError(400, 'Say which document this is: gst, coi or mca (header x-kind).');
    const t = now();
    const recent = (reads.get(email) ?? []).filter((x) => x > t - 3_600_000);
    if (recent.length >= EXTRACT_PER_HOUR) throw httpError(429, 'Too many documents were uploaded. Please type the details in the next steps, or try again in an hour.');
    if (busy >= EXTRACT_BUSY) throw httpError(429, 'The document reader is busy. Please try again in a moment.');
    reads.set(email, [...recent, t]);
    busy++;
    try { res.json(await readDocument({ buffer: Buffer.isBuffer(req.body) ? req.body : null, kind })); }
    finally { busy--; }
  }));

  r.post('/complete', h(async (req, res) => {
    const { emailToken, name, password, email: bodyEmail, ...rest } = z.object({
      emailToken: z.string().min(10, 'Please verify your email first.'),
      name: z.string().trim().min(1, 'Enter your name.').max(100),
      password: z.string().min(8, 'Use at least 8 characters for the password.').max(200),
      email: z.string().optional(),
    }).passthrough().parse(req.body ?? {});
    const email = emailFromToken(emailToken);
    if (bodyEmail && normaliseEmail(bodyEmail) !== email) throw Object.assign(httpError(400, 'This verification was for a different email address. Please verify the email you are signing up with.'), { code: 'EMAIL_MISMATCH' });
    const b = parseBusiness(rest);
    const out = await registerBusiness(pool, { email, name, passwordHash: await bcrypt.hash(password, bcryptRounds), b, today: today?.() });
    res.status(201).json({ token: out.token, company: out.company, summary: out.summary });
  }));

  return r;
}

/** GET /v1/company/onboarding (signed in; the owner only): what the owner told us when signing up. */
export function onboardingAuthedRoutes(pool) {
  const r = Router();
  r.get('/company/onboarding', h(async (req, res) => {
    if (req.user.role !== 'owner') throw Object.assign(httpError(403, 'Only the account owner can see this.'), { code: 'OWNER_ONLY' });
    res.json(await loadOnboarding(pool, req.user.companyId));
  }));
  return r;
}

