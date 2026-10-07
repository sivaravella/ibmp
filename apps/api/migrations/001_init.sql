-- IBMP schema v1 (portal MVP). Money is numeric(14,2); all rows are scoped by company_id.
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT NOT NULL,
  gstin TEXT,
  state_code CHAR(2) NOT NULL,
  address TEXT,
  invoice_seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parties (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,            -- customer | vendor
  name TEXT NOT NULL,
  gstin TEXT,
  state_code CHAR(2) NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  hsn TEXT,
  unit TEXT NOT NULL DEFAULT 'Nos',
  rate NUMERIC(14,2) NOT NULL DEFAULT 0,
  gst_pct NUMERIC(5,2) NOT NULL DEFAULT 18,
  stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  number TEXT NOT NULL,
  date DATE NOT NULL,
  place_of_supply CHAR(2) NOT NULL,
  taxable NUMERIC(14,2) NOT NULL,
  cgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  item_id INTEGER REFERENCES items(id),
  description TEXT NOT NULL,
  hsn TEXT,
  qty NUMERIC(14,3) NOT NULL,
  rate NUMERIC(14,2) NOT NULL,
  gst_pct NUMERIC(5,2) NOT NULL,
  taxable NUMERIC(14,2) NOT NULL
);
