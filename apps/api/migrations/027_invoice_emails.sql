-- Invoices sent to customers by email: who, when, by whom and whether it worked.
CREATE TABLE IF NOT EXISTS invoice_emails (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  to_address TEXT NOT NULL,
  sent_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL,              -- sent | failed
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_emails_invoice ON invoice_emails(invoice_id);
