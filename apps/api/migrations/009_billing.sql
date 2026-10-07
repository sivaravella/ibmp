-- Subscriptions and billing. One subscription row per company; every purchase is a billing invoice settled by a gateway payment.
CREATE TABLE IF NOT EXISTS subscriptions (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  plan_code TEXT NOT NULL DEFAULT 'trial',    -- trial | starter | professional | enterprise (the plan of the latest paid period)
  trial_ends DATE NOT NULL,
  period_start DATE,
  period_end DATE,                            -- last day of paid access
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  number TEXT,                                -- assigned when paid, so the tax-invoice series has no gaps
  plan_code TEXT NOT NULL,
  months INTEGER NOT NULL,
  kind TEXT NOT NULL,                         -- new | renewal | upgrade
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  base NUMERIC(14,2) NOT NULL,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,    -- unused value of the previous plan (upgrades)
  taxable NUMERIC(14,2) NOT NULL,
  cgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | paid | void
  credited_ids TEXT,                          -- JSON array: earlier invoices whose unused time this one absorbed
  superseded_by INTEGER,                      -- set once an upgrade has used this invoice's remaining value
  customer_name TEXT,
  customer_gstin TEXT,
  customer_state CHAR(2),
  provider TEXT,
  order_id TEXT,
  payment_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  paid_on DATE
);

-- Every gateway callback and webhook is logged, whether or not it changed anything.
CREATE TABLE IF NOT EXISTS billing_events (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES billing_invoices(id),
  source TEXT NOT NULL,                       -- verify | webhook | simulator
  order_id TEXT,
  payment_id TEXT,
  outcome TEXT NOT NULL,                      -- paid | failed | ignored | rejected
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_counters (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
