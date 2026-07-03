#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const MAIN_DB = path.join(DATA_DIR, 'ews-main.sqlite');
const MILITARY_DB = path.join(DATA_DIR, 'ews-military.sqlite');
const UNTRACKED_DB = path.join(DATA_DIR, 'ews-untracked.sqlite');
const VENV_PYTHON = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.EWS_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');

const args = new Set(process.argv.slice(2));
const refreshImports = args.has('--refresh-imports');
const skipAlerts = args.has('--skip-alerts');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with status ${result.status}`);
  }
}

function trackedAircraftCount(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return 0;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    return db
      .prepare('SELECT hex FROM tracked_aircraft')
      .all()
      .filter((row) => /^[0-9a-f]{6}$/i.test(row.hex)).length;
  } finally {
    db.close();
  }
}

function purgeDemoTrackedAircraft(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return;
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  try {
    db.prepare("DELETE FROM tracked_aircraft WHERE source = 'demo'").run();
  } finally {
    db.close();
  }
}

function ensureMainCohort() {
  if (!refreshImports && trackedAircraftCount(MAIN_DB) > 0) {
    return;
  }

  run(PYTHON_BIN, ['scripts/import_faa_cohort.py', '--db', MAIN_DB]);
  run(PYTHON_BIN, ['scripts/import_global_cohort.py', '--db', MAIN_DB, ...(refreshImports ? ['--refresh'] : [])]);
}

function ensureMilitaryCohort() {
  if (!refreshImports && trackedAircraftCount(MILITARY_DB) > 0) {
    return;
  }

  run(PYTHON_BIN, [
    'scripts/import_global_cohort.py',
    '--db',
    MILITARY_DB,
    '--tracked-category',
    'military',
    '--tracked-source',
    'global_military_aircraft',
    ...(refreshImports ? ['--refresh'] : []),
  ]);
}

function refreshLiveData() {
  purgeDemoTrackedAircraft(MAIN_DB);
  purgeDemoTrackedAircraft(MILITARY_DB);
  purgeDemoTrackedAircraft(UNTRACKED_DB);
  run(PYTHON_BIN, ['scripts/update_latest_heatmap.py', '--db', MAIN_DB]);
  run(PYTHON_BIN, ['scripts/update_latest_heatmap.py', '--db', MILITARY_DB]);
  run(PYTHON_BIN, [
    'scripts/track_non_icao_hex.py',
    '--db',
    UNTRACKED_DB,
    '--latest-live',
    '--cache-dir',
    path.join(DATA_DIR, 'cache', 'adsbx_live'),
    '--replace-live-snapshot',
  ]);
}

function exportSnapshots() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    MAIN_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'dashboard.json'),
    '--endpoint',
    'main',
    '--cohort',
    'global_business_jet',
  ]);
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    MILITARY_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'military-dashboard.json'),
    '--endpoint',
    'military',
    '--cohort',
    'global_military_aircraft',
  ]);
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    UNTRACKED_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'untracked-dashboard.json'),
    '--endpoint',
    'untracked',
    '--cohort',
    'non_icao_untracked',
  ]);
}

function detectAlertEvents() {
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    MAIN_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'dashboard.json'),
    '--events-db',
    MAIN_DB,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-rate-min-count',
    '3',
  ]);
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    MILITARY_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'military-dashboard.json'),
    '--cohort',
    'global_military_aircraft',
    '--events-db',
    MAIN_DB,
    '--takeoff-batch-min',
    '4',
    '--takeoff-rate-min-count',
    '4',
  ]);
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    UNTRACKED_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'untracked-dashboard.json'),
    '--cohort',
    'non_icao_untracked',
    '--events-db',
    MAIN_DB,
    '--takeoff-batch-min',
    '10',
    '--takeoff-rate-min-count',
    '10',
  ]);
}

function updateAlerts() {
  if (skipAlerts) {
    return;
  }

  run('node', ['scripts/update_rss_feed.js'], { env: { EWS_DB_PATH: MAIN_DB } });
  run('node', ['scripts/send_telegram_alert.js'], { env: { EWS_DB_PATH: MAIN_DB } });
  run('node', ['scripts/dispatch_alert_events.js', '--db', MAIN_DB]);
  run('node', ['scripts/bridge_alert_events.js', '--db', MAIN_DB]);
  run('node', ['scripts/notify_local_push.js', '--db', MAIN_DB]);
}

function exportOperationsFeed() {
  run('node', ['scripts/export_operations_feed.js'], {
    env: {
      EWS_DB_PATH: MAIN_DB,
      EWS_MILITARY_DB_PATH: MILITARY_DB,
      EWS_UNTRACKED_DB_PATH: UNTRACKED_DB,
    },
  });
}

function exportEventSignalsFeed() {
  run('node', ['scripts/export_event_signals_feed.js'], {
    env: {
      EWS_DB_PATH: MAIN_DB,
    },
  });
}



const LOCK_DIR = path.join(ROOT_DIR, 'tmp', 'refresh.lock');
const LOCK_STALE_MS = 45 * 60 * 1000;

function acquireRefreshLock() {
  try {
    const stat = fs.statSync(LOCK_DIR);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmdirSync(LOCK_DIR);
    }
  } catch {
    // No existing lock.
  }

  try {
    fs.mkdirSync(LOCK_DIR);
  } catch {
    return false;
  }

  const release = () => {
    try {
      fs.rmdirSync(LOCK_DIR);
    } catch {
      // Already released.
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return true;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
if (!acquireRefreshLock()) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: 'refresh lock held' }));
  process.exit(0);
}
ensureMainCohort();
ensureMilitaryCohort();
refreshLiveData();
exportSnapshots();
detectAlertEvents();
updateAlerts();
exportOperationsFeed();
exportEventSignalsFeed();
