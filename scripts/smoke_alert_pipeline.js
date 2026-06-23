#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function execNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: ROOT_DIR, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, options = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < (options.timeoutMs || 10_000)) {
    try {
      const response = await fetch(url, options.fetchOptions);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.ok) {
        return { response, payload };
      }
      lastError = new Error(`${url} returned ${response.status}: ${text}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function initTempDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'takeoff_cluster',
    'warning',
    'global_business_jet',
    'smoke-alert-1',
    '2026-06-23T00:00:00.000Z',
    'Smoke alert',
    'Smoke alert message',
    JSON.stringify({ zScore: 4.2, takeoffCount: 7, concurrentCount: 13 }),
    'pending',
  );
  db.close();
}

function applyD1Migrations(db) {
  const migrationsDir = path.join(ROOT_DIR, 'migrations');
  for (const fileName of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, fileName), 'utf8'));
  }
}

function createD1Adapter(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...params) {
          return {
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: result.changes } };
            },
            async first() {
              return statement.get(...params) || null;
            },
            async all() {
              return { results: statement.all(...params) };
            },
          };
        },
        async run() {
          const result = statement.run();
          return { meta: { changes: result.changes } };
        },
        async first() {
          return statement.get() || null;
        },
        async all() {
          return { results: statement.all() };
        },
      };
    },
  };
}

async function assertClaimAlertRecordIsIdempotent() {
  const inserted = new Map();
  const env = {
    EWS_NOTIFY_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async run() {
                if (/INSERT OR IGNORE INTO notification_alerts/i.test(sql)) {
                  const [id, kind, source, level, slotKey, messageText, status, createdAt] = params;
                  if (inserted.has(id)) {
                    return { meta: { changes: 0 } };
                  }
                  inserted.set(id, { id, kind, source, level, slot_key: slotKey, message_text: messageText, status, created_at: createdAt });
                  return { meta: { changes: 1 } };
                }
                if (/UPDATE notification_alerts/i.test(sql) && /status = 'processing'/i.test(sql)) {
                  const [id, ...statuses] = params;
                  const existing = inserted.get(id);
                  if (!existing || !statuses.includes(existing.status)) {
                    return { meta: { changes: 0 } };
                  }
                  existing.status = 'processing';
                  return { meta: { changes: 1 } };
                }
                throw new Error(`Unexpected run SQL: ${sql}`);
              },
              async first() {
                return inserted.get(params[0]) || null;
              },
            };
          },
        };
      },
    },
  };
  fs.mkdirSync(path.join(ROOT_DIR, 'tmp'), { recursive: true });
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-functions-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{\"type\":\"module\"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions', '_lib'), path.join(moduleRoot, '_lib'), { recursive: true });
  const dbModuleUrl = pathToFileURL(path.join(moduleRoot, '_lib', 'db.js')).href;
  const { beginAlertRecordSend, claimAlertRecord, getAlertRecordById } = await import(dbModuleUrl);
  const details = {
    id: 'alert_event:smoke-idempotence',
    kind: 'takeoff_cluster',
    source: 'smoke',
    level: 4,
    slotKey: 'smoke-idempotence',
    messageText: 'Smoke idempotence alert',
  };
  const first = await claimAlertRecord(env, details);
  const second = await claimAlertRecord(env, details);
  const existing = await getAlertRecordById(env, details.id);
  assert(first.inserted === true, 'First alert record claim did not insert.');
  assert(second.inserted === false, 'Second alert record claim was not idempotent.');
  assert(existing?.id === details.id, 'Claimed alert record was not readable.');
  assert(existing?.status === 'created', 'Claimed alert record did not preserve the initial status.');
  const claimedCreated = await beginAlertRecordSend(env, details.id);
  assert(claimedCreated === true, 'Created alert record was not claimable for send.');
  assert(inserted.get(details.id)?.status === 'processing', 'Claimed alert record was not moved to processing.');
  const claimedProcessing = await beginAlertRecordSend(env, details.id);
  assert(claimedProcessing === false, 'Processing alert record was claimed twice.');
  inserted.get(details.id).status = 'completed_with_errors';
  const claimedRetry = await beginAlertRecordSend(env, details.id);
  assert(claimedRetry === true, 'Completed-with-errors alert record was not retry-claimable.');
}

async function assertPagesPipelineStatus(token) {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-pages-functions-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions'), path.join(moduleRoot, 'functions'), { recursive: true });
  const endpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'admin', 'pipeline-status.js')).href;
  const { onRequestGet } = await import(endpointUrl);
  const feedPayloads = new Map([
    ['/alerts.json', { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 'alert-1' }] }],
    ['/takeoffs.json', { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 'takeoff-1' }] }],
    ['/event-signals.json', { generatedAt: '2026-06-23T00:00:00.000Z', records: [{ id: 'signal-1' }] }],
  ]);
  const env = {
    INTERNAL_ALERT_TOKEN: token,
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_MESSAGING_PROFILE_ID: 'smoke-profile-id',
    TELNYX_PUBLIC_KEY: 'smoke-public-key',
    STRIPE_SECRET_KEY: 'smoke-stripe-key',
    STRIPE_PRICE_ID: 'price_smoke',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EWS_NOTIFY_DB: {
      prepare(sql) {
        return {
          async first() {
            if (/FROM notification_signups/i.test(sql)) {
              return {
                total: 3,
                active: 2,
                active_email: 2,
                active_sms: 1,
                pending_checkout: 1,
                past_due: 0,
                canceled: 0,
              };
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (/FROM notification_alerts/i.test(sql) && /GROUP BY status/i.test(sql)) {
              return { results: [{ status: 'sent', count: 2 }] };
            }
            if (/FROM notification_deliveries/i.test(sql) && /GROUP BY status/i.test(sql)) {
              return { results: [{ status: 'sent', count: 3 }] };
            }
            if (/FROM notification_deliveries/i.test(sql) && /GROUP BY channel, status/i.test(sql)) {
              return { results: [{ channel: 'sms', status: 'sent', count: 1 }] };
            }
            if (/FROM notification_alerts/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
              return { results: [{ id: 'alert_event:smoke', status: 'sent' }] };
            }
            throw new Error(`Unexpected all SQL: ${sql}`);
          },
        };
      },
    },
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (!feedPayloads.has(pathname)) {
          return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify(feedPayloads.get(pathname)), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      },
    },
  };

  const unauthorized = await onRequestGet({
    request: new Request('https://alerts.example.test/api/admin/pipeline-status'),
    env,
  });
  assert(unauthorized.status === 401, `Pages pipeline status without auth returned ${unauthorized.status}, not 401.`);

  const authorized = await onRequestGet({
    request: new Request('https://alerts.example.test/api/admin/pipeline-status', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  });
  const payload = await authorized.json();
  assert(authorized.status === 200, `Pages pipeline status returned ${authorized.status}: ${JSON.stringify(payload)}`);
  assert(payload.databaseBound === true, 'Pages pipeline status did not report the D1 binding.');
  assert(payload.alertEventBridgeAccepting === true, 'Pages pipeline status did not report bridge readiness.');
  assert(payload.notificationCryptoConfigured === true, 'Pages pipeline status did not report notification crypto as configured.');
  assert(payload.providerConfig.sendgridConfigured === true, 'Pages pipeline status did not report SendGrid as configured.');
  assert(payload.providerConfig.telnyxConfigured === true, 'Pages pipeline status did not report Telnyx as configured.');
  assert(payload.providerConfig.telnyxWebhookVerificationConfigured === true, 'Pages pipeline status did not report Telnyx webhook verification as configured.');
  assert(payload.providerConfig.telnyxDeliveryStatusConfigured === true, 'Pages pipeline status did not report Telnyx delivery status as configured.');
  assert(payload.providerConfig.stripeConfigured === true, 'Pages pipeline status did not report Stripe as configured.');
  assert(payload.feeds.alerts.itemCount === 1, 'Pages pipeline status did not summarize alerts.');
  assert(payload.feeds.takeoffs.itemCount === 1, 'Pages pipeline status did not summarize takeoffs.');
  assert(payload.feeds.eventSignals.itemCount === 1, 'Pages pipeline status did not summarize event signals.');
  assert(payload.notifications.subscribers.active === 2, 'Pages pipeline status did not summarize active subscribers.');
  assert(payload.notifications.alerts.statusCounts.sent === 2, 'Pages pipeline status did not summarize alert statuses.');

  feedPayloads.set('/alerts.json', { generatedAt: '2026-06-23T00:00:00.000Z' });
  const malformedFeedResponse = await onRequestGet({
    request: new Request('https://alerts.example.test/api/admin/pipeline-status', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  });
  const malformedFeedPayload = await malformedFeedResponse.json();
  assert(
    malformedFeedPayload.feeds.alerts.available === false,
    'Pages pipeline status accepted an alerts feed without an events array.',
  );
}

async function assertAlertEventEndpointFailureStatus(token) {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-pages-functions-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions'), path.join(moduleRoot, 'functions'), { recursive: true });
  const endpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'internal', 'alert-events.js')).href;
  const cryptoUrl = pathToFileURL(path.join(moduleRoot, 'functions', '_lib', 'crypto.js')).href;
  const { onRequestPost } = await import(endpointUrl);
  const { contactHash, encryptString } = await import(cryptoUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-d1-smoke-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  const env = {
    INTERNAL_ALERT_TOKEN: token,
    APP_BASE_URL: 'https://alerts.example.test',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    EWS_NOTIFY_DB: createD1Adapter(db),
  };
  const email = 'endpoint-failure@example.test';
  db.prepare(`
    INSERT INTO notification_signups (
      id,
      status,
      email_cipher,
      email_hash,
      wants_email,
      wants_sms,
      source,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sub-endpoint-failure',
    'active',
    await encryptString(env, email),
    await contactHash(env, 'email', email),
    1,
    0,
    'manual',
    '2026-06-23T00:00:00.000Z',
    '2026-06-23T00:00:00.000Z',
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.sendgrid.com')) {
      return new Response('sendgrid down', { status: 500 });
    }
    return originalFetch(url);
  };
  try {
    const response = await onRequestPost({
      request: new Request('https://alerts.example.test/api/internal/alert-events', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            eventKey: 'smoke-failing-event',
            kind: 'takeoff_anomaly',
            cohort: 'global_business_jet',
            title: 'Smoke failing event',
            message: 'Smoke failing event message',
            severity: 'high',
            level: 4,
            occurredAt: '2026-06-23T00:00:00.000Z',
          },
        }),
      }),
      env,
    });
    const payload = await response.json();
    assert(response.status === 502, `Alert event endpoint returned ${response.status}, not 502, for failed fanout.`);
    assert(payload.ok === false, 'Alert event endpoint did not report ok=false for failed fanout.');
    assert(payload.results?.[0]?.ok === false, 'Alert event endpoint did not preserve the failed fanout result.');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}


