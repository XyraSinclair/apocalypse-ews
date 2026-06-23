#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) process.env[key] = valueParts.join('=');
  }
}

loadEnvFile('/etc/apocalypse-ews.env');
loadEnvFile(path.join(__dirname, '..', '.env'));

function parseArgs(argv) {
  const args = {
    db: process.env.EWS_DB_PATH || path.join(__dirname, '..', 'data', 'ews-main.sqlite'),
    limit: Number(process.env.EWS_ALERT_EVENT_BRIDGE_LIMIT || 100),
    url: process.env.EWS_ALERT_EVENTS_WEBHOOK_URL || '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--limit') {
      args.limit = Number(argv[++index]);
    } else if (value === '--url') {
      args.url = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  args.limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
  return args;
}

function listAlertEvents(db, limit) {
  return db
    .prepare(`
      SELECT
        id,
        kind,
        severity,
        cohort,
        event_key AS eventKey,
        occurred_at AS occurredAt,
        title,
        message,
        payload_json AS payloadJson,
        status,
        created_at AS createdAt,
        dispatched_at AS dispatchedAt
      FROM alert_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((event) => ({
      ...event,
      payload: JSON.parse(event.payloadJson),
      payloadJson: undefined,
    }));
}

async function postEvents(url, token, events) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: 'local_refresh', events }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error || text || `Alert event bridge failed with HTTP ${response.status}`);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'missing_EWS_ALERT_EVENTS_WEBHOOK_URL' }));
    return;
  }
  const token = String(process.env.INTERNAL_ALERT_TOKEN || '').trim();
  if (!token) {
    throw new Error('Missing INTERNAL_ALERT_TOKEN for alert event bridge.');
  }

  const dbPath = path.resolve(args.db);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const events = listAlertEvents(db, args.limit);
    if (!events.length) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no_alert_events' }));
      return;
    }
    const result = await postEvents(args.url, token, events);
    console.log(JSON.stringify({ ok: true, postedEvents: events.length, result }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
