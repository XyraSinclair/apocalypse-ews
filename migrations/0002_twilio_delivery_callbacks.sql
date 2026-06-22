ALTER TABLE notification_deliveries ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_provider
  ON notification_deliveries (provider_message_id);