async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-alert-smoke-'));
  const publishedDir = path.join(tempRoot, 'published');
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const bridgeStatusPath = path.join(tempRoot, 'bridge-status.json');
  const token = 'alert-pipeline-smoke-token';
  initTempDb(dbPath);
  writeJson(path.join(publishedDir, 'alerts.json'), { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 1 }] });
  writeJson(path.join(publishedDir, 'takeoffs.json'), { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 1 }] });
  writeJson(path.join(publishedDir, 'event-signals.json'), { generatedAt: '2026-06-23T00:00:00.000Z', records: [{ id: 'signal-1' }] });
  writeJson(path.join(publishedDir, 'alert-bridge-status.json'), {
    schemaVersion: 1,
    checkedAt: '2026-06-23T00:00:00.000Z',
    ok: true,
    skipped: true,
    reason: 'smoke_seed',
    webhookConfigured: false,
  });

  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    EWS_DB_PATH: dbPath,
    EWS_PUBLISHED_DIR: publishedDir,
    EWS_CLIENT_DIST_DIR: path.join(ROOT_DIR, 'dist'),
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    INTERNAL_ALERT_TOKEN: token,
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_NUMBER: '+15555550123',
    TELEGRAM_BOT_TOKEN: 'smoke-telegram-token',
    TELEGRAM_CHANNEL: 'alerts-channel',
  };
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverExit = new Promise((resolve) => {
    server.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/health`, { timeoutMs: 20_000 });

    const signupResponse = await fetch(`${baseUrl}/api/notifications/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'smoke@example.com', wantsEmail: true }),
    });
    if (!signupResponse.ok) {
      throw new Error(`Signup failed with HTTP ${signupResponse.status}: ${await signupResponse.text()}`);
    }
    const signup = await signupResponse.json();
    assert(signup.managementPath, 'Signup did not return a management path.');

    const managePageUrl = new URL(signup.managementPath, baseUrl);
    const manageApiUrl = new URL('/api/manage/subscriber', baseUrl);
    manageApiUrl.search = managePageUrl.search;
    const manage = await waitForJson(manageApiUrl.toString());
    assert(manage.payload.subscriber.email === 'smoke@example.com', 'Management endpoint did not return the signed-up subscriber.');

    const unauthorizedStatus = await fetch(`${baseUrl}/api/admin/local-pipeline-status`);
    assert(unauthorizedStatus.status === 401, `Pipeline status without auth returned ${unauthorizedStatus.status}, not 401.`);
    const authorized = await waitForJson(`${baseUrl}/api/admin/local-pipeline-status`, {
      fetchOptions: { headers: { authorization: `Bearer ${token}` } },
    });
    assert(authorized.payload.localDispatch.activeSubscriberCount === 1, 'Pipeline status did not count the active subscriber.');
    assert(authorized.payload.feeds.eventSignals.itemCount === 1, 'Pipeline status did not summarize event signal records.');
    assert(authorized.payload.bridge.reason === 'smoke_seed', 'Pipeline status did not surface bridge health.');
    assert(authorized.payload.providerConfig.sendgridConfigured === true, 'Pipeline status did not report SendGrid as configured.');
    assert(authorized.payload.providerConfig.telnyxConfigured === true, 'Pipeline status did not report Telnyx as configured.');
    assert(authorized.payload.providerConfig.telegramConfigured === true, 'Pipeline status did not report Telegram as configured from TELEGRAM_CHANNEL.');
    assert(authorized.payload.notificationCryptoConfigured === true, 'Pipeline status did not report notification crypto as configured.');

    const eventSignals = await waitForJson(`${baseUrl}/api/event-signals`);
    assert(eventSignals.payload.records.length === 1, 'Event signals API did not return the published record.');
    const alertsFeed = await waitForJson(`${baseUrl}/alerts.json`);
    assert(alertsFeed.payload.events.length === 1, 'Alerts JSON route did not return the published event.');

    const bridgeRun = await execNode(
      ['scripts/bridge_alert_events.js', '--db', dbPath, '--limit', '1', '--url', '', '--status-path', bridgeStatusPath],
      { env: { ...process.env, EWS_ALERT_EVENTS_WEBHOOK_URL: '', INTERNAL_ALERT_TOKEN: token } },
    );
    const bridgeOutput = JSON.parse(bridgeRun.stdout.trim());
    const bridgeStatus = JSON.parse(fs.readFileSync(bridgeStatusPath, 'utf8'));
    assert(bridgeOutput.reason === 'missing_EWS_ALERT_EVENTS_WEBHOOK_URL', 'Bridge missing-url run did not report the expected reason.');
    assert(bridgeStatus.reason === bridgeOutput.reason, 'Bridge status file did not persist the latest result.');

    await assertPagesPipelineStatus(token);
    await assertClaimAlertRecordIsIdempotent();
    await assertAlertEventEndpointFailureStatus(token);
    console.log(JSON.stringify({ ok: true, baseUrl, tempRoot }));
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
    }
    const exit = await serverExit;
    if (exit.code !== 0 && exit.signal !== 'SIGTERM') {
      throw new Error(`Smoke server exited with ${exit.code || exit.signal}: ${serverOutput}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
