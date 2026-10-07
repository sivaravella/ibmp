// The platform owner console's accounts. Platform admins are not business users: they have their own table, their own token
// (signed with a different key and tagged as a platform token, so neither kind of token works on the other's endpoints),
// and they are created only by the platform operator (CLI script or the back-office key), never by public registration.
import bcrypt from 'bcryptjs';
import { httpError } from './util.js';

export const PLATFORM_ROLES = ['owner', 'support'];
export const MIN_PASSWORD = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const passwordProblem = (pw) => (String(pw ?? '').length < MIN_PASSWORD ? `A platform password needs at least ${MIN_PASSWORD} characters.` : null);

export async function createPlatformAdmin(pool, { email, name, password, role = 'owner', rounds = 12 }) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw httpError(400, 'That is not a valid email address.');
  if (!String(name ?? '').trim()) throw httpError(400, 'A name is required.');
  if (!PLATFORM_ROLES.includes(role)) throw httpError(400, `Role must be one of: ${PLATFORM_ROLES.join(', ')}.`);
  const problem = passwordProblem(password);
  if (problem) throw httpError(400, problem);
  if ((await pool.query('SELECT 1 FROM platform_admins WHERE email=$1', [e])).rowCount) throw httpError(409, 'A platform admin with this email already exists.');
  const row = (await pool.query(
    'INSERT INTO platform_admins (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
    [e, String(name).trim(), await bcrypt.hash(password, rounds), role])).rows[0];
  return row;
}
