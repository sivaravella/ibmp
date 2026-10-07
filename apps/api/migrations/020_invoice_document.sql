-- What a GST tax invoice carries beyond the basics: terms and references, a delivery address, discounts, the tax of each line,
-- and the supplier's bank details, terms and signatory.
ALTER TABLE invoices ADD COLUMN due_date DATE;
ALTER TABLE invoices ADD COLUMN reference TEXT;              -- the buyer's PO number or other reference
ALTER TABLE invoices ADD COLUMN notes TEXT;                  -- printed on this invoice only
ALTER TABLE invoices ADD COLUMN ship_to TEXT;                -- delivery address when it differs from the buyer's
ALTER TABLE invoices ADD COLUMN discount NUMERIC(14,2) NOT NULL DEFAULT 0;   -- total of the line discounts

ALTER TABLE invoice_lines ADD COLUMN discount_pct NUMERIC(6,3) NOT NULL DEFAULT 0;
ALTER TABLE invoice_lines ADD COLUMN discount NUMERIC(14,2) NOT NULL DEFAULT 0;   -- amount taken off qty x rate; taxable is after it
ALTER TABLE invoice_lines ADD COLUMN cgst NUMERIC(14,2);     -- null on invoices made before this release: worked out when shown
ALTER TABLE invoice_lines ADD COLUMN sgst NUMERIC(14,2);
ALTER TABLE invoice_lines ADD COLUMN igst NUMERIC(14,2);
ALTER TABLE invoice_lines ADD COLUMN unit TEXT;

ALTER TABLE companies ADD COLUMN bank_name TEXT;
ALTER TABLE companies ADD COLUMN bank_account TEXT;
ALTER TABLE companies ADD COLUMN bank_ifsc TEXT;
ALTER TABLE companies ADD COLUMN bank_branch TEXT;
ALTER TABLE companies ADD COLUMN upi_id TEXT;
ALTER TABLE companies ADD COLUMN invoice_terms TEXT;         -- terms and conditions printed on every invoice
ALTER TABLE companies ADD COLUMN invoice_footer TEXT;
ALTER TABLE companies ADD COLUMN signatory TEXT;             -- name under "Authorised signatory"
ALTER TABLE companies ADD COLUMN payment_days INTEGER NOT NULL DEFAULT 0;   -- default credit period
