ALTER TABLE notification_alerts ADD COLUMN subject TEXT;
ALTER TABLE notification_alerts ADD COLUMN sms_message_text TEXT;
ALTER TABLE notification_alerts ADD COLUMN fanout_after_created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_alerts ADD COLUMN fanout_after_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_alerts ADD COLUMN fanout_batch_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_alerts ADD COLUMN fanout_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_alerts_processing_updated
  ON notification_alerts (status, updated_at);
