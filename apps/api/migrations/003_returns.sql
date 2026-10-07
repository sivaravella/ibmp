-- Returns: credit notes (against sales invoices) and debit notes (against vendor bills).
ALTER TABLE invoices ADD COLUMN returned NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN returned NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN cn_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN dn_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,                 -- credit | debit
  number TEXT NOT NULL,               -- CN-0001 / DN-0001
  invoice_id INTEGER REFERENCES invoices(id),
  purchase_id INTEGER REFERENCES purchases(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  date DATE NOT NULL,
  reason TEXT,
  return_type TEXT NOT NULL,          -- goods (stock moves) | value (price/discount only)
  taxable NUMERIC(14,2) NOT NULL,
  cgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

-- source_line_id points at invoice_lines or purchase_lines depending on notes.kind.
CREATE TABLE IF NOT EXISTS note_lines (
  id SERIAL PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id),
  source_line_id INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id),
  description TEXT NOT NULL,
  hsn TEXT,
  qty NUMERIC(14,3),                  -- null for value-only lines
  rate NUMERIC(14,2) NOT NULL,
  gst_pct NUMERIC(5,2) NOT NULL,
  taxable NUMERIC(14,2) NOT NULL
);
