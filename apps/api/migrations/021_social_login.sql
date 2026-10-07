-- Sign in with Google or LinkedIn: which provider account belongs to which user. A user can have several, and keeps their password if they have one.
CREATE TABLE IF NOT EXISTS user_identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,            -- google | linkedin
  subject TEXT NOT NULL,             -- the provider's id for the person
  email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
