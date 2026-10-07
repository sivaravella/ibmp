import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { signToken, requireAuth } from '../auth.js';
import { h, httpError } from '../util.js';
import { GSTIN_RE, stateFromGstin } from '../gst.js';
import { seedAccounts } from '../ledger.js';
import { loadSubscription } from '../subscription.js';

export const SECTORS = ['retail', 'trading', 'service', 'wholesale', 'hospital', 'pharmacy'];
export const PROFESSIONAL_BODIES = ['ICAI', 'ICSI', 'ICMAI'];

export const consultantSchema = z.object({
  body: z.enum(PROFESSIONAL_BODIES),
  membershipNo: z.string().regex(/^[A-Za-z0-9/-]{3,20}$/, 'Enter the membership number as issued (letters, digits, / or -)'),
  registeredName: z.string().min(2).max(100),
});

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  company: z.string().min(1),
  sector: z.enum(SECTORS),
  gstin: z.string().regex(GSTIN_RE).optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  accountType: z.enum(['individual', 'consultant']).default('individual'),
  consultant: consultantSchema.optional(),
}).refine((b) => b.accountType !== 'consultant' || b.consultant, { message: 'Consultant accounts need professional details', path: ['consultant'] });

/** Store (or replace) the credentials a consultant claims. Verification is a separate, manual step. */
export const saveConsultantProfile = async (q, userId, c) => {
  await q.query('DELETE FROM consultant_profiles WHERE user_id=$1', [userId]);
  await q.query('INSERT INTO consultant_profiles (user_id, body, membership_no, registered_name) VALUES ($1,$2,$3,$4)', [userId, c.body, c.membershipNo.toUpperCase(), c.registeredName]);
};

/** A user's companies that they can currently work in (not archived). */
export const memberCompanies = async (q, userId) => (await q.query(
  `SELECT c.id, c.name, c.gstin, c.state_code, c.sector, c.archived, c.billing_company_id, uc.role
   FROM user_companies uc JOIN companies c ON c.id=uc.company_id WHERE uc.user_id=$1 ORDER BY c.id`, [userId])).rows;

export function authRoutes(pool, { bcryptRounds = 10 } = {}) {
  const r = Router();

  r.post('/register', h(async (req, res) => {
    const b = registerSchema.parse(req.body);
    const state = stateFromGstin(b.gstin) || b.stateCode;
    if (!state) throw httpError(400, 'Provide a GSTIN or a stateCode');
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [b.email.toLowerCase()])).rowCount)
      throw httpError(409, 'Email already registered');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = await client.query('INSERT INTO companies (name, sector, gstin, state_code) VALUES ($1,$2,$3,$4) RETURNING id', [b.company, b.sector, b.gstin || null, state]);
      const companyId = c.rows[0].id;
      await seedAccounts(client, companyId);
      await loadSubscription(client, companyId);   // starts the free trial
      const u = await client.query(
        'INSERT INTO users (company_id, name, email, password_hash, account_type, active_company_id) VALUES ($1,$2,$3,$4,$5,$1) RETURNING id, company_id, role',
        [companyId, b.name, b.email.toLowerCase(), await bcrypt.hash(b.password, bcryptRounds), b.accountType]);
      await client.query("INSERT INTO user_companies (user_id, company_id, role) VALUES ($1,$2,'owner')", [u.rows[0].id, companyId]);
      if (b.consultant) await saveConsultantProfile(client, u.rows[0].id, b.consultant);
      await client.query('COMMIT');
      res.status(201).json({ token: signToken(u.rows[0]) });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  r.post('/login', h(async (req, res) => {
    const b = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const u = (await pool.query('SELECT * FROM users WHERE email=$1', [b.email.toLowerCase()])).rows[0];
    if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw httpError(401, 'Invalid credentials');
    // Resume in the company they were last working in, if they still have access to it.
    const mine = await memberCompanies(pool, u.id);
    const last = mine.find((c) => c.id === u.active_company_id && !c.archived);
    res.json({ token: signToken({ id: u.id, role: u.role, company_id: last ? last.id : u.company_id }) });
  }));

  r.get('/me', requireAuth, h(async (req, res) => {
    const mine = await memberCompanies(pool, req.user.id);
    const active = mine.find((c) => c.id === req.user.companyId);
    if (!active || active.archived) throw httpError(403, 'You do not have access to this company');
    const u = (await pool.query('SELECT id, name, email, role, account_type, company_id AS home_company_id FROM users WHERE id=$1', [req.user.id])).rows[0];
    const profile = (await pool.query('SELECT body, membership_no, registered_name, status, note FROM consultant_profiles WHERE user_id=$1', [u.id])).rows[0] ?? null;
    res.json({
      id: u.id, name: u.name, email: u.email, role: u.role, account_type: u.account_type, consultant: profile,
      company_id: active.id, company: active.name, sector: active.sector, gstin: active.gstin, state_code: active.state_code,
      home_company_id: u.home_company_id, is_home: active.id === u.home_company_id,
      companies: mine.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, gstin: c.gstin, state_code: c.state_code, is_home: c.id === u.home_company_id })),
    });
  }));

  // Change the active company: issues a new token for a company the user belongs to.
  r.post('/switch', requireAuth, h(async (req, res) => {
    const { companyId } = z.object({ companyId: z.number().int() }).parse(req.body);
    const target = (await memberCompanies(pool, req.user.id)).find((c) => c.id === companyId);
    if (!target) throw httpError(403, 'You do not have access to that company');
    if (target.archived) throw Object.assign(httpError(403, 'That company is archived: restore it from the Companies page first'), { code: 'COMPANY_ARCHIVED' });
    await pool.query('UPDATE users SET active_company_id=$1 WHERE id=$2', [target.id, req.user.id]);
    res.json({ token: signToken({ id: req.user.id, role: req.user.role, company_id: target.id }) });
  }));

  return r;
}
