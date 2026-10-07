-- Leave management. Balances are computed from rules + approved leave + adjustments (see src/leave.js), not stored.
CREATE TABLE IF NOT EXISTS leave_types (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  paid BOOLEAN NOT NULL DEFAULT true,
  quota NUMERIC(5,1),                          -- days per leave year; null = unlimited (e.g. leave without pay)
  accrual TEXT NOT NULL DEFAULT 'monthly',     -- monthly (quota/12 per month) | annual (whole quota at the start of the year)
  carry_forward_max NUMERIC(5,1) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS leave_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  half_day TEXT,                               -- first | second, single-day requests only
  days NUMERIC(5,1) NOT NULL,                  -- working days counted (week offs and holidays excluded)
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | cancelled
  decided_by INTEGER REFERENCES users(id),
  decided_on DATE,
  decision_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- One row per counted day. mark / prev_mark remember the attendance entry written on approval so a cancel can restore it.
CREATE TABLE IF NOT EXISTS leave_application_days (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES leave_applications(id),
  date DATE NOT NULL,
  fraction NUMERIC(2,1) NOT NULL,              -- 1 or 0.5
  mark TEXT,
  prev_mark TEXT
);

-- Opening balances, corrections, encashment (negative). Counted in the leave year containing `date`.
CREATE TABLE IF NOT EXISTS leave_adjustments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  date DATE NOT NULL,
  days NUMERIC(5,1) NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
