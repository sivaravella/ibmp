-- SMS reminders: a third channel next to email and WhatsApp.
ALTER TABLE reminder_settings ADD COLUMN sms_enabled BOOLEAN NOT NULL DEFAULT false;
