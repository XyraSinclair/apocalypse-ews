CREATE TABLE IF NOT EXISTS notification_signups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  email_cipher TEXT,
  email_hash TEXT,
  phone_cipher TEXT,
  phone_hash TEXT,
  wants_email INTEGER NOT NULL DEFAULT 0,
  wants_sms INTEGER NOT NULL DEFAULT 0,
  sms_consent_at TEXT,
  sms_consent_ip_hash TEXT,
  sms_consent_user_agent_hash TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  checkout_url TEXT,
  checkout_created_at TEXT,
  checkout_completed_at TEXT,
  current_period_end TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_signups_status
  ON notification_signups (status);

CREATE INDEX IF NOT EXISTS idx_notification_signups_email_hash
  ON notification_signups (email_hash);

CREATE INDEX IF NOT EXISTS idx_notification_signups_phone_hash
  ON notification_signups (phone_hash);

CREATE INDEX IF NOT EXISTS idx_notification_signups_stripe_checkout
  ON notification_signups (stripe_checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_notification_signups_stripe_subscription
  ON notification_signups (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS notification_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  level INTEGER,
  slot_key TEXT,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL,
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  email_sent_count INTEGER NOT NULL DEFAULT 0,
  sms_sent_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_alerts_kind_created
  ON notification_alerts (kind, created_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  subscriber_id TEXT,
  channel TEXT NOT NULL,
  destination_hash TEXT,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (alert_id) REFERENCES notification_alerts (id)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_alert
  ON notification_deliveries (alert_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_subscriber
  ON notification_deliveries (subscriber_id);

CREATE TABLE IF NOT EXISTS notification_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
