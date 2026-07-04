#!/usr/bin/env node

// Push new alert events to the machine owner via the local xmsg CLI.
// Cursor lives in the meta table (local_push_last_alert_id), so each event
// notifies exactly once. Silently no-ops when xmsg is not installed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const DEFAULT_XMSG = '/Users/xyra/Documents/xyra-wishes/scripts/xmsg';
const CURSOR_KEY = 'local_push_last_alert_id';

function parseArgs(argv) {
  const args = {
    db: process.env.EWS_DB_PATH || path.join(__dirname, '..', 'data', 'ews-main.sqlite'),
    xmsg: process.env.EWS_XMSG_PATH || DEFAULT_XMSG,
    dryRun: false,
    limit: 10,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--xmsg') args.xmsg = argv[++index];
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--limit') args.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function channelsForSeverity(severity) {
  if (severity === 'critical') return 'imessage,email,desktop';
  if (severity === 'high') return 'desktop,email';
  if (severity === 'elevated') return 'desktop';
  // watch-level events are ambient signal: dashboard/RSS only, never a push.
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(path.resolve(args.db));
  db.pragma('busy_timeout = 30000');
  try {
    const hasXmsg = fs.existsSync(args.xmsg);
    const cursorRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(CURSOR_KEY);
    let cursor = cursorRow ? Number(cursorRow.value) : null;
    if (cursor === null) {
      // First run: do not replay history; start from the current high-water mark.
      const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM alert_events').get();
      cursor = maxRow.id;
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(cursor));
      console.log(JSON.stringify({ ok: true, initializedCursor: cursor, sent: 0 }));
      return;
    }

    const events = db
      .prepare('SELECT id, severity, cohort, title, message, occurred_at FROM alert_events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(cursor, args.limit);

    let sent = 0;
    for (const event of events) {
      const channels = channelsForSeverity(event.severity);
      if (!channels) {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(event.id));
        continue;
      }
      const subject = `EWS ${event.severity.toUpperCase()}: ${event.title}`;
      const body = `${event.message}\n\ncohort=${event.cohort} occurred_at=${event.occurred_at}`;
      if (args.dryRun || !hasXmsg) {
        console.log(JSON.stringify({ wouldSend: subject, channels, dryRun: args.dryRun, hasXmsg }));
      } else {
        const result = spawnSync(args.xmsg, [
          'send',
          '--channels', channels,
          '--subject', subject,
          body,
        ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        if (result.status !== 0) {
          // Stop at first failure; cursor stays put so the event retries next pass.
          console.error(`xmsg failed for event ${event.id}: ${String(result.stderr || result.stdout || result.error || '').trim()}`);
          break;
        }
        sent += 1;
      }
      if (!args.dryRun) {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(event.id));
      }
    }

    console.log(JSON.stringify({ ok: true, cursor, examined: events.length, sent, dryRun: args.dryRun, hasXmsg }));
  } finally {
    db.close();
  }
}

main();
