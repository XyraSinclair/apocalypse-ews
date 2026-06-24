#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const nodeCrypto = require('node:crypto');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(fn, expectedMessagePart) {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert(error, `Expected rejection containing: ${expectedMessagePart}`);
  assert(
    String(error.message || '').includes(expectedMessagePart),
    `Expected rejection containing "${expectedMessagePart}", got "${error.message}".`,
  );
}

function createSmokeVapidEnv() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicKeyBytes = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url'),
  ]);
  return {
    WEB_PUSH_VAPID_PUBLIC_KEY: publicKeyBytes.toString('base64url'),
    WEB_PUSH_VAPID_PRIVATE_KEY: privateJwk.d,
    WEB_PUSH_CONTACT: 'mailto:alerts@example.test',
  };
}

async function createSmokePushSubscription(endpoint = 'https://push.example.test/send/smoke') {
  const keyPair = await nodeCrypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await nodeCrypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    endpoint,
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: nodeCrypto.randomBytes(16).toString('base64url'),
    },
  };
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

function assertDeployEnvFileLoading(tempRoot) {
  const {
    getEnvWithDotEnv,
    validateDeployEnv,
    validateMaintenanceWranglerConfig,
  } = require('./_deploy_env');
  const envPath = path.join(tempRoot, 'deploy.env');
  const vapidEnv = createSmokeVapidEnv();
  fs.writeFileSync(envPath, [
    'CLOUDFLARE_API_TOKEN=smoke-cloudflare-token',
    'INTERNAL_ALERT_TOKEN=smoke-internal-token',
    'EWS_PUBLIC_URL=https://alerts.example.test/',
    'EWS_ALERT_EVENTS_WEBHOOK_URL=https://alerts.example.test/api/internal/alert-events',
    'EWS_SMOKE_TEST_EMAIL=smoke@example.test',
    'EWS_SMOKE_TEST_PHONE=+14155552671',
    'SENDGRID_API_KEY=smoke-sendgrid-key',
    'SENDGRID_FROM_EMAIL=alerts@example.test',
    'TELNYX_API_KEY=smoke-telnyx-key',
    'TELNYX_PUBLIC_KEY=smoke-telnyx-public-key',
    'TELNYX_NUMBER=+14155552671',
    'SENDGRID_WEBHOOK_PUBLIC_KEY=smoke-sendgrid-webhook-public-key',
    'SENDGRID_WEBHOOK_URL=https://alerts.example.test/api/sendgrid/webhook',
    'VITE_DASHBOARD_URL=https://alerts.example.test/dashboard.json',
    'VITE_MILITARY_DASHBOARD_URL=https://alerts.example.test/military-dashboard.json',
    'VITE_UNTRACKED_DASHBOARD_URL=https://alerts.example.test/untracked-dashboard.json',
    'NOTIFICATION_HASH_SECRET=smoke-hash-secret',
    `NOTIFICATION_ENCRYPTION_KEY=${Buffer.alloc(32, 11).toString('base64')}`,
    `WEB_PUSH_VAPID_PUBLIC_KEY=${vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${vapidEnv.WEB_PUSH_VAPID_PRIVATE_KEY}`,
    `WEB_PUSH_CONTACT=${vapidEnv.WEB_PUSH_CONTACT}`,
    'STRIPE_SECRET_KEY=sk_test_smoke',
    'STRIPE_WEBHOOK_SECRET=whsec_smoke',
    'STRIPE_PRICE_ID=price_smoke',
    '',
  ].join('\n'));

  const env = getEnvWithDotEnv({}, { envFiles: [envPath] });
  assert(env.CLOUDFLARE_API_TOKEN === 'smoke-cloudflare-token', 'Deploy env loader did not read the explicit env file.');
  assert(validateDeployEnv(env).length === 0, 'Deploy env validation rejected the explicit env file.');
  const {
    SENDGRID_WEBHOOK_URL: _explicitSendGridWebhookUrl,
    EWS_ALERT_EVENTS_WEBHOOK_URL: _explicitAlertEventsWebhookUrl,
    ...withoutExplicitWebhookUrls
  } = env;
  const derivedEnv = getEnvWithDotEnv(withoutExplicitWebhookUrls, { envFiles: [] });
  assert(
    derivedEnv.SENDGRID_WEBHOOK_URL === 'https://alerts.example.test/api/sendgrid/webhook',
    'Deploy env loader did not derive the SendGrid webhook URL from EWS_PUBLIC_URL.',
  );
  assert(
    derivedEnv.EWS_ALERT_EVENTS_WEBHOOK_URL === 'https://alerts.example.test/api/internal/alert-events',
    'Deploy env loader did not derive the alert event bridge URL from EWS_PUBLIC_URL.',
  );
  assert(validateDeployEnv(derivedEnv).length === 0, 'Deploy env validation rejected derived webhook URLs.');
  assert(validateMaintenanceWranglerConfig().ok, 'Maintenance wrangler config is not deploy-ready.');
}

