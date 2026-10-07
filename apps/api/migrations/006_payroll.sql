-- Payroll: employee master, monthly runs and payslips.
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  department TEXT,
  emp_type TEXT NOT NULL DEFAULT 'full_time',
  doj DATE NOT NULL,
  exit_date DATE,
  pan TEXT,
  uan TEXT,                                   -- PF universal account number
  esi_no TEXT,
  bank_account TEXT,
  ifsc TEXT,
  mobile TEXT,
  email TEXT,
  -- monthly salary structure (full month, before loss of pay)
  basic NUMERIC(14,2) NOT NULL,
  hra NUMERIC(14,2) NOT NULL DEFAULT 0,
  special NUMERIC(14,2) NOT NULL DEFAULT 0,
  travel NUMERIC(14,2) NOT NULL DEFAULT 0,
  medical NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_applicable BOOLEAN NOT NULL DEFAULT true,
  pf_on_actual BOOLEAN NOT NULL DEFAULT false, -- contribute on actual basic instead of the ₹15,000 ceiling
  esi_applicable BOOLEAN NOT NULL DEFAULT true,
  pt_monthly NUMERIC(14,2) NOT NULL DEFAULT 0, -- professional tax per month (state slabs vary: set per employee)
  tax_regime TEXT NOT NULL DEFAULT 'new',
  declared_deductions NUMERIC(14,2) NOT NULL DEFAULT 0, -- annual, old regime only (include employee PF)
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  month TEXT NOT NULL,                        -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | finalized | paid
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  finalized_on DATE,
  paid_on DATE,
  pay_mode TEXT,
  remitted_pf DATE,
  remitted_esi DATE,
  remitted_tds DATE,
  remitted_pt DATE,
  employees INTEGER NOT NULL DEFAULT 0,
  gross NUMERIC(14,2) NOT NULL DEFAULT 0,
  net NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_employee NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_employer NUMERIC(14,2) NOT NULL DEFAULT 0,
  edli NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_admin NUMERIC(14,2) NOT NULL DEFAULT 0,
  esi_employee NUMERIC(14,2) NOT NULL DEFAULT 0,
  esi_employer NUMERIC(14,2) NOT NULL DEFAULT 0,
  tds NUMERIC(14,2) NOT NULL DEFAULT 0,
  professional_tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, month)
);

CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  -- snapshot of the employee at the time of the run, so old payslips never change
  emp_code TEXT NOT NULL,
  emp_name TEXT NOT NULL,
  designation TEXT,
  department TEXT,
  pan TEXT,
  uan TEXT,
  bank_account TEXT,
  ifsc TEXT,
  doj DATE,
  days_in_month INTEGER NOT NULL,
  employed_days INTEGER NOT NULL,
  lop_days NUMERIC(5,1) NOT NULL DEFAULT 0,
  paid_days NUMERIC(5,1) NOT NULL,
  earned_basic NUMERIC(14,2) NOT NULL DEFAULT 0,
  earned_hra NUMERIC(14,2) NOT NULL DEFAULT 0,
  earned_special NUMERIC(14,2) NOT NULL DEFAULT 0,
  earned_travel NUMERIC(14,2) NOT NULL DEFAULT 0,
  earned_medical NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_earnings NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross NUMERIC(14,2) NOT NULL,
  pf_wages NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_employee NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_eps NUMERIC(14,2) NOT NULL DEFAULT 0,
  pf_epf NUMERIC(14,2) NOT NULL DEFAULT 0,
  edli NUMERIC(14,2) NOT NULL DEFAULT 0,
  esi_covered BOOLEAN NOT NULL DEFAULT false,
  esi_employee NUMERIC(14,2) NOT NULL DEFAULT 0,
  esi_employer NUMERIC(14,2) NOT NULL DEFAULT 0,
  professional_tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  tds NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net NUMERIC(14,2) NOT NULL,
  taxable_income NUMERIC(14,2) NOT NULL DEFAULT 0,
  annual_tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  warnings TEXT,                              -- JSON array
  UNIQUE (run_id, employee_id)
);
