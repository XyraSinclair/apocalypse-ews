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

function subscriberManagementToken(env, subscriber) {
  const createdAt = subscriber?.created_at || subscriber?.createdAt;
  if (!subscriber?.id || !createdAt) {
    throw new HttpError(500, 'Subscriber is missing account management fields.');
  }
  return crypto
    .createHmac('sha256', requireEnv(env, 'NOTIFICATION_HASH_SECRET'))
    .update(`account_management:${subscriber.id}:${createdAt}`)
    .digest('hex');
}

function timingSafeEqualHex(left, right) {
  const normalizedLeft = String(left || '').toLowerCase();
  const normalizedRight = String(right || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalizedLeft) || normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  const leftBuffer = Buffer.from(normalizedLeft, 'hex');
  const rightBuffer = Buffer.from(normalizedRight, 'hex');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSubscriberManagementPath(env, subscriber) {
  const token = subscriberManagementToken(env, subscriber);
  const params = new URLSearchParams({ subscriber: String(subscriber.id), token });
  return `/manage?${params.toString()}`;
}

function createSubscriberManagementUrl(env, subscriber) {
  const publicUrl = cleanPublicUrl(env.EWS_PUBLIC_URL);
  if (!publicUrl) {
    return null;
  }
  const baseUrl = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;
  return new URL(createSubscriberManagementPath(env, subscriber), baseUrl).toString();
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

function normalizeSubscriberId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Enter a valid subscriber ID.');
  }
  return id;
}

function getSubscriberById(db, subscriberId) {
  const id = normalizeSubscriberId(subscriberId);
  const subscriber = db
    .prepare(`
      SELECT *
      FROM notification_subscribers
      WHERE id = ?
    `)
    .get(id);
  if (!subscriber) {
    throw new HttpError(404, 'Subscriber not found.');
  }
  return subscriber;
}

function mapSubscriberResult(env, subscriber, reused = false) {
  return {
    id: subscriber.id,
    emailEnabled: Boolean(subscriber.email_enabled),
    smsEnabled: Boolean(subscriber.sms_enabled),
    managementPath: createSubscriberManagementPath(env, subscriber),
    reused,
  };
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
    return mapSubscriberResult(env, getSubscriberById(db, existing.id), true);
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
  return mapSubscriberResult(env, getSubscriberById(db, result.lastInsertRowid), false);
}

function hydrateSubscriber(env, subscriber) {
  return {
    id: subscriber.id,
    createdAt: subscriber.created_at,
    email: subscriber.email_enabled ? decryptString(env, subscriber.email_cipher) : null,
    phone: subscriber.sms_enabled ? decryptString(env, subscriber.phone_cipher) : null,
    emailHash: subscriber.email_hash,
    phoneHash: subscriber.phone_hash,
  };
}

function loadAuthorizedManagedSubscriber(db, env, subscriberId, token) {
  if (!subscriberId || !token) {
    throw new HttpError(400, 'Missing account management token.');
  }
  const subscriber = getSubscriberById(db, subscriberId);
  if (!timingSafeEqualHex(token, subscriberManagementToken(env, subscriber))) {
    throw new HttpError(403, 'Invalid account management token.');
  }
  return subscriber;
}

function phoneCountry(phone) {
  const parsed = phone ? parsePhoneNumberFromString(phone) : null;
  return parsed?.country || null;
}

function mapManagedSubscriber(env, subscriber) {
  const email = subscriber.email_cipher ? decryptString(env, subscriber.email_cipher) : null;
  const phone = subscriber.phone_cipher ? decryptString(env, subscriber.phone_cipher) : null;
  return {
    id: subscriber.id,
    status: subscriber.status,
    source: subscriber.source,
    accountEmail: email,
    email,
    phone,
    phoneCountry: phoneCountry(phone),
    smsSupported: Boolean(phone),
    wantsEmail: Boolean(subscriber.email_enabled),
    wantsSms: Boolean(subscriber.sms_enabled),
    currentPeriodEnd: null,
    stripeCancelAtPeriodEnd: false,
    hasStripeSubscription: false,
    stripeBillingPortalUrl: null,
    managementPath: createSubscriberManagementPath(env, subscriber),
  };
}

