// Encryption at rest for short-lived credentials (the GST portal session token issued by a GSP).
// AES-256-GCM with a random IV per value. The key comes from SECRETS_KEY; in production it must be set.
import crypto from 'node:crypto';

function key() {
  const k = process.env.SECRETS_KEY;
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('SECRETS_KEY must be set in production');
    return crypto.scryptSync('ibmp-dev-only-secrets-key', 'ibmp', 32);
  }
  return crypto.scryptSync(k, 'ibmp', 32);
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(value) {
  const [iv, tag, body] = String(value).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
