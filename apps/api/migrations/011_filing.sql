-- GST return filing through a GSP. A filing is one return for one period; it moves
-- draft -> saved -> submitted -> filed (or to 'error' when the GSP rejects the upload).
CREATE TABLE IF NOT EXISTS gst_filings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  return_type TEXT NOT NULL,            -- GSTR1 | GSTR3B
  period TEXT NOT NULL,                 -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'draft', -- draft | saved | error | submitted | filed
  payload TEXT NOT NULL,                -- JSON snapshot that was reviewed and is sent
  payload_hash TEXT NOT NULL,           -- sha256 of the payload: filing requires the user to confirm exactly this
  validation TEXT,                      -- JSON { errors, warnings }
  summary TEXT,                         -- JSON figures shown for review (taxable value, tax, cash payable)
  gsp_reference TEXT,
  gsp_errors TEXT,                      -- JSON list of errors returned by the GSP
  payment_ref TEXT,                     -- challan reference for GSTR-3B cash liability
  arn TEXT,
  filed_on DATE,
  prepared_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, return_type, period)
);

CREATE TABLE IF NOT EXISTS gst_filing_events (
  id SERIAL PRIMARY KEY,
  filing_id INTEGER NOT NULL REFERENCES gst_filings(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- The GST portal session obtained through the GSP. The token is encrypted at rest and expires after a few hours.
CREATE TABLE IF NOT EXISTS gsp_sessions (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  username TEXT NOT NULL,
  request_id TEXT,
  token_enc TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
