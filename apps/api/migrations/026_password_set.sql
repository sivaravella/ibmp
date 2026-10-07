-- Accounts created with Google or LinkedIn have no password of their own until they set one; they must not be able to remove their last way in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT true;