function assertDeploySecretCoverage() {
  const {
    MAINTENANCE_WORKER_SECRET_NAMES,
    PAGES_FUNCTION_SECRET_NAMES,
    getPagesPipelineSmokeArgs,
  } = require('./deploy_pages');
  const requiredMaintenanceSecrets = [
    'NOTIFICATION_HASH_SECRET',
    'NOTIFICATION_ENCRYPTION_KEY',
    'WEB_PUSH_VAPID_PUBLIC_KEY',
    'WEB_PUSH_VAPID_PRIVATE_KEY',
    'WEB_PUSH_CONTACT',
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'TELNYX_API_KEY',
  ];
  const requiredPagesSecrets = [
    'INTERNAL_ALERT_TOKEN',
    'NOTIFICATION_HASH_SECRET',
    'NOTIFICATION_ENCRYPTION_KEY',
    'WEB_PUSH_VAPID_PUBLIC_KEY',
    'WEB_PUSH_VAPID_PRIVATE_KEY',
    'WEB_PUSH_CONTACT',
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'SENDGRID_WEBHOOK_PUBLIC_KEY',
    'SENDGRID_WEBHOOK_URL',
    'TELNYX_API_KEY',
    'TELNYX_PUBLIC_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_ID',
  ];
  assert(
    new Set(MAINTENANCE_WORKER_SECRET_NAMES).size === MAINTENANCE_WORKER_SECRET_NAMES.length,
    'Maintenance worker secret list contains duplicate names.',
  );
  assert(
    new Set(PAGES_FUNCTION_SECRET_NAMES).size === PAGES_FUNCTION_SECRET_NAMES.length,
    'Pages function secret list contains duplicate names.',
  );
  for (const name of requiredMaintenanceSecrets) {
    assert(MAINTENANCE_WORKER_SECRET_NAMES.includes(name), `Maintenance worker deploy does not configure ${name}.`);
  }
  for (const name of requiredPagesSecrets) {
    assert(PAGES_FUNCTION_SECRET_NAMES.includes(name), `Pages deploy does not configure ${name}.`);
  }
  const smokeArgs = getPagesPipelineSmokeArgs('https://alerts.example.test');
  assert(smokeArgs.includes('--require-providers'), 'Pages deploy smoke does not require configured providers.');
  assert(smokeArgs.includes('--require-test-delivery'), 'Pages deploy smoke does not require provider delivery evidence.');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function assertPagesPipelineSmokeScript(token) {
  const port = await freePort();
  const targetUrl = `http://127.0.0.1:${port}`;
  let testAlertPosts = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, targetUrl);
    if (url.pathname === '/api/admin/pipeline-status') {
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        publicUrlConfigured: true,
        databaseBound: true,
        alertEventBridgeAccepting: true,
        providerConfig: {
          sendgridConfigured: true,
          sendgridWebhookVerificationConfigured: true,
          sendgridDeliveryStatusConfigured: true,
          telnyxConfigured: true,
          telnyxWebhookVerificationConfigured: true,
          telnyxDeliveryStatusConfigured: true,
          webPushConfigured: true,
          stripeConfigured: true,
        },
        feeds: {
          alerts: { available: true },
          takeoffs: { available: true },
          eventSignals: { available: true },
        },
        notifications: {
          available: true,
          subscribers: {
            active: 2,
            activeEmail: 1,
            activeSms: 1,
            activePush: 1,
          },
        },
      });
      return;
    }
    if (url.pathname === '/api/admin/test-alert' && request.method === 'POST') {
      testAlertPosts += 1;
      sendJson(response, 200, {
        ok: true,
        sent: true,
        alertId: 'smoke-admin-test',
        emailSentCount: 1,
        smsSentCount: 1,
        errorCount: 0,
      });
      return;
    }
    if (url.pathname === '/api/admin/test-alert' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        deliveries: [
          {
            alert_id: 'smoke-admin-test',
            channel: 'email',
            delivery_status: 'sent',
            provider_message_id: 'sg-smoke-message',
            provider_status: 'processed',
            delivery_created_at: '2026-06-23T00:00:00.000Z',
            delivery_updated_at: '2026-06-23T00:00:05.000Z',
          },
          {
            alert_id: 'smoke-admin-test',
            channel: 'sms',
            delivery_status: 'delivered',
            provider_message_id: 'telnyx-smoke-message',
            provider_status: 'delivered',
            delivery_created_at: '2026-06-23T00:00:00.000Z',
            delivery_updated_at: '2026-06-23T00:00:05.000Z',
          },
        ],
      });
      return;
    }
    if (url.pathname === '/api/alerts') {
      sendJson(response, 200, { events: [{ id: 'alert-smoke' }] });
      return;
    }
    if (url.pathname === '/api/takeoffs') {
      sendJson(response, 200, { events: [{ id: 'takeoff-smoke' }] });
      return;
    }
    if (url.pathname === '/api/event-signals') {
      sendJson(response, 200, { records: [{ id: 'signal-smoke' }] });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const run = await execNode(
      [
        'scripts/smoke_pages_pipeline.js',
        targetUrl,
        '--require-providers',
        '--require-test-delivery',
        '--test-email',
        'smoke@example.test',
        '--test-phone',
        '+14155552671',
      ],
      { env: { ...process.env, INTERNAL_ALERT_TOKEN: token, EWS_SMOKE_TEST_EMAIL: '', EWS_SMOKE_TEST_PHONE: '' } },
    );
    const payload = JSON.parse(run.stdout.trim());
    assert(payload.requireProviders === true, 'Pages smoke script did not record provider requirement.');
    assert(payload.requireTestDelivery === true, 'Pages smoke script did not record test-delivery requirement.');
    assert(payload.testDelivery?.emailSentCount === 1, 'Pages smoke script did not verify the test email delivery.');
    assert(payload.testDelivery?.smsSentCount === 1, 'Pages smoke script did not verify the test SMS delivery.');
    assert(payload.testDelivery?.evidence === 'provider_webhook_status', 'Pages smoke script did not require provider webhook status evidence.');
    assert(payload.testDelivery?.webhookDeliveryCount === 2, 'Pages smoke script did not verify both provider webhook statuses.');
    assert(testAlertPosts === 1, 'Pages smoke script did not call the admin test-alert endpoint exactly once.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
                  const [id, kind, source, level, slotKey, messageText, subject, smsMessageText, status, fanoutLeaseToken, fanoutLeaseExpiresAt, createdAt] = params;
                  if (inserted.has(id)) {
                    return { meta: { changes: 0 } };
                  }
                  inserted.set(id, { id, kind, source, level, slot_key: slotKey, message_text: messageText, subject, sms_message_text: smsMessageText, status, fanout_lease_token: fanoutLeaseToken, fanout_lease_expires_at: fanoutLeaseExpiresAt, created_at: createdAt });
                  return { meta: { changes: 1 } };
                }
                if (/UPDATE notification_alerts/i.test(sql) && /status = 'processing'/i.test(sql)) {
                  const [fanoutLeaseToken, fanoutLeaseExpiresAt, id, ...statuses] = params;
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

async function assertAlertProcessingStaleReclaim() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-functions-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{\"type\":\"module\"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions', '_lib'), path.join(moduleRoot, '_lib'), { recursive: true });
  const dbModuleUrl = pathToFileURL(path.join(moduleRoot, '_lib', 'db.js')).href;
  const { beginAlertRecordSend } = await import(dbModuleUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-stale-alert-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  db.prepare(`
    INSERT INTO notification_alerts (
      id,
      kind,
      source,
      message_text,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'alert-stale-processing',
    'takeoff_rate_anomaly',
    'smoke',
    'Stale processing alert',
    'processing',
    '2026-06-23T00:00:00.000Z',
    '2026-06-23T00:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO notification_alerts (
      id,
      kind,
      source,
      message_text,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'alert-fresh-processing',
    'takeoff_rate_anomaly',
    'smoke',
    'Fresh processing alert',
    'processing',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.prepare(`
    INSERT INTO notification_alerts (
      id,
      kind,
      source,
      message_text,
      status,
      fanout_lease_token,
      fanout_lease_expires_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'alert-active-lease-processing',
    'takeoff_rate_anomaly',
    'smoke',
    'Active lease processing alert',
    'processing',
    'active-lease-token',
    new Date(Date.now() + 600_000).toISOString(),
    '2026-06-23T00:00:00.000Z',
    '2026-06-23T00:00:00.000Z',
  );
  const env = { EWS_NOTIFY_DB: createD1Adapter(db) };
  assert(
    await beginAlertRecordSend(env, 'alert-stale-processing', { statuses: ['processing'], staleMs: 60_000 }),
    'Stale processing alert was not reclaimable.',
  );
  assert(
    !(await beginAlertRecordSend(env, 'alert-active-lease-processing', {
      statuses: ['processing'],
      staleMs: 60_000,
      fanoutLeaseToken: 'replacement-lease-token',
      fanoutLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    'Processing alert with an active fanout lease was incorrectly reclaimable.',
  );
  const activeLease = db.prepare('SELECT fanout_lease_token FROM notification_alerts WHERE id = ?').get('alert-active-lease-processing');
  assert(activeLease.fanout_lease_token === 'active-lease-token', 'Active fanout lease token was overwritten.');
  assert(
    !(await beginAlertRecordSend(env, 'alert-fresh-processing', { statuses: ['processing'], staleMs: 60_000 })),
    'Fresh processing alert was incorrectly reclaimable.',
  );
  db.close();
}

async function assertLocalDispatchSkipsRawTakeoffTelemetry() {
  const { dispatchPendingAlerts, upsertSubscriber } = require(path.join(ROOT_DIR, 'server', 'local-notifications'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-local-dispatch-')), 'ews.sqlite');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const env = {
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
  };
  upsertSubscriber(db, { email: 'fanout@example.test', wantsEmail: true }, env);
  const insertAlert = db.prepare(`
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
  `);
  insertAlert.run(
    'takeoff_batch',
    'watch',
    'global_business_jet',
    'local-dispatch-batch',
    '2026-06-23T00:00:00.000Z',
    'Raw takeoff batch',
    'Raw takeoff batch message',
    JSON.stringify({ signalFamily: 'takeoff_batch' }),
    'pending',
  );
  insertAlert.run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    'local-dispatch-rate',
    '2026-06-23T00:01:00.000Z',
    'Takeoff-rate anomaly',
    'Takeoff-rate anomaly message',
    JSON.stringify({ signalFamily: 'takeoff_rate' }),
    'pending',
  );
  insertAlert.run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    'local-dispatch-active-processing',
    '2026-06-23T00:02:00.000Z',
    'Active processing takeoff-rate anomaly',
    'Active processing takeoff-rate anomaly message',
    JSON.stringify({ signalFamily: 'takeoff_rate' }),
    'processing',
  );
  db.prepare("UPDATE alert_events SET dispatched_at = CURRENT_TIMESTAMP WHERE event_key = 'local-dispatch-active-processing'").run();

  const originalFetch = globalThis.fetch;
  const providerRequests = [];
  globalThis.fetch = async (url, options) => {
    providerRequests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('', { status: 202, headers: { 'x-message-id': 'local-dispatch-smoke' } });
  };
  try {
    const summary = await dispatchPendingAlerts(db, env, { limit: 10 });
    assert(summary.alerts === 1, 'Local dispatch did not limit work to alertable events.');
    assert(providerRequests.length === 1, 'Local dispatch sent raw telemetry or skipped the alertable anomaly.');
    const statuses = db.prepare('SELECT kind, event_key, status FROM alert_events ORDER BY kind ASC, event_key ASC').all();
    const rawBatch = statuses.find((event) => event.event_key === 'local-dispatch-batch');
    const rateAnomaly = statuses.find((event) => event.event_key === 'local-dispatch-rate');
    const activeProcessing = statuses.find((event) => event.event_key === 'local-dispatch-active-processing');
    assert(rawBatch?.status === 'observed', 'Local dispatch did not demote raw takeoff batch telemetry.');
    assert(rateAnomaly?.status === 'sent', 'Local dispatch did not send the alertable takeoff-rate anomaly.');
    assert(activeProcessing?.status === 'processing', 'Local dispatch reclaimed an active processing alert without a stale lease.');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}

async function assertResumableAlertFanout() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-functions-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{\"type\":\"module\"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions', '_lib'), path.join(moduleRoot, '_lib'), { recursive: true });
  const notificationsModuleUrl = pathToFileURL(path.join(moduleRoot, '_lib', 'notifications.js')).href;
  const cryptoModuleUrl = pathToFileURL(path.join(moduleRoot, '_lib', 'crypto.js')).href;
  const { continueAlertFanoutBatch, sendAlertEventNotifications } = await import(notificationsModuleUrl);
  const { contactHash, encryptString } = await import(cryptoModuleUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-resumable-alert-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  const env = {
    APP_BASE_URL: 'https://alerts.example.test',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'),
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    LEVEL5_SUBSCRIBER_BATCH_SIZE: '500',
    LEVEL5_SMS_BATCH_WINDOW_MS: '500',
    LEVEL5_SMS_MIN_INTERVAL_MS: '250',
    ALERT_EVENT_MAX_BATCHES_PER_INVOCATION: '1',
    ALERT_FANOUT_LEASE_MS: '1800000',
    LEVEL5_NOTIFICATION_CONCURRENCY: '4',
    EWS_NOTIFY_DB: createD1Adapter(db),
  };
  const insertSubscriber = db.prepare(`
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
  `);
  for (let index = 0; index < 3; index += 1) {
    const email = `fanout-${index}@example.test`;
    insertSubscriber.run(
      `sub-fanout-${index}`,
      'active',
      await encryptString(env, email),
      await contactHash(env, 'email', email),
      1,
      0,
      'manual',
      `2026-06-23T00:0${index}:00.000Z`,
      `2026-06-23T00:0${index}:00.000Z`,
    );
  }

  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.sendgrid.com')) {
      sendCount += 1;
      return new Response('', {
        status: 202,
        headers: {
          'x-message-id': `fanout-message-${sendCount}`,
        },
      });
    }
    return originalFetch(url);
  };
  try {
    const first = await sendAlertEventNotifications(env, {
      eventKey: 'resumable-fanout-smoke',
      kind: 'takeoff_rate_anomaly',
      cohort: 'global_business_jet',
      title: 'Resumable fanout smoke',
      message: 'Resumable fanout smoke message',
      severity: 'high',
      level: 4,
      occurredAt: '2026-06-23T00:00:00.000Z',
    });
    assert(first.status === 'processing' && first.queued === true, 'Initial resumable fanout did not leave the alert queued.');
    assert(first.emailSentCount === 2, 'Initial resumable fanout did not send exactly one bounded batch.');
    assert(first.batchSize === 2, 'Initial resumable fanout did not cap the oversized batch to the paced SMS window.');
    assert(first.smsBatchWindowMs === 500, 'Initial resumable fanout did not report the paced SMS batch window.');
    assert(sendCount === 2, 'Initial resumable fanout sent the wrong number of provider requests.');
    const afterFirst = db.prepare('SELECT status, subscriber_count, email_sent_count, fanout_after_id, fanout_lease_token, fanout_lease_expires_at FROM notification_alerts WHERE id = ?').get('alert_event:resumable-fanout-smoke');
    assert(afterFirst.status === 'processing', 'Bounded fanout did not persist processing status.');
    assert(afterFirst.subscriber_count === 2 && afterFirst.email_sent_count === 2, 'Bounded fanout did not persist first-batch counts.');
    assert(afterFirst.fanout_after_id === 'sub-fanout-1', 'Bounded fanout did not persist the subscriber cursor.');
    assert(afterFirst.fanout_lease_token === null && afterFirst.fanout_lease_expires_at === null, 'Bounded fanout did not release its lease for the maintenance worker.');

    const continued = await continueAlertFanoutBatch(env, { limit: 5 });
    assert(continued.processed === 1, 'Fanout continuation did not process the queued alert.');
    assert(continued.results?.[0]?.status === 'sent', 'Fanout continuation did not complete the queued alert.');
    assert(sendCount === 3, 'Fanout continuation sent the wrong number of provider requests.');
    const afterContinue = db.prepare('SELECT status, subscriber_count, email_sent_count, fanout_after_id, fanout_completed_at, fanout_lease_token, fanout_lease_expires_at FROM notification_alerts WHERE id = ?').get('alert_event:resumable-fanout-smoke');
    assert(afterContinue.status === 'sent', 'Fanout continuation did not persist sent status.');
    assert(afterContinue.subscriber_count === 3 && afterContinue.email_sent_count === 3, 'Fanout continuation did not persist cumulative counts.');
    assert(afterContinue.fanout_after_id === '', 'Fanout continuation did not clear the cursor after completion.');
    assert(afterContinue.fanout_completed_at, 'Fanout continuation did not persist a completion timestamp.');
    assert(afterContinue.fanout_lease_token === null && afterContinue.fanout_lease_expires_at === null, 'Fanout continuation did not clear its lease after completion.');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
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
  const vapidEnv = createSmokeVapidEnv();
  const env = {
    INTERNAL_ALERT_TOKEN: token,
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    SENDGRID_WEBHOOK_PUBLIC_KEY: 'smoke-sendgrid-webhook-public-key',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_MESSAGING_PROFILE_ID: 'smoke-profile-id',
    TELNYX_PUBLIC_KEY: 'smoke-public-key',
    STRIPE_SECRET_KEY: 'smoke-stripe-key',
    STRIPE_PRICE_ID: 'price_smoke',
    STRIPE_WEBHOOK_SECRET: 'whsec_smoke',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    WEB_PUSH_VAPID_PUBLIC_KEY: vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: vapidEnv.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_CONTACT: vapidEnv.WEB_PUSH_CONTACT,
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
                active_push: 1,
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
  assert(payload.ok === true, `Pages pipeline status did not derive ok=true: ${JSON.stringify(payload.readiness?.failures || [])}`);
  assert(Array.isArray(payload.readiness?.failures) && payload.readiness.failures.length === 0, 'Pages pipeline status reported readiness failures.');
  assert(payload.databaseBound === true, 'Pages pipeline status did not report the D1 binding.');
  assert(payload.alertEventBridgeAccepting === true, 'Pages pipeline status did not report bridge readiness.');
  assert(payload.notificationCryptoConfigured === true, 'Pages pipeline status did not report notification crypto as configured.');
  assert(payload.providerConfig.sendgridConfigured === true, 'Pages pipeline status did not report SendGrid as configured.');
  assert(payload.providerConfig.sendgridWebhookVerificationConfigured === true, 'Pages pipeline status did not report SendGrid webhook verification as configured.');
  assert(payload.providerConfig.sendgridDeliveryStatusConfigured === true, 'Pages pipeline status did not report SendGrid delivery status as configured.');
  assert(payload.providerConfig.telnyxConfigured === true, 'Pages pipeline status did not report Telnyx as configured.');
  assert(payload.providerConfig.telnyxWebhookVerificationConfigured === true, 'Pages pipeline status did not report Telnyx webhook verification as configured.');
  assert(payload.providerConfig.telnyxDeliveryStatusConfigured === true, 'Pages pipeline status did not report Telnyx delivery status as configured.');
  assert(payload.providerConfig.webPushConfigured === true, 'Pages pipeline status did not report browser push as configured.');
  assert(payload.providerConfig.stripeConfigured === true, 'Pages pipeline status did not report Stripe as configured.');
  assert(payload.feeds.alerts.itemCount === 1, 'Pages pipeline status did not summarize alerts.');
  assert(payload.feeds.takeoffs.itemCount === 1, 'Pages pipeline status did not summarize takeoffs.');
  assert(payload.feeds.eventSignals.itemCount === 1, 'Pages pipeline status did not summarize event signals.');
  assert(payload.notifications.subscribers.active === 2, 'Pages pipeline status did not summarize active subscribers.');
  assert(payload.notifications.subscribers.activePush === 1, 'Pages pipeline status did not summarize active browser push subscribers.');
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
  assert(malformedFeedPayload.ok === false, 'Pages pipeline status did not derive ok=false for a malformed alerts feed.');
  assert(
    malformedFeedPayload.readiness?.failures?.includes('alerts_feed_empty_or_unavailable'),
    'Pages pipeline status did not identify the malformed alerts feed readiness failure.',
  );

  feedPayloads.set('/alerts.json', { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 'alert-1' }] });
  const stripeMissingResponse = await onRequestGet({
    request: new Request('https://alerts.example.test/api/admin/pipeline-status', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env: { ...env, STRIPE_WEBHOOK_SECRET: '' },
  });
  const stripeMissingPayload = await stripeMissingResponse.json();
  assert(stripeMissingPayload.ok === false, 'Pages pipeline status accepted missing Stripe webhook configuration.');
  assert(
    stripeMissingPayload.readiness?.failures?.includes('stripe_not_configured'),
    'Pages pipeline status did not identify missing Stripe readiness.',
  );
}

async function assertManualSubscriberValidation() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-manual-subscriber-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions', '_lib'), path.join(moduleRoot, '_lib'), { recursive: true });
  const dbModuleUrl = pathToFileURL(path.join(moduleRoot, '_lib', 'db.js')).href;
  const { createManualSubscriber } = await import(dbModuleUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-manual-subscriber-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  const env = {
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    EWS_NOTIFY_DB: createD1Adapter(db),
  };

  await assertRejects(
    () => createManualSubscriber(env, { accountEmail: 'ops@example.test' }),
    'Enable at least one alert channel',
  );
  await assertRejects(
    () =>
      createManualSubscriber(env, {
        accountEmail: 'ops@example.test',
        wantsSms: true,
        phone: '+442071838750',
        smsConsent: true,
      }),
    'SMS alerts are currently available for US and Canada numbers',
  );

  const emailSubscriber = await createManualSubscriber(env, {
    accountEmail: 'ops-email@example.test',
    wantsEmail: true,
    email: 'alerts-email@example.test',
  });
  const smsSubscriber = await createManualSubscriber(
    env,
    {
      accountEmail: 'ops-sms@example.test',
      wantsSms: true,
      phone: '+14155552671',
      smsConsent: true,
    },
    { ip: '127.0.0.1', userAgent: 'smoke' },
  );
  assert(emailSubscriber.wantsEmail === true && emailSubscriber.wantsSms === false, 'Manual email subscriber enabled the wrong channels.');
  assert(smsSubscriber.wantsEmail === false && smsSubscriber.wantsSms === true, 'Manual SMS subscriber enabled the wrong channels.');
  db.close();
}

async function assertPublicNotificationSignupEndpoint() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-public-signup-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions'), path.join(moduleRoot, 'functions'), { recursive: true });
  const endpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'notifications', 'signup.js')).href;
  const { onRequestPost } = await import(endpointUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-public-signup-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  const env = {
    APP_BASE_URL: 'https://alerts.example.test',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    SENDGRID_API_KEY: 'smoke-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'alerts@example.test',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_NUMBER: '+14155552671',
    EWS_NOTIFY_DB: createD1Adapter(db),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === 'https://api.sendgrid.com/v3/mail/send') {
      return new Response('', {
        status: 202,
        headers: { 'x-message-id': 'sendgrid-public-signup-smoke' },
      });
    }
    if (href === 'https://api.telnyx.com/v2/messages') {
      return new Response(JSON.stringify({ data: { id: 'telnyx-public-signup-smoke', to: [{ status: 'queued' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return originalFetch(url, options);
  };

  try {
    const noConsentResponse = await onRequestPost({
      request: new Request('https://alerts.example.test/api/notifications/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+14155552671' }),
      }),
      env,
    });
    const noConsentPayload = await noConsentResponse.json();
    assert(noConsentResponse.status === 400, `Public signup without SMS consent returned ${noConsentResponse.status}.`);
    assert(/SMS consent/.test(noConsentPayload.error || ''), 'Public signup did not reject SMS without consent.');

    const signupResponse = await onRequestPost({
      request: new Request('https://alerts.example.test/api/notifications/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'public@example.test', phone: '+14155552671', smsConsent: true }),
      }),
      env,
    });
    const signupPayload = await signupResponse.json();
    assert(signupResponse.status === 200, `Public signup returned ${signupResponse.status}: ${JSON.stringify(signupPayload)}`);
    assert(signupPayload.ok === true, 'Public signup did not report ok=true.');
    assert(signupPayload.emailEnabled === true && signupPayload.smsEnabled === true, 'Public signup did not enable email and SMS.');
    assert(signupPayload.managementPath === null, 'Public signup leaked an account management capability link.');
    assert(signupPayload.signupConfirmation?.emailSentCount === 1, 'Public signup did not send a confirmation email.');
    assert(signupPayload.signupConfirmation?.smsSentCount === 1, 'Public signup did not send a confirmation SMS.');

    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'active' AND wants_email = 1 AND email_hash IS NOT NULL THEN 1 ELSE 0 END) AS active_email,
        SUM(CASE WHEN status = 'active' AND wants_sms = 1 AND phone_hash IS NOT NULL THEN 1 ELSE 0 END) AS active_sms
      FROM notification_signups
    `).get();
    assert(summary.active === 1 && summary.active_email === 1 && summary.active_sms === 1, 'Public signup did not create one active email/SMS subscriber.');

    const duplicateResponse = await onRequestPost({
      request: new Request('https://alerts.example.test/api/notifications/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'public@example.test', phone: '+14155552671', smsConsent: true }),
      }),
      env,
    });
    assert(duplicateResponse.status === 409, `Duplicate public signup returned ${duplicateResponse.status}, not 409.`);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}


async function assertSendGridWebhookDeliveryStatus() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-sendgrid-webhook-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions'), path.join(moduleRoot, 'functions'), { recursive: true });
  const endpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'sendgrid', 'webhook.js')).href;
  const { onRequestPost } = await import(endpointUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-sendgrid-webhook-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  db.prepare(`
    INSERT INTO notification_alerts (
      id,
      kind,
      source,
      message_text,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'alert-sendgrid-webhook',
    'takeoff_cluster',
    'smoke',
    'SendGrid webhook smoke',
    'sent',
    '2026-06-23T00:00:00.000Z',
    '2026-06-23T00:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO notification_deliveries (
      id,
      alert_id,
      channel,
      destination_hash,
      status,
      provider_message_id,
      provider_status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'delivery-sendgrid-webhook',
    'alert-sendgrid-webhook',
    'email',
    'hash-email-sendgrid-webhook',
    'sent',
    'sendgrid-message-id',
    'processed',
    '2026-06-23T00:00:00.000Z',
    '2026-06-23T00:00:00.000Z',
  );

  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify([
    {
      event: 'delivered',
      sg_event_id: 'sendgrid-event-id',
      sg_message_id: 'sendgrid-message-id.filter0001.123.456.0',
      response: '250 OK',
    },
  ]);
  const signature = nodeCrypto
    .sign('sha256', Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), privateKey)
    .toString('base64');
  const response = await onRequestPost({
    request: new Request('https://alerts.example.test/api/sendgrid/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-email-event-webhook-signature': signature,
        'x-twilio-email-event-webhook-timestamp': timestamp,
      },
      body: rawBody,
    }),
    env: {
      SENDGRID_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
      EWS_NOTIFY_DB: createD1Adapter(db),
    },
  });
  const payload = await response.json();
  assert(response.status === 200, `SendGrid webhook returned ${response.status}: ${JSON.stringify(payload)}`);
  assert(payload.results?.[0]?.updated === true, 'SendGrid webhook did not update the matching delivery.');
  const delivery = db.prepare('SELECT status, provider_status FROM notification_deliveries WHERE id = ?').get('delivery-sendgrid-webhook');
  assert(delivery.status === 'delivered', 'SendGrid webhook did not record delivered status.');
  assert(delivery.provider_status === 'delivered', 'SendGrid webhook did not record provider status.');
  const staleTimestamp = String(Math.floor(Date.now() / 1000) + 1);
  const staleRawBody = JSON.stringify([
    {
      event: 'processed',
      sg_event_id: 'sendgrid-stale-event-id',
      sg_message_id: 'sendgrid-message-id.filter0002.123.456.0',
      response: 'queued',
    },
  ]);
  const staleSignature = nodeCrypto
    .sign('sha256', Buffer.concat([Buffer.from(staleTimestamp), Buffer.from(staleRawBody)]), privateKey)
    .toString('base64');
  const staleResponse = await onRequestPost({
    request: new Request('https://alerts.example.test/api/sendgrid/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-email-event-webhook-signature': staleSignature,
        'x-twilio-email-event-webhook-timestamp': staleTimestamp,
      },
      body: staleRawBody,
    }),
    env: {
      SENDGRID_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
      EWS_NOTIFY_DB: createD1Adapter(db),
    },
  });
  const stalePayload = await staleResponse.json();
  assert(staleResponse.status === 200, `Stale SendGrid webhook returned ${staleResponse.status}: ${JSON.stringify(stalePayload)}`);
  assert(stalePayload.results?.[0]?.updated === false, 'Stale SendGrid webhook incorrectly reported a delivery update.');
  assert(stalePayload.results?.[0]?.ignoredStale === true, 'Stale SendGrid webhook did not mark the lower-precedence status as stale.');
  assert(stalePayload.results?.[0]?.previousStatus === 'delivered', 'Stale SendGrid webhook did not report the previous terminal status.');
  const staleDelivery = db.prepare('SELECT status, provider_status FROM notification_deliveries WHERE id = ?').get('delivery-sendgrid-webhook');
  assert(staleDelivery.status === 'delivered', 'Stale SendGrid webhook downgraded a delivered email.');
  assert(staleDelivery.provider_status === 'delivered', 'Stale SendGrid webhook changed the terminal provider status.');
  db.close();
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
    const skipResponse = await onRequestPost({
      request: new Request('https://alerts.example.test/api/internal/alert-events', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            eventKey: 'smoke-raw-takeoff-batch',
            kind: 'takeoff_batch',
            cohort: 'global_business_jet',
            title: 'Raw takeoff telemetry',
            message: 'Raw takeoff telemetry message',
            severity: 'watch',
            level: 1,
            occurredAt: '2026-06-23T00:00:00.000Z',
          },
        }),
      }),
      env,
    });
    const skipPayload = await skipResponse.json();
    assert(skipResponse.status === 200, `Non-alertable event returned ${skipResponse.status}: ${JSON.stringify(skipPayload)}`);
    assert(skipPayload.ok === true, 'Non-alertable event did not return ok=true.');
    assert(skipPayload.results?.[0]?.reason === 'non_alertable_event_kind', 'Non-alertable event was not skipped before fanout.');
    const rawAlertCount = db.prepare("SELECT COUNT(*) AS count FROM notification_alerts WHERE kind = 'takeoff_batch'").get().count;
    assert(rawAlertCount === 0, 'Non-alertable raw telemetry created a notification alert record.');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}

