import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const prod = { NODE_ENV: 'production', IBMP_DATABASE_URL: 'postgres://x', IBMP_JWT_SECRET: 'x'.repeat(40), IBMP_SECRETS_KEY: 'k'.repeat(20) };

test('production refuses social sign-in without a public address, and only the providers with both values are on', () => {
  const social = { ...prod, IBMP_GOOGLE_CLIENT_ID: 'id', IBMP_GOOGLE_CLIENT_SECRET: 'secret', IBMP_LINKEDIN_CLIENT_ID: 'only-an-id' };
  assert.throws(() => loadConfig(social), /PUBLIC_URL must be set/);
  const cfg = loadConfig({ ...social, IBMP_PUBLIC_URL: 'https://app.example.com' });
  assert.deepEqual(Object.keys(cfg.social), ['google']);                       // LinkedIn has no secret, so it stays off
  assert.equal(loadConfig(prod).publicUrl, '');                                // no providers, no requirement
});
