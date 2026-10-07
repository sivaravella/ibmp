-- Platform owner console: staff of the platform itself, kept apart from business users (users / companies).
CREATE TABLE IF NOT EXISTS platform_admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',          -- owner (can change things) | support (read only)
  active BOOLEAN NOT NULL DEFAULT true,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMP,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Every change a platform admin makes, who made it and why. Append-only.
CREATE TABLE IF NOT EXISTS platform_audit (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES platform_admins(id),
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,                                  -- JSON: reason, before and after
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- A suspended company (or a consultant whose home company is suspended) cannot use the portal at all.
ALTER TABLE companies ADD COLUMN suspended_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN suspended_reason TEXT;
