-- Compliance calendar. Items are generated from rules at read time (src/compliance.js); only user actions are stored.
CREATE TABLE IF NOT EXISTS compliance_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  gst_frequency TEXT NOT NULL DEFAULT 'monthly',   -- monthly | quarterly (QRMP)
  tds_deductor BOOLEAN NOT NULL DEFAULT false,
  pf BOOLEAN NOT NULL DEFAULT false,
  esi BOOLEAN NOT NULL DEFAULT false,
  advance_tax BOOLEAN NOT NULL DEFAULT true,
  tax_audit BOOLEAN NOT NULL DEFAULT false,
  track_from DATE                                 -- hide items due before this date; null = the day the company was created
);

-- One row per (rule, period) the user has acted on, plus custom items (rule_code = 'CUSTOM').
CREATE TABLE IF NOT EXISTS compliance_records (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  rule_code TEXT NOT NULL,
  period_key TEXT NOT NULL,
  completed_on DATE,
  reference TEXT,                      -- e.g. ARN / challan number
  due_override DATE,                   -- government extension etc.
  override_note TEXT,
  notes TEXT,
  name TEXT,                           -- custom items only
  category TEXT,
  due_date DATE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, rule_code, period_key)
);
