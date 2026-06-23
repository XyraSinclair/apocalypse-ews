ALTER TABLE notification_signups ADD COLUMN wants_push INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_signups ADD COLUMN push_endpoint_cipher TEXT;
ALTER TABLE notification_signups ADD COLUMN push_endpoint_hash TEXT;
ALTER TABLE notification_signups ADD COLUMN push_p256dh_cipher TEXT;
ALTER TABLE notification_signups ADD COLUMN push_auth_cipher TEXT;
ALTER TABLE notification_signups ADD COLUMN push_encoding TEXT;
ALTER TABLE notification_signups ADD COLUMN push_user_agent_hash TEXT;
ALTER TABLE notification_signups ADD COLUMN push_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_signups ADD COLUMN push_last_success_at TEXT;
ALTER TABLE notification_signups ADD COLUMN push_last_failure_at TEXT;
ALTER TABLE notification_signups ADD COLUMN push_last_error TEXT;
ALTER TABLE notification_signups ADD COLUMN push_expired_at TEXT;
ALTER TABLE notification_signups ADD COLUMN push_opted_out_at TEXT;
ALTER TABLE notification_signups ADD COLUMN push_opt_out_source TEXT;

ALTER TABLE notification_alerts ADD COLUMN push_sent_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_notification_signups_push_endpoint_hash
  ON notification_signups (push_endpoint_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_signups_active_push_endpoint_hash_unique
  ON notification_signups (push_endpoint_hash)
  WHERE push_endpoint_hash IS NOT NULL
    AND status IN ('active', 'past_due')
    AND wants_push = 1
    AND push_expired_at IS NULL
    AND push_opted_out_at IS NULL;
