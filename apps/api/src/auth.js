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
