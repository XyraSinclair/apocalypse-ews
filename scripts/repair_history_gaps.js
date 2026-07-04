#!/usr/bin/env node

// Self-healing history repair. The 10-minute refresh loop only ingests the
// latest 30-minute slot, so any downtime (laptop asleep, machine off) leaves
// a permanent hole in concurrent_metrics — which stalls the anomaly baselines
// (7 days continuous) and the takeoff-rate model (28-day lookback).
//
// This script detects the gap per cohort database and runs a bounded
// backfill_history.py for exactly the missing range. Idempotent; safe to run
// on a schedule. Skips when the history is fresh, when another repair holds
// the lock, or when a backfill process already has the database open.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOCK_DIR = path.join(ROOT_DIR, 'tmp', 'repair.lock');
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // repairs can legitimately run for hours
const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // ignore holes smaller than 2h
const MAX_REPAIR_DAYS = 30; // baselines need <=28 days; cap runaway repairs
const VENV_PYTHON = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.EWS_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');

const DATABASES = [
  path.join(DATA_DIR, 'ews-main.sqlite'),
  path.join(DATA_DIR, 'ews-military.sqlite'),
];

function acquireLock() {
  try {
    const stat = fs.statSync(LOCK_DIR);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmdirSync(LOCK_DIR);
    }
  } catch {
    // No existing lock.
  }
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: false });
  } catch {
    return false;
  }
  const release = () => {
    try { fs.rmdirSync(LOCK_DIR); } catch { /* released */ }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return true;
}

function latestSampleMs(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    const row = db.prepare('SELECT MAX(sampled_at) AS latest FROM concurrent_metrics').get();
    return row?.latest ? Date.parse(row.latest) : null;
  } finally {
    db.close();
  }
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function repairDatabase(dbPath, { dryRun }) {
  if (!fs.existsSync(dbPath)) {
    return { db: dbPath, skipped: true, reason: 'missing_database' };
  }
  const latestMs = latestSampleMs(dbPath);
  if (!latestMs) {
    return { db: dbPath, skipped: true, reason: 'no_history_rows' };
  }
  const nowMs = Date.now();
  const gapMs = nowMs - latestMs;
  if (gapMs <= GAP_THRESHOLD_MS) {
    return { db: dbPath, skipped: true, reason: 'fresh', gapHours: +(gapMs / 3600000).toFixed(1) };
  }

  // Repair whole UTC days from the day of the last sample through tomorrow
  // (end date is exclusive in backfill_history.py). Cap the range.
  let startMs = Date.parse(`${isoDate(latestMs)}T00:00:00Z`);
  const maxStartMs = nowMs - MAX_REPAIR_DAYS * 24 * 60 * 60 * 1000;
  if (startMs < maxStartMs) {
    startMs = Date.parse(`${isoDate(maxStartMs)}T00:00:00Z`);
  }
  const endDate = isoDate(nowMs + 24 * 60 * 60 * 1000);
  const startDate = isoDate(startMs);

  if (dryRun) {
    return { db: dbPath, wouldRepair: true, startDate, endDate, gapHours: +(gapMs / 3600000).toFixed(1) };
  }

  const result = spawnSync(PYTHON_BIN, [
    path.join(ROOT_DIR, 'scripts', 'backfill_history.py'),
    '--db', dbPath,
    '--start-date', startDate,
    '--end-date', endDate,
  ], { cwd: ROOT_DIR, stdio: ['ignore', 'inherit', 'inherit'] });

  return {
    db: dbPath,
    repaired: result.status === 0,
    exitCode: result.status,
    startDate,
    endDate,
    gapHours: +(gapMs / 3600000).toFixed(1),
  };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  if (!acquireLock()) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'repair lock held' }));
    return;
  }
  const results = DATABASES.map((dbPath) => repairDatabase(dbPath, { dryRun }));
  const ok = results.every((entry) => entry.repaired !== false);
  console.log(JSON.stringify({ ok, dryRun, results }));
  if (!ok) {
    process.exit(1);
  }
}

main();