async function assertTakeoffRateDetection() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-takeoff-rate-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAtMs = Date.UTC(2026, 5, 23, 12, 0, 0);
  const observedAt = new Date(observedAtMs).toISOString();
  const halfHourMs = 30 * 60 * 1000;
  const insertMetric = db.prepare('INSERT INTO concurrent_metrics (sampled_at, concurrent_count) VALUES (?, ?)');
  const insertTakeoff = db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 337; index += 1) {
    const sampledAt = new Date(observedAtMs - (index * halfHourMs)).toISOString();
    insertMetric.run(sampledAt, 10);
    if (index % 56 === 0) {
      insertTakeoff.run(
        'global_business_jet',
        `abc${String(index).padStart(3, '0')}`,
        `N${index}`,
        `Baseline ${index}`,
        'smoke',
        sampledAt,
        new Date(observedAtMs - ((index + 1) * halfHourMs)).toISOString(),
        1400,
        150,
      );
    }
  }
  insertMetric.run(observedAt, 10);
  for (let index = 0; index < 5; index += 1) {
    insertTakeoff.run(
      'global_business_jet',
      `def${String(index).padStart(3, '0')}`,
      `N9${index}`,
      `Current ${index}`,
      'smoke',
      observedAt,
      new Date(observedAtMs - halfHourMs).toISOString(),
      1600 + index,
      180 + index,
    );
  }
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 10,
      baselineMean: 10,
      zScore: 0,
      emergencyLevel: 1,
    },
    signals: {
      composite: {
        emergencyLevel: 1,
        sigmaShift: 0,
        expectedConcurrentCount: 10,
      },
    },
  });

  const run = await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-rate-min-count',
    '3',
    '--takeoff-rate-min-samples',
    '336',
    '--takeoff-rate-min-days',
    '7',
    '--takeoff-rate-z-score',
    '3',
  ]);
  const output = JSON.parse(run.stdout.trim());
  assert(output.takeoffRateModelReady === true, 'Takeoff-rate detector did not report a ready baseline.');
  assert(output.takeoffRateSampleCount >= 336, 'Takeoff-rate detector did not use a week-long historical sample window.');
  assert(output.takeoffRateSampleDayCount >= 7, 'Takeoff-rate detector did not require distinct-day history.');
  assert(output.takeoffRateRequiredSampleCount >= 336, 'Takeoff-rate detector advertised too few required samples.');
  assert(output.takeoffRateRequiredDayCount >= 7, 'Takeoff-rate detector advertised too few required days.');
  assert(output.takeoffRateZScore >= 3, 'Takeoff-rate detector did not compute an anomalous z-score.');
  const alerts = db.prepare('SELECT kind, status, payload_json AS payloadJson FROM alert_events ORDER BY kind ASC').all();
  const kinds = alerts.map((event) => event.kind);
  const batchAlert = alerts.find((event) => event.kind === 'takeoff_batch');
  assert(batchAlert?.status === 'observed', 'Takeoff batch telemetry should not be pending alert fanout.');
  assert(kinds.includes('takeoff_rate_anomaly'), 'Takeoff detector did not create a takeoff-rate anomaly alert.');
  assert(alerts.find((event) => event.kind === 'takeoff_rate_anomaly')?.status === 'pending', 'Takeoff-rate anomaly was not queued for alert fanout.');
  assert(!kinds.includes('statistical_anomaly'), 'Takeoff detector emitted a concurrent statistical anomaly without an elevated level.');
  const ratePayload = JSON.parse(alerts.find((event) => event.kind === 'takeoff_rate_anomaly').payloadJson);
  assert(ratePayload.windowStart && ratePayload.windowEnd, 'Takeoff-rate anomaly did not include window bounds.');
  assert(ratePayload.signalFamily === 'takeoff_rate', 'Takeoff-rate anomaly did not include the signal family.');
  assert(ratePayload.takeoffCount === 5, 'Takeoff-rate anomaly recorded the wrong takeoff count.');
  db.close();
}

