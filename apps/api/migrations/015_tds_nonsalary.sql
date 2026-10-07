-- TDS on payments other than salary (contractors, professionals, rent, commission, interest, purchase of goods) and Form 26Q.
ALTER TABLE parties ADD COLUMN pan TEXT;                           -- deductee PAN; falls back to the one inside the GSTIN
ALTER TABLE purchases ADD COLUMN tds NUMERIC(14,2) NOT NULL DEFAULT 0;   -- TDS deducted from this bill: the vendor is owed total - returns - tds
ALTER TABLE compliance_settings ADD COLUMN tds_nonsalary BOOLEAN NOT NULL DEFAULT false;

-- One row per deduction. taxed_base is the part of the payment this row's TDS was computed on: when an annual threshold is
-- crossed the row catches up on everything paid earlier, so taxed_base can exceed base.
CREATE TABLE IF NOT EXISTS tds_deductions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  section TEXT NOT NULL,                  -- 26Q section code: 94A 94C 94H 94IA 94IB 94JA 94JB 94Q
  kind TEXT NOT NULL,                     -- bill (deducted from a purchase bill) | expense (paid directly)
  purchase_id INTEGER REFERENCES purchases(id),
  date DATE NOT NULL,                     -- date of payment or credit, which is also the date of deduction
  base NUMERIC(14,2) NOT NULL,            -- amount paid or credited, excluding GST
  taxed_base NUMERIC(14,2) NOT NULL,
  rate NUMERIC(6,3) NOT NULL,
  rate_reason TEXT NOT NULL,              -- standard | no_pan | override
  tds NUMERIC(14,2) NOT NULL,
  cert_ref TEXT,                          -- lower-deduction certificate number, when the rate was overridden
  gst NUMERIC(14,2) NOT NULL DEFAULT 0,   -- GST charged on top (expense payments), added to what the vendor receives
  expense_account_id INTEGER REFERENCES accounts(id),
  mode TEXT,                              -- cash | bank, for expense payments
  narration TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'active',  -- active | reversed
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- The bank challan for the TDS deducted in one month. Company and non-company deductees need separate challans (ITNS 281 codes 0020 / 0021).
CREATE TABLE IF NOT EXISTS tds_ns_challans (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  month TEXT NOT NULL,                    -- month the TDS was deducted in (YYYY-MM)
  deductee_type TEXT NOT NULL,            -- company | non_company
  bsr TEXT NOT NULL,
  serial TEXT NOT NULL,
  deposited_on DATE NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  interest NUMERIC(14,2) NOT NULL DEFAULT 0,
  fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, month, deductee_type)
);

CREATE TABLE IF NOT EXISTS tds26_statements (
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
