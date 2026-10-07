-- How invoice numbers are issued. 'continuous' (the default, as before) never restarts: INV-0001, INV-0002, ...
-- 'financial_year' restarts at 1 every 1 April: INV/26-27/0001. Rule 46 asks for a serial number that is unique in the financial year
-- and at most 16 characters, so the prefix is limited to 5.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_numbering TEXT NOT NULL DEFAULT 'continuous';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NOT NULL DEFAULT 'INV';
CREATE TABLE IF NOT EXISTS invoice_sequences (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  fy TEXT NOT NULL,                  -- '2026-27'
  seq INTEGER NOT NULL,
  PRIMARY KEY (company_id, fy)
);