async function assertSingleTakeoffDuringConcurrentAnomalySuppressed() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-single-takeoff-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAt = '2026-06-23T12:00:00.000Z';
  db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'global_business_jet',
    'abc123',
    'N123',
    'Single Current',
    'smoke',
    observedAt,
    '2026-06-23T11:30:00.000Z',
    1600,
    180,
  );
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 40,
      baselineMean: 10,
      zScore: 4,
      emergencyLevel: 4,
      modelReady: true,
      weeklyBaselineSampleCount: 336,
      requiredHistorySampleCount: 336,
    },
    signals: {
      composite: {
        emergencyLevel: 4,
        sigmaShift: 4,
        expectedConcurrentCount: 10,
        modelReady: true,
        weeklyBaselineSampleCount: 336,
        requiredHistorySampleCount: 336,
      },
    },
  });

  await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-anomaly-level',
    '4',
  ]);
  const alerts = db.prepare('SELECT kind FROM alert_events ORDER BY kind ASC').all();
  assert(alerts.length === 0, 'Single takeoff during a concurrent anomaly should not create an alert event.');
  db.close();
}

async function assertConcurrentAnomalyRequiresReadyBaseline() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-concurrent-readiness-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAt = '2026-06-23T12:00:00.000Z';
  const insertTakeoff = db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 3; index += 1) {
    insertTakeoff.run(
      'global_business_jet',
      `abc12${index}`,
      `N12${index}`,
      `Sparse Current ${index}`,
      'smoke',
      observedAt,
      '2026-06-23T11:30:00.000Z',
      1600 + index,
      180 + index,
    );
  }
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 70,
      baselineMean: 10,
      zScore: 8,
      emergencyLevel: 5,
      modelReady: false,
      weeklyBaselineSampleCount: 1,
      requiredHistorySampleCount: 336,
    },
    signals: {
      composite: {
        emergencyLevel: 5,
        sigmaShift: 8,
        expectedConcurrentCount: 10,
        modelReady: false,
        weeklyBaselineSampleCount: 1,
        requiredHistorySampleCount: 336,
      },
    },
  });

  await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--anomaly-level',
    '5',
    '--takeoff-batch-min',
    '3',
    '--takeoff-anomaly-level',
    '4',
  ]);
  const alerts = db.prepare('SELECT kind, status FROM alert_events ORDER BY kind ASC').all();
  assert(alerts.length === 1 && alerts[0].kind === 'takeoff_batch' && alerts[0].status === 'observed', 'Underpowered concurrent baseline should only emit observed takeoff telemetry.');
  db.close();
}



