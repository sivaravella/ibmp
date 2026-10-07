-- Reverse charge on a purchase: the vendor bills only the taxable value and the buyer assesses and pays the GST (section 9(3) and 9(4)).
-- For such a bill total = what is owed to the vendor (the taxable value) and cgst/sgst/igst = the tax the buyer assesses itself.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT false;
