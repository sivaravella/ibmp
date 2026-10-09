-- New-business onboarding wizard.

-- One live email verification code per address. Only a keyed hash of the code is stored; times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS onboarding_otps (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,          -- wrong tries on this code; the code is dead after 5
  created_at BIGINT NOT NULL
);

-- Every code sent, for the hourly limits per email address and per network address. Old rows are removed as new ones are added.
CREATE TABLE IF NOT EXISTS onboarding_otp_sends (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  sent_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_otp_sends_email ON onboarding_otp_sends (email, sent_at);
CREATE INDEX IF NOT EXISTS onboarding_otp_sends_ip ON onboarding_otp_sends (ip, sent_at);

-- What the owner told us when signing up. The mobile number is collected but NOT verified until an SMS provider exists.
CREATE TABLE IF NOT EXISTS company_onboarding (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  nature TEXT,                                  -- trading | manufacturing | service
  industry_code TEXT,
  industry_name TEXT,
  turnover_slab TEXT,
  employee_range TEXT,
  preferred_plan TEXT,                          -- the plan the owner leaned towards; the account itself starts on the free trial
  mobile TEXT,
  mobile_verified BOOLEAN NOT NULL DEFAULT false,
  secondary_mobile TEXT,
  secondary_email TEXT,
  documents_used TEXT,                          -- comma separated: gst, coi, mca
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
