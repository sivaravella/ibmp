-- E-invoice (IRN) and e-way bill support. The IRP and the e-way bill portal need full postal details for both parties.
ALTER TABLE companies ADD COLUMN legal_name TEXT;
ALTER TABLE companies ADD COLUMN trade_name TEXT;
ALTER TABLE companies ADD COLUMN addr1 TEXT;
ALTER TABLE companies ADD COLUMN addr2 TEXT;
ALTER TABLE companies ADD COLUMN loc TEXT;            -- town / city
ALTER TABLE companies ADD COLUMN pin TEXT;
ALTER TABLE companies ADD COLUMN phone TEXT;
ALTER TABLE companies ADD COLUMN email TEXT;
ALTER TABLE companies ADD COLUMN einvoice_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN einvoice_from DATE;  -- documents dated before this are not required to have an IRN
ALTER TABLE companies ADD COLUMN ewb_threshold NUMERIC(14,2) NOT NULL DEFAULT 50000;

ALTER TABLE parties ADD COLUMN addr1 TEXT;
ALTER TABLE parties ADD COLUMN addr2 TEXT;
ALTER TABLE parties ADD COLUMN loc TEXT;
ALTER TABLE parties ADD COLUMN pin TEXT;

-- One e-invoice record per document (a sales invoice or a credit note). pending -> generated -> cancelled, or failed.
CREATE TABLE IF NOT EXISTS einvoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  doc_type TEXT NOT NULL,                 -- INV | CRN
  doc_id INTEGER NOT NULL,                -- invoices.id or notes.id
  doc_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | generated | cancelled | failed
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  validation TEXT,                        -- JSON { errors, warnings }
  irn TEXT,
  ack_no TEXT,
  ack_date TIMESTAMP,
  signed_qr TEXT,
  gsp_errors TEXT,
  cancel_reason TEXT,
  cancelled_on TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_type, doc_id)
);

CREATE TABLE IF NOT EXISTS ewaybills (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | generated | cancelled | failed
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  validation TEXT,
  ewb_no TEXT,
  ewb_date TIMESTAMP,
  valid_upto TIMESTAMP,
  vehicle_no TEXT,
  transporter_id TEXT,
  distance INTEGER,
  gsp_errors TEXT,
  cancel_reason TEXT,
  cancelled_on TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS edoc_events (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                     -- einvoice | ewb
  doc_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