function readOptionalBoolean(payload, keys) {
  for (const key of keys) {
    if (typeof payload?.[key] === 'boolean') {
      return payload[key];
    }
  }
  return null;
}

function getManagedSubscriber(db, env, subscriberId, token) {
  return mapManagedSubscriber(env, loadAuthorizedManagedSubscriber(db, env, subscriberId, token));
}

function updateManagedSubscriber(db, env, payload) {
  const subscriber = loadAuthorizedManagedSubscriber(db, env, payload?.subscriber, payload?.token);
  const action = String(payload?.action || 'save').trim();

  if (action === 'delete_account') {
    db.prepare(`
      UPDATE notification_subscribers
      SET status = 'unsubscribed',
          email_enabled = 0,
          sms_enabled = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(subscriber.id);
    return mapManagedSubscriber(env, getSubscriberById(db, subscriber.id));
  }

  if (action !== 'save') {
    throw new HttpError(400, 'Unknown account management action.');
  }

  const wantsEmail = readOptionalBoolean(payload, ['wantsEmail', 'emailEnabled']);
  const wantsSms = readOptionalBoolean(payload, ['wantsSms', 'smsEnabled']);
  const emailEnabled = wantsEmail == null ? Boolean(subscriber.email_enabled) : wantsEmail;
  const smsEnabled = wantsSms == null ? Boolean(subscriber.sms_enabled) : wantsSms;
  if (emailEnabled && !subscriber.email_cipher) {
    throw new HttpError(400, 'This subscription does not have an email address.');
  }
  if (smsEnabled && !subscriber.phone_cipher) {
    throw new HttpError(400, 'This subscription does not have a phone number.');
  }

  db.prepare(`
    UPDATE notification_subscribers
    SET status = ?,
        email_enabled = ?,
        sms_enabled = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(emailEnabled || smsEnabled ? 'active' : 'unsubscribed', emailEnabled ? 1 : 0, smsEnabled ? 1 : 0, subscriber.id);

  return mapManagedSubscriber(env, getSubscriberById(db, subscriber.id));
}

function countActiveSubscribers(db) {
  return db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM notification_subscribers
      WHERE status = 'active'
        AND (email_enabled = 1 OR sms_enabled = 1)
    `)
    .get().count;
}

function getActiveSubscriberBatch(db, env = process.env, { afterId = 0, limit = 500 } = {}) {
  return db
    .prepare(`
      SELECT *
      FROM notification_subscribers
      WHERE status = 'active'
        AND (email_enabled = 1 OR sms_enabled = 1)
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(afterId, Math.min(Math.max(Number(limit) || 500, 1), 5000))
    .map((subscriber) => hydrateSubscriber(env, subscriber));
}

function getActiveSubscribers(db, env = process.env) {
  const subscribers = [];
  let afterId = 0;
  while (true) {
    const batch = getActiveSubscriberBatch(db, env, { afterId });
    if (!batch.length) {
      return subscribers;
    }
    subscribers.push(...batch);
    afterId = batch.at(-1).id;
  }
}

function listAlertEvents(db, { limit = 50 } = {}) {
  return db
    .prepare(`
      SELECT id, kind, severity, cohort, event_key AS eventKey, occurred_at AS occurredAt, title, message, payload_json AS payloadJson, status, created_at AS createdAt, dispatched_at AS dispatchedAt, dispatch_summary_json AS dispatchSummaryJson
      FROM alert_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map((event) => ({
      ...event,
      stableId: `alert:${event.eventKey}`,
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

function buildEmailAlertText(env, alert, subscriber) {
  const alertUrl = cleanPublicUrl(env.EWS_PUBLIC_URL);
  const managementUrl = createSubscriberManagementUrl(env, subscriber);
  return [
    alert.message,
    alertUrl,
    managementUrl ? `Manage or unsubscribe: ${managementUrl}` : null,
  ].filter(Boolean).join('\n\n');
}

function buildSmsAlertText(env, alert, subscriber) {
  const managementUrl = createSubscriberManagementUrl(env, subscriber);
  return [
    `${alert.title}. ${alert.message}`,
    managementUrl ? `Manage: ${managementUrl}` : null,
  ].filter(Boolean).join(' ').slice(0, 800);
}



async function dispatchOne(db, env, alert, subscriber, channel, pacer = null) {
  const destination = channel === 'sms' ? subscriber.phone : subscriber.email;
  const destinationHash = channel === 'sms' ? subscriber.phoneHash : subscriber.emailHash;
  const attemptedAt = new Date().toISOString();
  try {
    if (pacer) await pacer.wait();
    const result = channel === 'sms'
      ? await sendSms(env, { to: destination, text: buildSmsAlertText(env, alert, subscriber) })
      : await sendEmail(env, { to: destination, subject: alert.title, text: buildEmailAlertText(env, alert, subscriber) });
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
  const subscriberCount = countActiveSubscribers(db);
  const subscriberBatchSize = Math.min(Math.max(Number(env.ALERT_SUBSCRIBER_BATCH_SIZE) || 500, 1), 5000);
  const summary = { alerts: alerts.length, subscribers: subscriberCount, deliveries: 0, sent: 0, failed: 0, noRecipients: 0 };
  const smsPacer = createPacer(Number(env.LEVEL5_SMS_MIN_INTERVAL_MS || SMS_MIN_INTERVAL_MS));

  for (const alert of alerts) {
    let afterId = 0;
    let totalSent = 0;
    let totalFailed = 0;
    let totalDeliveries = 0;
    let attemptedWork = false;

    while (true) {
      const subscribers = getActiveSubscriberBatch(db, env, { afterId, limit: subscriberBatchSize });
      if (!subscribers.length) {
        break;
      }
      afterId = subscribers.at(-1).id;

      const work = [];
      for (const subscriber of subscribers) {
        if (subscriber.email && !hasSentDelivery(db, alert.id, subscriber.id, 'email')) work.push({ subscriber, channel: 'email' });
        if (subscriber.phone && !hasSentDelivery(db, alert.id, subscriber.id, 'sms')) work.push({ subscriber, channel: 'sms' });
      }
      if (!work.length) {
        continue;
      }

      attemptedWork = true;
      const results = await mapWithConcurrency(work, EMAIL_CONCURRENCY, ({ subscriber, channel }) =>
        dispatchOne(db, env, alert, subscriber, channel, channel === 'sms' ? smsPacer : null),
      );
      const sent = results.filter((result) => result.ok).length;
      const failed = results.length - sent;
      totalDeliveries += results.length;
      totalSent += sent;
      totalFailed += failed;
      summary.deliveries += results.length;
      summary.sent += sent;
      summary.failed += failed;
    }

    if (!attemptedWork) {
      const reason = subscriberCount ? 'all_deliveries_already_sent' : 'no_active_subscribers';
      db.prepare(`
        UPDATE alert_events
        SET status = ?, dispatched_at = CURRENT_TIMESTAMP, dispatch_summary_json = ?
        WHERE id = ?
      `).run(subscriberCount ? 'sent' : 'no_recipients', JSON.stringify({ deliveries: 0, reason }), alert.id);
      if (!subscriberCount) {
        summary.noRecipients += 1;
      }
      continue;
    }

    db.prepare(`
      UPDATE alert_events
      SET status = ?, dispatched_at = CURRENT_TIMESTAMP, dispatch_summary_json = ?
      WHERE id = ?
    `).run(totalFailed === 0 ? 'sent' : totalSent > 0 ? 'partial' : 'failed', JSON.stringify({ deliveries: totalDeliveries, sent: totalSent, failed: totalFailed }), alert.id);
  }

  return summary;
}

module.exports = {
  HttpError,
  createSubscriberManagementPath,
  createSubscriberManagementUrl,
  countActiveSubscribers,
  dispatchPendingAlerts,
  getManagedSubscriber,
  listAlertEvents,
  listTakeoffEvents,
  normalizeEmail,
  normalizePhone,
  upsertSubscriber,
  updateManagedSubscriber,
};
