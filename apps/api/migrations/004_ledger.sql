-- Double-entry ledger. Every posting is a balanced journal entry (sum debit = sum credit).
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- asset | liability | equity | income | expense
  normal TEXT NOT NULL,               -- debit | credit: the side that increases the balance
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  date DATE NOT NULL,
  narration TEXT,
  source_type TEXT NOT NULL,          -- invoice | purchase | credit_note | debit_note | receipt | payment | manual
  source_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  party_id INTEGER REFERENCES parties(id),   -- set on Debtors / Creditors lines for party statements
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0
);

-- Money actually received from customers / paid to vendors.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,                 -- receipt | payment
  invoice_id INTEGER REFERENCES invoices(id),
  purchase_id INTEGER REFERENCES purchases(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  mode TEXT NOT NULL DEFAULT 'cash',  -- cash | bank
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
