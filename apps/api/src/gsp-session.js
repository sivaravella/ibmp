import { decrypt } from './secrets.js';

const conflict = (message, code) => Object.assign(new Error(message), { status: 409, code });

/** The company's live GST portal session, or null if there is none or it has expired. */
export async function getSession(pool, companyId) {
  const s = (await pool.query('SELECT * FROM gsp_sessions WHERE company_id=$1', [companyId])).rows[0];
  if (!s?.token_enc || new Date(s.expires_at) <= new Date()) return null;
  return { username: s.username, token: decrypt(s.token_enc), expires_at: s.expires_at };
}

export async function requireSession(pool, companyId, gstin) {
  const s = await getSession(pool, companyId);
  if (!s) throw conflict('Connect to the GST portal first (OTP step).', 'NO_SESSION');
  return { ...s, gstin };
}
