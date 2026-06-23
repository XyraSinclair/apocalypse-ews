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

async function assertClaimAlertRecordIsIdempotent() {
  const inserted = new Map();
  const env = {
    EWS_NOTIFY_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async run() {
                if (!/INSERT OR IGNORE INTO notification_alerts/i.test(sql)) {
                  throw new Error(`Unexpected run SQL: ${sql}`);
                }
                const [id, kind, source, level, slotKey, messageText, status, createdAt] = params;
                if (inserted.has(id)) {
                  return { meta: { changes: 0 } };
                }
                inserted.set(id, { id, kind, source, level, slot_key: slotKey, message_text: messageText, status, created_at: createdAt });
                return { meta: { changes: 1 } };
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
  const { claimAlertRecord, getAlertRecordById } = await import(dbModuleUrl);
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

    await assertClaimAlertRecordIsIdempotent();
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
