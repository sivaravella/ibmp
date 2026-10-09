// New-business sign-up wizard: email verification codes, validation of what the wizard collected, and the one transaction that
// creates the company, its owner, the business profile, the onboarding facts and the compliance calendar settings.
//
// The mobile number is collected but stored as NOT verified: there is no SMS provider yet, so it is never presented as verified.
import crypto from 'node:crypto';
import { z } from 'zod';
import { signPurposeToken, verifyPurposeToken } from './auth.js';
import { createAccount, loginToken } from './routes/auth.js';
import { ENTITY_TYPES, profileSchema } from './routes/profile.js';
import { SECTORS } from './sectors.js';
import { parseGstin } from './gstin-lookup.js';
import { STATES } from './states.js';
import { fyOf, parseFy } from './compliance.js';
import { loadSubscription } from './subscription.js';
import { INDUSTRIES, NATURE_LIST, TURNOVER_SLABS, EMPLOYEE_RANGES, defaultSector } from './industries.js';
import { httpError, today as todayFn } from './util.js';

export const OTP_TTL_MINUTES = 10;
export const OTP_RESEND_AFTER_SECONDS = 45;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_SENDS_PER_EMAIL_PER_HOUR = 5;
export const OTP_SENDS_PER_IP_PER_HOUR = 20;
export const EMAIL_TOKEN_MINUTES = 60;
const HOUR = 3_600_000;

export const normaliseEmail = (e) => String(e ?? '').trim().toLowerCase();
const emailOk = (e) => e.length <= 254 && z.string().email().safeParse(e).success;

// ---------------------------------------------------------------------------------------------------------------- verification codes

// The codes are hashed with a key derived from the server's signing secret (the signature of a fixed, never-issued token is a
// keyed hash that only this server can compute), so a copy of the database alone cannot be used to find a live code.
const otpKey = () => signPurposeToken('onb-otp', { iat: 1 }, 86_400).split('.')[2];
const hashCode = (email, code) => crypto.createHmac('sha256', otpKey()).update(`${email}\n${code}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const otpEmail = (code) => {
  const subject = 'Your IBMP verification code';
  const text = `Your IBMP verification code is ${code}.\n\nIt expires in ${OTP_TTL_MINUTES} minutes. If you did not ask for it, you can ignore this email: nobody can use the code without your email inbox.\n\nIBMP`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e3e7ee;border-radius:8px;overflow:hidden">
<div style="background:#0b1f3a;color:#fff;padding:14px 20px;font-size:18px;font-weight:bold">IBMP <span style="color:#f5b800">verification</span></div>
<div style="padding:22px 20px;color:#1c2733;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px">Your verification code is</p>
<p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:bold;color:#0b1f3a;background:#fff7d6;border:1px solid #f5b800;border-radius:6px;padding:12px 0;text-align:center">${code}</p>
<p style="margin:0 0 8px">It expires in ${OTP_TTL_MINUTES} minutes.</p>
<p style="margin:0;color:#5b6675;font-size:13px">If you did not ask for this code, you can ignore this email.</p></div></div>`;
  return { subject, text, html };
};

/**
 * Send a 6-digit code to an email address that has no account yet. Returns { sent, expiresInMinutes, resendAfterSeconds, devCode? }
 * (devCode only when the email channel is the simulator). `now` is a clock in epoch milliseconds (injectable for tests).
 */
export async function sendEmailOtp(pool, channels, { email, ip = null, now = Date.now }) {
  email = normaliseEmail(email);
  if (!emailOk(email)) throw httpError(400, 'Enter a valid email address.');
  if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rowCount) throw Object.assign(httpError(409, 'This email already has an IBMP account. Please sign in instead.'), { code: 'EMAIL_TAKEN' });
  if (!channels?.email) throw Object.assign(httpError(503, 'Email is not set up on this server, so a verification code cannot be sent.'), { code: 'EMAIL_OFF' });

  const t = now();
  await pool.query('DELETE FROM onboarding_otp_sends WHERE sent_at < $1', [t - 24 * HOUR]);
  const perEmail = Number((await pool.query('SELECT COUNT(*) AS n FROM onboarding_otp_sends WHERE email=$1 AND sent_at > $2', [email, t - HOUR])).rows[0].n);
  if (perEmail >= OTP_SENDS_PER_EMAIL_PER_HOUR) throw Object.assign(httpError(429, 'Too many codes were requested for this email. Please wait an hour and try again.'), { code: 'OTP_THROTTLED' });
  if (ip) {
    const perIp = Number((await pool.query('SELECT COUNT(*) AS n FROM onboarding_otp_sends WHERE ip=$1 AND sent_at > $2', [ip, t - HOUR])).rows[0].n);
    if (perIp >= OTP_SENDS_PER_IP_PER_HOUR) throw Object.assign(httpError(429, 'Too many codes were requested from this network. Please wait an hour and try again.'), { code: 'OTP_THROTTLED' });
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // A new code replaces (and so invalidates) the previous one.
  await pool.query('DELETE FROM onboarding_otps WHERE email=$1', [email]);
  await pool.query('INSERT INTO onboarding_otps (email, code_hash, expires_at, attempts, created_at) VALUES ($1,$2,$3,0,$4)', [email, hashCode(email, code), t + OTP_TTL_MINUTES * 60_000, t]);
  await pool.query('INSERT INTO onboarding_otp_sends (email, ip, sent_at) VALUES ($1,$2,$3)', [email, ip, t]);
  try {
    await channels.email.send({ to: email, ...otpEmail(code) });
  } catch {
    await pool.query('DELETE FROM onboarding_otps WHERE email=$1', [email]);
    throw Object.assign(httpError(502, 'We could not send the email just now. Please try again in a minute.'), { code: 'EMAIL_FAILED' });
  }
  return { sent: true, expiresInMinutes: OTP_TTL_MINUTES, resendAfterSeconds: OTP_RESEND_AFTER_SECONDS, ...(channels.email.mode === 'simulated' ? { devCode: code } : {}) };
}