async function assertAlertEventBridgePosts(dbPath, token, statusPath) {
  const alertEventKey = 'bridge-post-smoke-event';
  const db = new Database(dbPath);
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
    ON CONFLICT(event_key) DO NOTHING
  `).run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    alertEventKey,
    '2026-06-23T00:30:00.000Z',
    'Bridge post smoke',
    'Bridge post smoke message',
    JSON.stringify({ emergencyLevel: 4, takeoffCount: 9, signalFamily: 'takeoff_rate' }),
    'pending',
  );
  db.close();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let receivedPayload = null;
  let receivedAuth = null;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, baseUrl);
    if (request.method !== 'POST' || requestUrl.pathname !== '/api/internal/alert-events') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    receivedAuth = request.headers.authorization || '';
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      receivedPayload = JSON.parse(text);
      sendJson(response, 200, {
        ok: true,
        results: receivedPayload.events.map((event) => ({ ok: true, eventKey: event.eventKey })),
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const bridgeRun = await execNode(
      [
        'scripts/bridge_alert_events.js',
        '--db',
        dbPath,
        '--limit',
        '5',
        '--url',
        `${baseUrl}/api/internal/alert-events`,
        '--status-path',
        statusPath,
      ],
      { env: { ...process.env, INTERNAL_ALERT_TOKEN: token } },
    );
    const bridgeOutput = JSON.parse(bridgeRun.stdout.trim());
    const bridgeStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert(receivedAuth === `Bearer ${token}`, 'Bridge did not authenticate with the configured internal token.');
    assert(receivedPayload?.source === 'local_refresh', 'Bridge did not identify the local refresh source.');
    assert(Array.isArray(receivedPayload?.events), 'Bridge did not post an events array.');
    assert(receivedPayload.events.some((event) => event.eventKey === alertEventKey), 'Bridge did not post the queued alert event.');
    assert(bridgeOutput.ok === true && bridgeOutput.skipped === false, 'Bridge success run did not report ok=true.');
    assert(bridgeOutput.postedEvents >= 1, 'Bridge success run did not report posted events.');
    assert(bridgeStatus.ok === true && bridgeStatus.skipped === false, 'Bridge status file did not persist successful posting.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function assertPagesWebPushSubscriptionAndFanout() {
  const moduleRoot = fs.mkdtempSync(path.join(ROOT_DIR, 'tmp', 'apocalypse-ews-web-push-esm-'));
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT_DIR, 'functions'), path.join(moduleRoot, 'functions'), { recursive: true });
  const publicKeyEndpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'push', 'vapid-public-key.js')).href;
  const subscribeEndpointUrl = pathToFileURL(path.join(moduleRoot, 'functions', 'api', 'push', 'subscribe.js')).href;
  const notificationsModuleUrl = pathToFileURL(path.join(moduleRoot, 'functions', '_lib', 'notifications.js')).href;
  const { onRequestGet: getPushPublicKey } = await import(publicKeyEndpointUrl);
  const { onRequestPost: postPushSubscription } = await import(subscribeEndpointUrl);
  const { maybeSendLevel5Notifications, sendAlertEventNotifications } = await import(notificationsModuleUrl);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-web-push-')), 'notify.sqlite');
  const db = new Database(dbPath);
  applyD1Migrations(db);
  const vapidEnv = createSmokeVapidEnv();
  const subscription = await createSmokePushSubscription('https://push.example.test/send/d1-smoke');
  const env = {
    ...vapidEnv,
    APP_BASE_URL: 'https://alerts.example.test',
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString('base64'),
    LEVEL5_SUBSCRIBER_BATCH_SIZE: '10',
    ALERT_EVENT_MAX_BATCHES_PER_INVOCATION: '1',
    EWS_NOTIFY_DB: createD1Adapter(db),
  };

  const publicKeyResponse = await getPushPublicKey({
    request: new Request('https://alerts.example.test/api/push/vapid-public-key'),
    env,
  });
  const publicKeyPayload = await publicKeyResponse.json();
  assert(publicKeyResponse.status === 200, `Push public key endpoint failed with ${publicKeyResponse.status}.`);
  assert(publicKeyPayload.publicKey === vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY, 'Push public key endpoint returned the wrong VAPID key.');

  const subscribeResponse = await postPushSubscription({
    request: new Request('https://alerts.example.test/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'smoke-web-push' },
      body: JSON.stringify({ subscription }),
    }),
    env,
  });
  const subscribePayload = await subscribeResponse.json();
  assert(subscribeResponse.status === 200, `Push subscribe endpoint failed: ${JSON.stringify(subscribePayload)}`);
  assert(subscribePayload.pushEnabled === true, 'Push subscribe endpoint did not enable push.');
  const saved = db.prepare('SELECT status, wants_push, push_endpoint_hash FROM notification_signups').get();
  assert(saved?.status === 'active' && saved?.wants_push === 1 && saved?.push_endpoint_hash, 'Push subscribe endpoint did not persist an active push subscriber.');

  const originalFetch = globalThis.fetch;
  const pushRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://push.example.test/')) {
      pushRequests.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        bodyLength: options.body?.byteLength || options.body?.length || 0,
      });
      return new Response('', { status: 201, headers: { location: 'push-message-smoke' } });
    }
    return originalFetch(url, options);
  };
  try {
    const summary = await sendAlertEventNotifications(env, {
      eventKey: 'web-push-fanout-smoke',
      kind: 'takeoff_rate_anomaly',
      cohort: 'global_business_jet',
      title: 'Web push fanout smoke',
      message: 'Web push fanout smoke message',
      severity: 'high',
      level: 4,
      occurredAt: '2026-06-23T00:00:00.000Z',
    });
    assert(summary.status === 'sent', `Web push fanout did not complete: ${JSON.stringify(summary)}`);
    assert(summary.pushSentCount === 1, 'Web push fanout did not count a pushed alert.');
    assert(pushRequests.length === 1, 'Web push fanout did not post exactly one push request.');
    assert(pushRequests[0].headers['content-encoding'] === 'aes128gcm', 'Web push request did not use aes128gcm payload encoding.');
    assert(pushRequests[0].headers.authorization?.startsWith('vapid '), 'Web push request did not include VAPID authorization.');
    assert(pushRequests[0].bodyLength > 0, 'Web push request had an empty encrypted body.');
    const delivery = db.prepare('SELECT channel, status, provider_message_id FROM notification_deliveries').get();
    assert(delivery?.channel === 'push' && delivery?.status === 'sent', 'Web push delivery was not recorded as sent.');

    const level5Summary = await maybeSendLevel5Notifications(env, {
      liveStatus: { latestSlotKey: 'push-cooldown-smoke' },
      signals: {
        composite: {
          emergencyLevel: 5,
          actualConcurrentCount: 521,
          expectedConcurrentCount: 400,
          asOf: '2026-06-23T00:30:00.000Z',
        },
      },
    });
    assert(level5Summary.status === 'sent', `Push-only level-5 fanout did not complete: ${JSON.stringify(level5Summary)}`);
    assert(level5Summary.pushSentCount === 1, 'Push-only level-5 fanout did not count the pushed alert.');
    assert(pushRequests.length === 2, 'Push-only level-5 fanout did not post the second push request.');
    const cooldown = db.prepare("SELECT value FROM notification_meta WHERE key = 'level5_notification_last_sent_at'").get();
    assert(cooldown?.value, 'Push-only level-5 fanout did not start the level-5 cooldown.');
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
  assertDeploySecretCoverage();
  assertDeployEnvFileLoading(tempRoot);
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
  const vapidEnv = createSmokeVapidEnv();
  const pushSubscription = await createSmokePushSubscription();
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
    SENDGRID_WEBHOOK_PUBLIC_KEY: 'smoke-sendgrid-webhook-public-key',
    SENDGRID_WEBHOOK_URL: 'https://alerts.example.test/api/sendgrid/webhook',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_NUMBER: '+14155552671',
    TELNYX_PUBLIC_KEY: 'smoke-telnyx-public-key',
    STRIPE_SECRET_KEY: 'sk_test_smoke',
    STRIPE_WEBHOOK_SECRET: 'whsec_smoke',
    STRIPE_PRICE_ID: 'price_smoke',
    TELEGRAM_BOT_TOKEN: 'smoke-telegram-token',
    TELEGRAM_CHANNEL: 'alerts-channel',
    WEB_PUSH_VAPID_PUBLIC_KEY: vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: vapidEnv.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_CONTACT: vapidEnv.WEB_PUSH_CONTACT,
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
    const noConsentLocalSignup = await fetch(`${baseUrl}/api/notifications/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+14155552671' }),
    });
    assert(noConsentLocalSignup.status === 400, `Local SMS signup without consent returned ${noConsentLocalSignup.status}.`);


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

    const pushKey = await waitForJson(`${baseUrl}/api/push/vapid-public-key`);
    assert(pushKey.payload.publicKey === vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY, 'Push public key endpoint did not return the configured VAPID key.');
    const pushSignup = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: pushSubscription }),
    });
    if (!pushSignup.ok) {
      throw new Error(`Push signup failed with HTTP ${pushSignup.status}: ${await pushSignup.text()}`);
    }
    const pushSignupPayload = await pushSignup.json();
    assert(pushSignupPayload.pushEnabled === true, 'Push signup endpoint did not enable browser push.');

    const unauthorizedStatus = await fetch(`${baseUrl}/api/admin/local-pipeline-status`);
    assert(unauthorizedStatus.status === 401, `Pipeline status without auth returned ${unauthorizedStatus.status}, not 401.`);
    const authorized = await waitForJson(`${baseUrl}/api/admin/local-pipeline-status`, {
      fetchOptions: { headers: { authorization: `Bearer ${token}` } },
    });
    assert(authorized.payload.localDispatch.activeSubscriberCount === 2, 'Pipeline status did not count the active email and push subscribers.');
    assert(authorized.payload.feeds.eventSignals.itemCount === 1, 'Pipeline status did not summarize event signal records.');
    assert(authorized.payload.bridge.reason === 'smoke_seed', 'Pipeline status did not surface bridge health.');
    assert(authorized.payload.providerConfig.sendgridConfigured === true, 'Pipeline status did not report SendGrid as configured.');
    assert(authorized.payload.providerConfig.sendgridWebhookVerificationConfigured === true, 'Pipeline status did not report SendGrid webhook verification as configured.');
    assert(authorized.payload.providerConfig.sendgridDeliveryStatusConfigured === true, 'Pipeline status did not report SendGrid delivery status as configured.');
    assert(authorized.payload.providerConfig.telnyxConfigured === true, 'Pipeline status did not report Telnyx as configured.');
    assert(authorized.payload.providerConfig.telegramEmergencyConfigured === true, 'Pipeline status did not report emergency Telegram as configured from TELEGRAM_CHANNEL.');
    assert(authorized.payload.providerConfig.webPushConfigured === true, 'Pipeline status did not report browser push as configured.');
    assert(authorized.payload.notificationCryptoConfigured === true, 'Pipeline status did not report notification crypto as configured.');

    const eventSignals = await waitForJson(`${baseUrl}/api/event-signals`);
    assert(eventSignals.payload.records.length === 1, 'Event signals API did not return the published record.');
    const alertsFeed = await waitForJson(`${baseUrl}/alerts.json`);
    assert(alertsFeed.payload.events.length === 1, 'Alerts JSON route did not return the published event.');


    await assertAlertEventBridgePosts(dbPath, token, path.join(tempRoot, 'bridge-post-status.json'));
    const bridgeRun = await execNode(
      ['scripts/bridge_alert_events.js', '--db', dbPath, '--limit', '1', '--url', '', '--status-path', bridgeStatusPath],
      { env: { ...process.env, EWS_ALERT_EVENTS_WEBHOOK_URL: '', INTERNAL_ALERT_TOKEN: token } },
    );
    const bridgeOutput = JSON.parse(bridgeRun.stdout.trim());
    const bridgeStatus = JSON.parse(fs.readFileSync(bridgeStatusPath, 'utf8'));
    assert(bridgeOutput.reason === 'missing_EWS_ALERT_EVENTS_WEBHOOK_URL', 'Bridge missing-url run did not report the expected reason.');
    assert(bridgeStatus.reason === bridgeOutput.reason, 'Bridge status file did not persist the latest result.');

    await assertResumableAlertFanout();
    await assertPagesPipelineStatus(token);
    await assertPagesWebPushSubscriptionAndFanout();
    await assertTakeoffRateDetection();
    await assertSingleTakeoffDuringConcurrentAnomalySuppressed();
    await assertConcurrentAnomalyRequiresReadyBaseline();
    await assertPagesPipelineSmokeScript(token);
    await assertManualSubscriberValidation();
    await assertPublicNotificationSignupEndpoint();
    await assertSendGridWebhookDeliveryStatus();
    await assertClaimAlertRecordIsIdempotent();
    await assertAlertProcessingStaleReclaim();
    await assertLocalDispatchSkipsRawTakeoffTelemetry();
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
