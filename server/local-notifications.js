const crypto = require('node:crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js/min');
const { cleanPublicUrl } = require('./public-url');

const ALERT_DISPATCH_LIMIT = 25;
const EMAIL_CONCURRENCY = 8;
const SMS_MIN_INTERVAL_MS = 250;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireEnv(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) {
    throw new HttpError(503, `Missing required notification secret: ${key}.`);
  }
  return value;
}

function notificationHash(env, type, value) {
  return crypto.createHmac('sha256', requireEnv(env, 'NOTIFICATION_HASH_SECRET')).update(`${type}:${value}`).digest('hex');
}

function getEncryptionKey(env) {
  const key = Buffer.from(requireEnv(env, 'NOTIFICATION_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) {
    throw new HttpError(503, 'NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function encryptString(env, value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptString(env, value) {
  if (!value) return null;
  const [version, ivBase64, tagBase64, encryptedBase64] = String(value).split(':');
  if (version !== 'v1' || !ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Stored contact data uses an unsupported encryption format.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(env), Buffer.from(ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()]).toString('utf8');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const candidate = raw.startsWith('+')
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith('1')
        ? `+${digits}`
        : raw;
  const phone = parsePhoneNumberFromString(candidate, 'US');
  if (!phone || !phone.isValid()) {
    throw new HttpError(400, 'Enter a valid phone number.');
  }
  if (!['US', 'CA'].includes(phone.country)) {
    throw new HttpError(400, 'SMS alerts currently support US and Canadian numbers.');
  }
  return phone.number;
}

function normalizeSignupPayload(payload) {
  const email = normalizeEmail(payload?.email);
  const phone = normalizePhone(payload?.phone);
  if (!email && !phone) {
    throw new HttpError(400, 'Enter an email address, a phone number, or both.');
  }
  return { email, phone };
}

function upsertSubscriber(db, payload, env = process.env) {
  const contacts = normalizeSignupPayload(payload);
  const emailHash = contacts.email ? notificationHash(env, 'email', contacts.email) : null;
  const phoneHash = contacts.phone ? notificationHash(env, 'phone', contacts.phone) : null;
  const existing = db
    .prepare(`
      SELECT *
      FROM notification_subscribers
      WHERE (? IS NOT NULL AND email_hash = ?)
         OR (? IS NOT NULL AND phone_hash = ?)
      ORDER BY id ASC
      LIMIT 1
    `)
    .get(emailHash, emailHash, phoneHash, phoneHash);

  const row = {
    status: 'active',
    email_hash: emailHash || existing?.email_hash || null,
    phone_hash: phoneHash || existing?.phone_hash || null,
    email_cipher: contacts.email ? encryptString(env, contacts.email) : existing?.email_cipher || null,
    phone_cipher: contacts.phone ? encryptString(env, contacts.phone) : existing?.phone_cipher || null,
    email_enabled: contacts.email ? 1 : Number(existing?.email_enabled || 0),
    sms_enabled: contacts.phone ? 1 : Number(existing?.sms_enabled || 0),
    source: 'local_api',
  };

  if (existing) {
    db.prepare(`
      UPDATE notification_subscribers
      SET status = @status,
          email_hash = @email_hash,
          phone_hash = @phone_hash,
          email_cipher = @email_cipher,
          phone_cipher = @phone_cipher,
          email_enabled = @email_enabled,
          sms_enabled = @sms_enabled,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ ...row, id: existing.id });
    return { id: existing.id, emailEnabled: Boolean(row.email_enabled), smsEnabled: Boolean(row.sms_enabled), reused: true };
  }

  const result = db.prepare(`
    INSERT INTO notification_subscribers (
      status,
      email_hash,
      phone_hash,
      email_cipher,
      phone_cipher,
      email_enabled,
      sms_enabled,
      source
    ) VALUES (
      @status,
      @email_hash,
      @phone_hash,
      @email_cipher,
      @phone_cipher,
      @email_enabled,
      @sms_enabled,
      @source
    )
  `).run(row);
  return { id: result.lastInsertRowid, emailEnabled: Boolean(row.email_enabled), smsEnabled: Boolean(row.sms_enabled), reused: false };
}

function getActiveSubscribers(db, env = process.env) {
  return db
    .prepare(`
      SELECT *
      FROM notification_subscribers
      WHERE status = 'active'
        AND (email_enabled = 1 OR sms_enabled = 1)
      ORDER BY id ASC
    `)
    .all()
    .map((subscriber) => ({
      id: subscriber.id,
      email: subscriber.email_enabled ? decryptString(env, subscriber.email_cipher) : null,
      phone: subscriber.sms_enabled ? decryptString(env, subscriber.phone_cipher) : null,
      emailHash: subscriber.email_hash,
      phoneHash: subscriber.phone_hash,
    }));
}

function listAlertEvents(db, { limit = 50 } = {}) {
  return db
    .prepare(`
      SELECT id, kind, severity, cohort, occurred_at AS occurredAt, title, message, payload_json AS payloadJson, status, created_at AS createdAt, dispatched_at AS dispatchedAt, dispatch_summary_json AS dispatchSummaryJson
      FROM alert_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map((event) => ({
      ...event,
      payload: JSON.parse(event.payloadJson),
      payloadJson: undefined,
      dispatchSummary: event.dispatchSummaryJson ? JSON.parse(event.dispatchSummaryJson) : null,
      dispatchSummaryJson: undefined,
    }));
}

function listTakeoffEvents(db, { limit = 100 } = {}) {
  return db
    .prepare(`
      SELECT id, cohort, hex, registration, label, source, observed_at AS observedAt, previous_observed_at AS previousObservedAt, lat, lon, altitude_ft AS altitudeFt, ground_speed_kt AS groundSpeedKt, track, created_at AS createdAt
      FROM takeoff_events
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPacer(intervalMs) {
  let nextAvailableAt = 0;
  let chain = Promise.resolve();
  return {
    wait() {
      const turn = chain.then(async () => {
        const now = Date.now();
        const waitMs = Math.max(0, nextAvailableAt - now);
        nextAvailableAt = Math.max(now, nextAvailableAt) + intervalMs;
        if (waitMs > 0) await sleep(waitMs);
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

async function sendEmail(env, { to, subject, text }) {
  const apiKey = requireEnv(env, 'SENDGRID_API_KEY');
  const fromEmail = requireEnv(env, 'SENDGRID_FROM_EMAIL');
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: fromEmail, name: String(env.SENDGRID_FROM_NAME || 'Apocalypse EWS') },
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `SendGrid request failed with ${response.status}`);
  }
  return { providerMessageId: response.headers.get('x-message-id') || null };
}

async function sendSms(env, { to, text }) {
  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireEnv(env, 'TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: requireEnv(env, 'TELNYX_NUMBER'),
      to,
      text,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.errors?.[0]?.detail || `Telnyx request failed with ${response.status}`);
  }
  return { providerMessageId: payload.data?.id || null };
}

function recordDelivery(db, delivery) {
  db.prepare(`
    INSERT INTO alert_deliveries (
      alert_event_id,
      subscriber_id,
      channel,
      destination_hash,
      status,
      provider_message_id,
      error,
      attempted_at
    ) VALUES (
      @alertEventId,
      @subscriberId,
      @channel,
      @destinationHash,
      @status,
      @providerMessageId,
      @error,
      @attemptedAt
    )
    ON CONFLICT(alert_event_id, subscriber_id, channel) DO UPDATE SET
      destination_hash = excluded.destination_hash,
      status = excluded.status,
      provider_message_id = excluded.provider_message_id,
      error = excluded.error,
      attempted_at = excluded.attempted_at
  `).run(delivery);
}

function hasSentDelivery(db, alertEventId, subscriberId, channel) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM alert_deliveries
    WHERE alert_event_id = ?
      AND subscriber_id = ?
      AND channel = ?
      AND status = 'sent'
  `).get(alertEventId, subscriberId, channel));
}


async function dispatchOne(db, env, alert, subscriber, channel, pacer = null) {
  const destination = channel === 'sms' ? subscriber.phone : subscriber.email;
  const destinationHash = channel === 'sms' ? subscriber.phoneHash : subscriber.emailHash;
  const attemptedAt = new Date().toISOString();
  try {
    if (pacer) await pacer.wait();
    const result = channel === 'sms'
      ? await sendSms(env, { to: destination, text: `${alert.title}. ${alert.message}`.slice(0, 800) })
      : await sendEmail(env, { to: destination, subject: alert.title, text: [alert.message, cleanPublicUrl(env.EWS_PUBLIC_URL)].filter(Boolean).join('\n\n') });
    recordDelivery(db, {
      alertEventId: alert.id,
      subscriberId: subscriber.id,
      channel,
      destinationHash,
      status: 'sent',
      providerMessageId: result.providerMessageId,
      error: null,
      attemptedAt,
    });
    return { ok: true, channel };
  } catch (error) {
    recordDelivery(db, {
      alertEventId: alert.id,
      subscriberId: subscriber.id,
      channel,
      destinationHash,
      status: 'failed',
      providerMessageId: null,
      error: error.message,
      attemptedAt,
    });
    return { ok: false, channel, error: error.message };
  }
}

async function dispatchPendingAlerts(db, env = process.env, { limit = ALERT_DISPATCH_LIMIT } = {}) {
  const alerts = db
    .prepare(`
      SELECT *
      FROM alert_events
      WHERE status IN ('pending', 'failed', 'partial')
      ORDER BY occurred_at ASC, id ASC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Number(limit) || ALERT_DISPATCH_LIMIT, 1), 100));
  const subscribers = getActiveSubscribers(db, env);
  const summary = { alerts: alerts.length, subscribers: subscribers.length, deliveries: 0, sent: 0, failed: 0, noRecipients: 0 };
  const smsPacer = createPacer(Number(env.LEVEL5_SMS_MIN_INTERVAL_MS || SMS_MIN_INTERVAL_MS));

  for (const alert of alerts) {
    const work = [];
    for (const subscriber of subscribers) {
      if (subscriber.email && !hasSentDelivery(db, alert.id, subscriber.id, 'email')) work.push({ subscriber, channel: 'email' });
      if (subscriber.phone && !hasSentDelivery(db, alert.id, subscriber.id, 'sms')) work.push({ subscriber, channel: 'sms' });
    }

    if (!work.length) {
      const reason = subscribers.length ? 'all_deliveries_already_sent' : 'no_active_subscribers';
      db.prepare(`
        UPDATE alert_events
        SET status = ?, dispatched_at = CURRENT_TIMESTAMP, dispatch_summary_json = ?
        WHERE id = ?
      `).run(subscribers.length ? 'sent' : 'no_recipients', JSON.stringify({ deliveries: 0, reason }), alert.id);
      if (!subscribers.length) {
        summary.noRecipients += 1;
      }
      continue;
    }

    const results = await mapWithConcurrency(work, EMAIL_CONCURRENCY, ({ subscriber, channel }) =>
      dispatchOne(db, env, alert, subscriber, channel, channel === 'sms' ? smsPacer : null),
    );
    const sent = results.filter((result) => result.ok).length;
    const failed = results.length - sent;
    summary.deliveries += results.length;
    summary.sent += sent;
    summary.failed += failed;
    db.prepare(`
      UPDATE alert_events
      SET status = ?, dispatched_at = CURRENT_TIMESTAMP, dispatch_summary_json = ?
      WHERE id = ?
    `).run(failed === 0 ? 'sent' : sent > 0 ? 'partial' : 'failed', JSON.stringify({ deliveries: results.length, sent, failed }), alert.id);
  }

  return summary;
}

module.exports = {
  HttpError,
  dispatchPendingAlerts,
  listAlertEvents,
  listTakeoffEvents,
  normalizeEmail,
  normalizePhone,
  upsertSubscriber,
};
