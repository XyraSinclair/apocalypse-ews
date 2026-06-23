CREATE INDEX IF NOT EXISTS idx_notification_signups_active_batch
  ON notification_signups (status, created_at, id);
