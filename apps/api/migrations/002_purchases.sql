ALTER TABLE companies ADD COLUMN bill_seq INTEGER NOT NULL DEFAULT 0;

-- Vendor bills. GST is exclusive (added on top of taxable), matching prototype v6.2.
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  number TEXT NOT NULL,              -- internal: BILL-0001
  supplier_bill_no TEXT NOT NULL,    -- vendor's own invoice number
  date DATE NOT NULL,
  place_of_supply CHAR(2) NOT NULL,  -- vendor state; decides CGST+SGST vs IGST input credit
  taxable NUMERIC(14,2) NOT NULL,
  cgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  UNIQUE (company_id, party_id, supplier_bill_no)
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  description TEXT NOT NULL,
  hsn TEXT,
  qty NUMERIC(14,3) NOT NULL,
  rate NUMERIC(14,2) NOT NULL,
  gst_pct NUMERIC(5,2) NOT NULL,
  taxable NUMERIC(14,2) NOT NULL
);
