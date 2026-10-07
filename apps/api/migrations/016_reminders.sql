-- Compliance reminders by email and WhatsApp.
CREATE TABLE IF NOT EXISTS reminder_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  email_enabled BOOLEAN NOT NULL DEFAULT false,
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT false,
  lead_days TEXT NOT NULL DEFAULT '7,3,1,0',        -- days before the due date to remind on; 0 = on the day
  overdue_days TEXT NOT NULL DEFAULT '1,3,7',       -- days after the due date to remind on while still open
  enabled_since DATE,                                -- reminders are never sent for a stage that fell before this date
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Who gets them. A WhatsApp number needs the owner's confirmation that the person agreed to receive messages.
CREATE TABLE IF NOT EXISTS reminder_recipients (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  channel TEXT NOT NULL,                             -- email | whatsapp
  address TEXT NOT NULL,                             -- email address, or phone number as digits with country code
  name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  consent_at TIMESTAMP,
  consent_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, address)
);

-- One row per item per message, so a reminder is never sent twice; failed attempts are kept (item_key empty) and retried.
CREATE TABLE IF NOT EXISTS reminder_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  recipient_id INTEGER REFERENCES reminder_recipients(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reminder',            -- reminder | test
  item_key TEXT NOT NULL DEFAULT '',                -- rule|period|stage|due
  rule_code TEXT,
  period_key TEXT,
  stage TEXT,
  due DATE,
  status TEXT NOT NULL,                              -- sent | failed
  provider TEXT,
  provider_ref TEXT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_log_company ON reminder_log (company_id, created_at);
