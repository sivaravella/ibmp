ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(6,3) NOT NULL DEFAULT 0;   -- a discount on the whole invoice, shared over the lines before tax
