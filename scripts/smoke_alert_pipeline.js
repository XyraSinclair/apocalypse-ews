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
  } = require('./_deploy_env');
  const envPath = path.join(tempRoot, 'deploy.env');
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
    'VITE_DASHBOARD_URL=https://alerts.example.test/dashboard.json',
    'VITE_MILITARY_DASHBOARD_URL=https://alerts.example.test/military-dashboard.json',
    'VITE_UNTRACKED_DASHBOARD_URL=https://alerts.example.test/untracked-dashboard.json',
    'NOTIFICATION_HASH_SECRET=smoke-hash-secret',
    `NOTIFICATION_ENCRYPTION_KEY=${Buffer.alloc(32, 11).toString('base64')}`,
    '',
  ].join('\n'));

  const env = getEnvWithDotEnv({}, { envFiles: [envPath] });
  assert(env.CLOUDFLARE_API_TOKEN === 'smoke-cloudflare-token', 'Deploy env loader did not read the explicit env file.');
  assert(validateDeployEnv(env).length === 0, 'Deploy env validation rejected the explicit env file.');
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
    assert(payload.testDelivery?.evidence === 'provider_api_acceptance', 'Pages smoke script did not label provider acceptance evidence.');
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
  const env = { EWS_NOTIFY_DB: createD1Adapter(db) };
  assert(
    await beginAlertRecordSend(env, 'alert-stale-processing', { statuses: ['processing'], staleMs: 60_000 }),
    'Stale processing alert was not reclaimable.',
  );
  assert(
    !(await beginAlertRecordSend(env, 'alert-fresh-processing', { statuses: ['processing'], staleMs: 60_000 })),
    'Fresh processing alert was incorrectly reclaimable.',
  );
  db.close();
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
    SENDGRID_WEBHOOK_PUBLIC_KEY: 'smoke-sendgrid-webhook-public-key',
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
  assert(malformedFeedPayload.ok === false, 'Pages pipeline status did not derive ok=false for a malformed alerts feed.');
  assert(
    malformedFeedPayload.readiness?.failures?.includes('alerts_feed_empty_or_unavailable'),
    'Pages pipeline status did not identify the malformed alerts feed readiness failure.',
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
  for (let index = 1; index <= 48; index += 1) {
    const sampledAt = new Date(observedAtMs - (index * halfHourMs)).toISOString();
    insertMetric.run(sampledAt, 10);
    if (index % 16 === 0) {
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
    '24',
    '--takeoff-rate-z-score',
    '3',
  ]);
  const output = JSON.parse(run.stdout.trim());
  assert(output.takeoffRateModelReady === true, 'Takeoff-rate detector did not report a ready baseline.');
  assert(output.takeoffRateSampleCount >= 24, 'Takeoff-rate detector did not use the historical sample window.');
  assert(output.takeoffRateZScore >= 3, 'Takeoff-rate detector did not compute an anomalous z-score.');
  const alerts = db.prepare('SELECT kind, payload_json AS payloadJson FROM alert_events ORDER BY kind ASC').all();
  const kinds = alerts.map((event) => event.kind);
  assert(kinds.includes('takeoff_batch'), 'Takeoff detector did not create a batch alert.');
  assert(kinds.includes('takeoff_rate_anomaly'), 'Takeoff detector did not create a takeoff-rate anomaly alert.');
  assert(!kinds.includes('statistical_anomaly'), 'Takeoff detector emitted a concurrent statistical anomaly without an elevated level.');
  const ratePayload = JSON.parse(alerts.find((event) => event.kind === 'takeoff_rate_anomaly').payloadJson);
  assert(ratePayload.windowStart && ratePayload.windowEnd, 'Takeoff-rate anomaly did not include window bounds.');
  assert(ratePayload.signalFamily === 'takeoff_rate', 'Takeoff-rate anomaly did not include the signal family.');
  assert(ratePayload.takeoffCount === 5, 'Takeoff-rate anomaly recorded the wrong takeoff count.');
  db.close();
}


async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apocalypse-ews-alert-smoke-'));
  const publishedDir = path.join(tempRoot, 'published');
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const bridgeStatusPath = path.join(tempRoot, 'bridge-status.json');
  const token = 'alert-pipeline-smoke-token';
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
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_NUMBER: '+14155552671',
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
    assert(authorized.payload.providerConfig.sendgridWebhookVerificationConfigured === true, 'Pipeline status did not report SendGrid webhook verification as configured.');
    assert(authorized.payload.providerConfig.sendgridDeliveryStatusConfigured === true, 'Pipeline status did not report SendGrid delivery status as configured.');
    assert(authorized.payload.providerConfig.telnyxConfigured === true, 'Pipeline status did not report Telnyx as configured.');
    assert(authorized.payload.providerConfig.telegramEmergencyConfigured === true, 'Pipeline status did not report emergency Telegram as configured from TELEGRAM_CHANNEL.');
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
    await assertTakeoffRateDetection();
    await assertPagesPipelineSmokeScript(token);
    await assertManualSubscriberValidation();
    await assertSendGridWebhookDeliveryStatus();
    await assertClaimAlertRecordIsIdempotent();
    await assertAlertProcessingStaleReclaim();
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
