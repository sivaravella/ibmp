-- References returned by the EPFO and ESIC portals after a month's contribution is uploaded and paid.
ALTER TABLE payroll_runs ADD COLUMN pf_trrn TEXT;        -- 13-digit Temporary Return Reference Number of the ECR
ALTER TABLE payroll_runs ADD COLUMN esi_challan TEXT;    -- ESIC challan number