/** Check a code. Returns { ok: true, emailToken } or { ok: false, status, error, code, attemptsLeft } (the caller sends it as the response). */
export async function verifyEmailOtp(pool, { email, code, now = Date.now }) {
  email = normaliseEmail(email);
  const fail = (error, c, attemptsLeft) => ({ ok: false, status: 400, error, code: c, attemptsLeft });
  if (!emailOk(email)) return fail('Enter a valid email address.', 'EMAIL_INVALID', 0);
  const row = (await pool.query('SELECT * FROM onboarding_otps WHERE email=$1', [email])).rows[0];
  if (!row) return fail('There is no active code for this email. Please ask for a new code.', 'OTP_NONE', 0);
  if (now() > Number(row.expires_at)) {
    await pool.query('DELETE FROM onboarding_otps WHERE email=$1', [email]);
    return fail('This code has expired. Please ask for a new code.', 'OTP_EXPIRED', 0);
  }
  const entered = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(entered)) return fail('Enter the 6-digit code from the email.', 'OTP_FORMAT', Math.max(0, OTP_MAX_ATTEMPTS - row.attempts));
  // Count the try first (atomically), so parallel guesses cannot get past the limit.
  const upd = await pool.query('UPDATE onboarding_otps SET attempts = attempts + 1 WHERE email=$1 AND attempts < $2 RETURNING attempts, code_hash', [email, OTP_MAX_ATTEMPTS]);
  if (!upd.rowCount) return fail('Too many wrong codes. Please ask for a new code.', 'OTP_LOCKED', 0);
  const { attempts, code_hash: stored } = upd.rows[0];
  if (!sameHash(stored, hashCode(email, entered))) {
    const left = OTP_MAX_ATTEMPTS - attempts;
    return fail(left > 0 ? `That code is not right. You have ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right, and you have no tries left. Please ask for a new code.', left > 0 ? 'OTP_WRONG' : 'OTP_LOCKED', left);
  }
  await pool.query('DELETE FROM onboarding_otps WHERE email=$1', [email]);       // a code works once
  return { ok: true, emailToken: signPurposeToken('onb-email', { email }, `${EMAIL_TOKEN_MINUTES}m`) };
}

/** The verified email inside an email token, or a 400 asking the person to verify again. */
export function emailFromToken(token) {
  try { return normaliseEmail(verifyPurposeToken('onb-email', token).email); }
  catch { throw Object.assign(httpError(400, 'Your email verification has expired. Please verify your email again.'), { code: 'EMAIL_TOKEN_INVALID' }); }
}

// ---------------------------------------------------------------------------------------------------------------- what the wizard collects

export const NATURES = NATURE_LIST.map((n) => n.value);
export const PLAN_CHOICES = ['trial', 'starter', 'professional', 'enterprise'];
export const DOCUMENTS = ['gst', 'coi', 'mca'];

const digitsOnly = (s) => String(s).replace(/\D+/g, '');
/** 10-digit Indian mobile from "+91 98765 43210", "09876543210", "98765-43210"; the original text when it cannot be one. */
const mobileOf = (s) => {
  let d = digitsOnly(s);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
const MOBILE_MSG = 'Enter a 10-digit Indian mobile number, for example 9876543210.';
const mobile = z.string().transform(mobileOf).refine((v) => /^[6-9]\d{9}$/.test(v), MOBILE_MSG);
/** A landline or mobile for the business: digits only, without +91 or a leading 0. */
const phoneOf = (s) => { let d = digitsOnly(s); if (d.length > 10 && d.startsWith('91')) d = d.slice(2); else if (d.length > 10 && d.startsWith('0')) d = d.slice(1); return d; };

// The business profile's own validation rules are reused, not copied: the same zod fields the profile screen saves with.
const PROFILE_PICK = profileSchema.pick({
  legalName: true, tradeName: true, addr1: true, addr2: true, loc: true, pin: true, logo: true, gstin: true, pan: true, stateCode: true, entityType: true,
  cin: true, udyam: true, tan: true, website: true, contactPerson: true, incorporatedOn: true,
});

export const businessSchema = z.object({
  ...PROFILE_PICK.shape,
  company: z.string().trim().min(1, 'Enter the name of the business.').max(100, 'The business name is too long (100 characters at most).'),
  entityType: z.enum(ENTITY_TYPES, { errorMap: () => ({ message: 'Choose the type of business entity.' }) }),
  nature: z.enum(NATURES, { errorMap: () => ({ message: 'Choose the nature of business: trading, manufacturing or service.' }) }),
  sector: z.enum(SECTORS).optional(),
  industry: z.object({ code: z.string().trim().max(12).optional(), name: z.string().trim().min(1).max(80, 'The industry name is too long (80 characters at most).').optional() }).optional(),
  mobile: mobile.optional(),
  secondaryMobile: mobile.optional(),
  secondaryEmail: z.string().trim().toLowerCase().email('The secondary email is not valid.').max(120).optional(),
  phone: z.string().transform(phoneOf).refine((v) => /^\d{6,12}$/.test(v), 'Phone must be 6 to 12 digits').optional(),
  turnoverSlab: z.enum(TURNOVER_SLABS.map((s) => s.value)).optional(),
  employeeRange: z.enum(EMPLOYEE_RANGES.map((s) => s.value)).optional(),
  preferredPlan: z.enum(PLAN_CHOICES).default('trial'),
  documentsUsed: z.array(z.enum(DOCUMENTS)).max(3).optional(),
});

/** The keys a wizard sign-up has that the compact sign-up form does not (used to tell the two apart on the social endpoint). */
export const WIZARD_KEYS = new Set(Object.keys(businessSchema.shape).filter((k) => !['company', 'sector', 'gstin', 'stateCode'].includes(k)));

const dropEmpty = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => !(v === '' || v === null || v === undefined)));
const validDate = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

/** Validate and normalise the wizard's business fields. Throws a zod error (400) for format mistakes and a plain 400 for the rules that need the whole picture. */
export function parseBusiness(raw) {
  const b = businessSchema.parse(dropEmpty(raw));
  if (b.incorporatedOn && !validDate(b.incorporatedOn)) throw httpError(400, 'The incorporation date is not a real date.');
  // The GSTIN carries the state and the PAN, so the three have to agree (same rules as the business profile).
  let stateCode = b.stateCode;
  if (b.gstin) {
    const p = parseGstin(b.gstin);
    if (!p.checkOk) throw httpError(400, 'This GSTIN fails the check-character test, so it is probably mistyped. Check it against the GST certificate.');
    if (b.pan && b.pan !== p.pan) throw httpError(400, `The PAN inside this GSTIN is ${p.pan}, but the PAN you entered is ${b.pan}. Correct whichever is wrong.`);
    b.pan = p.pan;
    stateCode = p.stateCode;
    if (!(stateCode in STATES)) throw httpError(400, 'The first two digits of this GSTIN are not a GST state code.');
  }
  if (!stateCode) throw httpError(400, 'Enter a GSTIN, or choose the state your business is in.');
  // Industry: from the list, or a custom one the person added.
  let industry = null;
  if (b.industry && (b.industry.code || b.industry.name)) {
    const listed = b.industry.code ? INDUSTRIES.find((i) => i.code === b.industry.code) : null;
    if (listed) industry = { code: listed.code, name: listed.name };
    else if (b.industry.name) industry = { code: b.industry.code && /^[A-Za-z0-9-]{1,12}$/.test(b.industry.code) ? b.industry.code : null, name: b.industry.name };
    else throw httpError(400, 'That industry is not in the list. Choose one from the list, or add it with a name.');
  }
  const sector = b.sector ?? defaultSector(b.nature, industry?.code);
  return { ...b, stateCode, industry, sector, documentsUsed: [...new Set(b.documentsUsed ?? [])] };
}

// ---------------------------------------------------------------------------------------------------------------- the sign-up transaction

const PROFILE_COLUMNS = { legalName: 'legal_name', tradeName: 'trade_name', addr1: 'addr1', addr2: 'addr2', loc: 'loc', pin: 'pin', phone: 'phone', pan: 'pan', entityType: 'entity_type',
  cin: 'cin', udyam: 'udyam', tan: 'tan', website: 'website', contactPerson: 'contact_person', incorporatedOn: 'incorporated_on', logo: 'logo' };

/**
 * Create the business: company with chart of accounts and free trial plus its owner (through createAccount), the profile fields,
 * the onboarding facts and the compliance settings, all in one transaction. `b` comes from parseBusiness.
 * afterCreate(client, user) runs inside the same transaction (used by the social sign-up to link the provider account).
 * Returns { user, token, company, summary }.
 */
export async function registerBusiness(pool, { email, name, passwordHash, b, afterCreate = null, today = todayFn() }) {
  email = normaliseEmail(email);
  if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rowCount) throw Object.assign(httpError(409, 'This email already has an IBMP account. Please sign in instead.'), { code: 'EMAIL_TAKEN' });
  const client = await pool.connect();
  let user, companyId, trialEnds, accounts;
  try {
    await client.query('BEGIN');
    // createAccount runs its own BEGIN/COMMIT on a connection of the pool it is given. Handing it this view of our connection (the
    // transaction control is ours) makes everything below one transaction without changing createAccount.
    const txPool = {
      query: (...a) => client.query(...a),
      connect: async () => ({ query: (sql, ...rest) => (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(String(sql)) ? Promise.resolve({ rows: [], rowCount: 0 }) : client.query(sql, ...rest)), release() {} }),
    };
    user = await createAccount(txPool, { name, email, company: b.company, sector: b.sector, gstin: b.gstin, stateCode: b.stateCode, accountType: 'individual' }, passwordHash);
    companyId = user.company_id;

    const cols = { ...Object.fromEntries(Object.keys(PROFILE_COLUMNS).filter((k) => b[k] !== undefined).map((k) => [PROFILE_COLUMNS[k], b[k]])), email };
    const keys = Object.keys(cols);
    await client.query(`UPDATE companies SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => cols[k]), companyId]);

    await client.query(
      `INSERT INTO company_onboarding (company_id, nature, industry_code, industry_name, turnover_slab, employee_range, preferred_plan, mobile, mobile_verified, secondary_mobile, secondary_email, documents_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,$11)`,
      [companyId, b.nature, b.industry?.code ?? null, b.industry?.name ?? null, b.turnoverSlab ?? null, b.employeeRange ?? null, b.preferredPlan, b.mobile ?? null, b.secondaryMobile ?? null, b.secondaryEmail ?? null, b.documentsUsed.join(',') || null]);

    // The compliance calendar works at once: it starts at the beginning of the current financial year. TDS stays off until the business turns it on.
    await client.query('INSERT INTO compliance_settings (company_id, track_from) VALUES ($1,$2) ON CONFLICT (company_id) DO NOTHING', [companyId, `${parseFy(fyOf(today))}-04-01`]);
    if (afterCreate) await afterCreate(client, user);

    accounts = Number((await client.query('SELECT COUNT(*) AS n FROM accounts WHERE company_id=$1', [companyId])).rows[0].n);
    trialEnds = (await loadSubscription(client, companyId, today)).trial_ends;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505' && /email/i.test(`${e.constraint ?? ''}${e.detail ?? ''}${e.message ?? ''}`)) throw Object.assign(httpError(409, 'This email already has an IBMP account. Please sign in instead.'), { code: 'EMAIL_TAKEN' });
    if (e?.status === 409) throw Object.assign(httpError(409, 'This email already has an IBMP account. Please sign in instead.'), { code: 'EMAIL_TAKEN' });
    throw e;
  } finally { client.release(); }
  return {
    user,
    token: await loginToken(pool, { ...user, active_company_id: companyId }),
    company: { id: companyId, name: b.company },
    summary: { accountsCreated: accounts, invoiceTemplate: true, complianceCalendarFrom: `${parseFy(fyOf(today))}-04-01`, trialEnds, preferredPlan: b.preferredPlan },
  };
}

/** The onboarding facts of a company, for the "complete your setup" nudge. */
export async function loadOnboarding(pool, companyId) {
  const r = (await pool.query('SELECT * FROM company_onboarding WHERE company_id=$1', [companyId])).rows[0];
  if (!r) return { recorded: false };
  return {
    recorded: true, nature: r.nature, industryCode: r.industry_code, industryName: r.industry_name, turnoverSlab: r.turnover_slab, employeeRange: r.employee_range,
    preferredPlan: r.preferred_plan, mobile: r.mobile, mobileVerified: r.mobile_verified === true, secondaryMobile: r.secondary_mobile, secondaryEmail: r.secondary_email,
    documentsUsed: r.documents_used ? r.documents_used.split(',') : [], createdAt: r.created_at,
  };
}

