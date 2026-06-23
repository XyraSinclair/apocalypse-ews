CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_signups_active_email_hash_unique
  ON notification_signups (email_hash)
  WHERE email_hash IS NOT NULL
    AND status IN ('active', 'past_due')
    AND wants_email = 1
    AND email_opted_out_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_signups_active_phone_hash_unique
  ON notification_signups (phone_hash)
  WHERE phone_hash IS NOT NULL
    AND status IN ('active', 'past_due')
    AND wants_sms = 1
    AND sms_opted_out_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_signups_active_account_email_hash_unique
  ON notification_signups (account_email_hash)
  WHERE account_email_hash IS NOT NULL
    AND status IN ('active', 'past_due');
