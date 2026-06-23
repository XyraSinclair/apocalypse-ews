ALTER TABLE notification_alerts ADD COLUMN fanout_lease_token TEXT;
ALTER TABLE notification_alerts ADD COLUMN fanout_lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_alerts_processing_lease
  ON notification_alerts (status, fanout_lease_expires_at, updated_at);
