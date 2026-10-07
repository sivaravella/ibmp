-- Daily attendance register. One mark per employee per day; unmarked days are treated as present (and flagged).
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  status TEXT NOT NULL,               -- P present | A absent (loss of pay) | HD half day | L paid leave | H holiday | WO week off
  UNIQUE (employee_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  week_offs TEXT NOT NULL DEFAULT '0'  -- comma-separated weekday numbers, 0 = Sunday
);

CREATE TABLE IF NOT EXISTS attendance_holidays (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  date DATE NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (company_id, date)
);
