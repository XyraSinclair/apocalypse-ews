ALTER TABLE notification_signups ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE notification_signups ADD COLUMN account_email_cipher TEXT;
ALTER TABLE notification_signups ADD COLUMN account_email_hash TEXT;
ALTER TABLE notification_signups ADD COLUMN account_email_source TEXT;
ALTER TABLE notification_signups ADD COLUMN phone_country TEXT;
ALTER TABLE notification_signups ADD COLUMN sms_opted_out_at TEXT;
ALTER TABLE notification_signups ADD COLUMN sms_opt_out_source TEXT;
ALTER TABLE notification_signups ADD COLUMN email_opted_out_at TEXT;
ALTER TABLE notification_signups ADD COLUMN email_opt_out_source TEXT;
ALTER TABLE notification_signups ADD COLUMN welcome_email_sent_at TEXT;
ALTER TABLE notification_signups ADD COLUMN welcome_sms_sent_at TEXT;
ALTER TABLE notification_signups ADD COLUMN stripe_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_signups ADD COLUMN manual_note TEXT;

UPDATE notification_signups
SET
  account_email_cipher = email_cipher,
  account_email_hash = email_hash,
  account_email_source = CASE WHEN wants_email = 1 THEN 'signup' ELSE 'stripe' END
WHERE account_email_cipher IS NULL
  AND email_cipher IS NOT NULL;

UPDATE notification_signups
SET
  email_cipher = NULL,
  email_hash = NULL
WHERE wants_email = 0;

CREATE INDEX IF NOT EXISTS idx_notification_signups_account_email_hash
  ON notification_signups (account_email_hash);

CREATE INDEX IF NOT EXISTS idx_notification_signups_source_status
  ON notification_signups (source, status);
