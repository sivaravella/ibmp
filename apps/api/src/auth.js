import jwt from 'jsonwebtoken';

let configured = null;
export const setJwtSecret = (s) => { configured = s; };
const secret = () => configured || process.env.JWT_SECRET || 'dev-only-secret-change-me';

export const signToken = (user) =>
  jwt.sign({ uid: user.id, cid: user.company_id, role: user.role }, secret(), { expiresIn: '12h' });

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.replace(/^Bearer /, ''), secret());
    req.user = { id: p.uid, companyId: p.cid, role: p.role };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ---- platform console tokens ----
// A different signing key, derived from the main one, and a `typ` claim: a business token is not valid on /v1/platform and a
// platform token is not valid on any business route.
import crypto from 'node:crypto';
const platformSecret = () => crypto.createHmac('sha256', secret()).update('ibmp-platform-console').digest('hex');

export const signPlatformToken = (admin) => jwt.sign({ aid: admin.id, role: admin.role, typ: 'platform' }, platformSecret(), { expiresIn: '4h' });

export function verifyPlatformToken(header) {
  const p = jwt.verify(String(header || '').replace(/^Bearer /, ''), platformSecret());
  if (p.typ !== 'platform') throw new Error('not a platform token');
  return { id: p.aid, role: p.role };
}

// ---- short-lived single-purpose tokens (social sign-in state, sign-up in progress) ----
// Signed with a key derived from the main one and tagged with their purpose, so none of them can be used as a session token.
const purposeSecret = (purpose) => crypto.createHmac('sha256', secret()).update(`ibmp-${purpose}`).digest('hex');
export const signPurposeToken = (purpose, payload, expiresIn) => jwt.sign({ ...payload, typ: purpose }, purposeSecret(purpose), { expiresIn });
export function verifyPurposeToken(purpose, token) {
  const p = jwt.verify(String(token || ''), purposeSecret(purpose));
  if (p.typ !== purpose) throw new Error('wrong token');
  return p;
}
