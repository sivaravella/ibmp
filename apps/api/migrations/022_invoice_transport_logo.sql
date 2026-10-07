-- The fields of a traditional Indian invoice that were missing: how it is sent and paid, and the company logo.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS dispatched_through TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS destination TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms TEXT;       -- mode / terms of payment
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS other_refs TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo TEXT;               -- a small image as a data URL, printed on invoices
