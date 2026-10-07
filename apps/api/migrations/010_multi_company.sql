-- Multi-company access for consultants.
-- A login (user) can belong to several companies through user_companies. The JWT carries the *active* company, and every
-- request re-checks membership, so removing a row revokes access immediately.
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'individual';   -- individual | consultant
ALTER TABLE users ADD COLUMN active_company_id INTEGER;                          -- remembered between logins

CREATE TABLE IF NOT EXISTS user_companies (
  user_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
INSERT INTO user_companies (user_id, company_id, role) SELECT id, company_id, role FROM users;

-- A client company managed by a consultant is billed through the consultant's own (home) company subscription.
ALTER TABLE companies ADD COLUMN billing_company_id INTEGER;
ALTER TABLE companies ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;

-- Professional credentials claimed by a consultant. Verification is a manual step by IBMP staff (see /admin/consultants).
CREATE TABLE IF NOT EXISTS consultant_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  body TEXT NOT NULL,                 -- ICAI | ICSI | ICMAI
  membership_no TEXT NOT NULL,
  registered_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | rejected
  note TEXT,
  submitted_at TIMESTAMP NOT NULL DEFAULT now(),
  verified_at TIMESTAMP
);
