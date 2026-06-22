ALTER TABLE notification_deliveries ADD COLUMN message_text_cipher TEXT;
ALTER TABLE notification_deliveries ADD COLUMN subject TEXT;

CREATE TABLE IF NOT EXISTS notification_inbound_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  provider_event_id TEXT,
  subscriber_id TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  phone_hash TEXT,
  from_phone_hash TEXT,
  from_phone_cipher TEXT,
  to_phone_hash TEXT,
  to_phone_cipher TEXT,
  message_text_cipher TEXT,
  action TEXT,
  status TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT,
  UNIQUE(provider, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_inbound_messages_phone
  ON notification_inbound_messages (phone_hash, received_at);

CREATE INDEX IF NOT EXISTS idx_notification_inbound_messages_subscriber
  ON notification_inbound_messages (subscriber_id, received_at);

CREATE INDEX IF NOT EXISTS idx_notification_inbound_messages_provider_event
  ON notification_inbound_messages (provider, provider_event_id);
