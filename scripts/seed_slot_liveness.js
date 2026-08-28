#!/usr/bin/env node

// One-time (idempotent) provenance seed for history that predates the
// ingest_slots table. The live snapshot-transition process leaves an exact
// per-day fingerprint — takeoff_events rows with the live source — so any
// day with a healthy count of live events was a day the live ingester ran.
// Every concurrent_metrics slot on such a day is marked live_ingested = 1
// (a live day's zero-takeoff night slots are genuine zeros, not gaps).
// Days below the threshold stay unmarked and the takeoff-rate baseline
// excludes them.
//
// Usage: node scripts/seed_slot_liveness.js --db data/ews-main.sqlite [--min-day-events 100]

const path = require('node:path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { db: null, minDayEvents: 100, liveSource: process.env.EWS_TAKEOFF_LIVE_SOURCE || 'adsbx_heatmap' };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--min-day-events') args.minDayEvents = Number(argv[++index]);
    else if (value === '--live-source') args.liveSource = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.db) {
    throw new Error('Usage: node scripts/seed_slot_liveness.js --db path [--min-day-events n]');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(path.resolve(args.db));
  db.pragma('busy_timeout = 30000');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_slots (
        sampled_at TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        total_aircraft INTEGER,
        cohort_airborne INTEGER,
        live_ingested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
      db.exec('ALTER TABLE ingest_slots ADD COLUMN live_ingested INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already present
    }
    const result = db
      .prepare(`
        WITH live_days AS (
          SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS eventCount
          FROM takeoff_events
          WHERE source = ?
          GROUP BY day
          HAVING eventCount >= ?
        )
        INSERT INTO ingest_slots (sampled_at, source, total_aircraft, cohort_airborne, live_ingested)
        SELECT m.sampled_at, 'seeded_live_day', NULL, m.concurrent_count, 1
        FROM concurrent_metrics m
        JOIN live_days ld ON substr(m.sampled_at, 1, 10) = ld.day
        WHERE TRUE
        ON CONFLICT(sampled_at) DO UPDATE SET live_ingested = 1
      `)
      .run(args.liveSource, args.minDayEvents);
    const summary = db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(live_ingested) AS liveMarked,
          SUM(CASE WHEN source = 'seeded_live_day' THEN 1 ELSE 0 END) AS seeded
        FROM ingest_slots
      `)
      .get();
    console.log(JSON.stringify({ ok: true, db: path.resolve(args.db), changes: result.changes, ...summary }));
  } finally {
    db.close();
  }
}

main();
