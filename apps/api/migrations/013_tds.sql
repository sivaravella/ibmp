-- TDS on salary: deductor identity, challan details for each month's deposit, and the record of statements filed.
ALTER TABLE companies ADD COLUMN tan TEXT;
ALTER TABLE companies ADD COLUMN pan TEXT;                        -- deductor PAN; defaults to the one inside the GSTIN
ALTER TABLE companies ADD COLUMN tds_person_name TEXT;            -- person responsible for deducting tax
ALTER TABLE companies ADD COLUMN tds_person_designation TEXT;
ALTER TABLE companies ADD COLUMN deductor_type TEXT;

-- Bank challan (ITNS 281) details for the TDS deposited for a payroll month.
ALTER TABLE payroll_runs ADD COLUMN tds_bsr TEXT;                 -- 7-digit BSR code of the bank branch
ALTER TABLE payroll_runs ADD COLUMN tds_challan_serial TEXT;      -- 5-digit challan serial number
ALTER TABLE payroll_runs ADD COLUMN tds_interest NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs ADD COLUMN tds_fee NUMERIC(14,2) NOT NULL DEFAULT 0;

-- A 24Q statement that has been uploaded: the 15-digit token number is what TRACES and the Form 16 Part A refer to.
CREATE TABLE IF NOT EXISTS tds_statements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  fy TEXT NOT NULL,
  quarter INTEGER NOT NULL,
  token_no TEXT NOT NULL,
  filed_on DATE NOT NULL,
  filed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, fy, quarter)
);
