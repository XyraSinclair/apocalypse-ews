#!/usr/bin/env node

// One-command health report. The re-entry tool: run `npm run status` after
// any absence to see exactly what state the system is in.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function dbReport(dbPath, label, freshnessTable) {
  if (!fs.existsSync(dbPath)) {
    return { label, missing: true };
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const latest = safe(() => db.prepare(`SELECT MAX(sampled_at) AS v FROM ${freshnessTable}`).get()?.v);
    const latestMs = latest ? Date.parse(latest) : null;
    const staleHours = latestMs ? +((Date.now() - latestMs) / 3600000).toFixed(1) : null;
    const sampleCount7d = safe(() => db.prepare(
      `SELECT COUNT(DISTINCT sampled_at) AS c FROM ${freshnessTable} WHERE sampled_at >= datetime('now', '-7 days')`
    ).get()?.c, 0);
    const sampleCount30d = safe(() => db.prepare(
      `SELECT COUNT(DISTINCT sampled_at) AS c FROM ${freshnessTable} WHERE sampled_at >= datetime('now', '-30 days')`
    ).get()?.c, 0);
    const baselineReady = sampleCount7d >= 7 * 48 * 0.95; // tolerate a few missed slots

    // Data accountability: every expected 30-min slot is live, backfilled,
    // or missing — and the live instrument's age has its own bound,
    // distinct from row freshness (repair can heal rows without the live
    // ingester running).
    const hasProvenance = Boolean(safe(() =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_slots'").get()
    ));
    let provenance = null;
    if (hasProvenance) {
      const latestLive = safe(() =>
        db.prepare('SELECT MAX(sampled_at) AS v FROM ingest_slots WHERE live_ingested = 1').get()?.v
      );
      const latestLiveMs = latestLive ? Date.parse(latestLive) : null;
      const liveAgeMinutes = latestLiveMs ? Math.round((Date.now() - latestLiveMs) / 60000) : null;
      const liveSlots24h = safe(() => db.prepare(
        "SELECT COUNT(*) AS c FROM ingest_slots WHERE live_ingested = 1 AND sampled_at >= datetime('now', '-1 day')"
      ).get()?.c, 0);
      const firstRow = safe(() => db.prepare(`SELECT MIN(sampled_at) AS v FROM ${freshnessTable}`).get()?.v);
      const windowStartMs = Math.max(
        firstRow ? Date.parse(firstRow) : Date.now(),
        Date.now() - 30 * 24 * 3600000,
      );
      const expectedSlots30d = latestMs && latestMs > windowStartMs
        ? Math.floor((latestMs - windowStartMs) / (30 * 60000)) + 1
        : 0;
      const missingSlots30d = Math.max(0, expectedSlots30d - sampleCount30d);
      provenance = {
        latestLiveSample: latestLive,
        liveAgeMinutes,
        liveSlots24h,
        expectedSlots30d,
        missingSlots30d,
        completenessPct30d: expectedSlots30d
          ? +((sampleCount30d / expectedSlots30d) * 100).toFixed(2)
          : null,
      };
    }
    return { label, latestSample: latest, staleHours, sampleCount7d, sampleCount30d, baselineReady, provenance };
  } finally {
    db.close();
  }
}

function launchdState(agent) {
  const output = safe(() => execFileSync('launchctl', ['print', `gui/${process.getuid()}/${agent}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), '');
  if (!output) return { agent, loaded: false };
  const running = /\bstate = running\b/.test(output);
  const lastExit = output.match(/last exit code = ([^\n]+)/)?.[1]?.trim() || null;
  return { agent, loaded: true, running, lastExit };
}

function systemctlQuery(args) {
  // is-active/is-enabled exit non-zero for inactive/failed/disabled units but
  // still print the state — capture stdout from the thrown error, or the
  // whole report reads "unknown" and failed oneshots become invisible.
  try {
    return execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const output = String(error.stdout || '').trim();
    return output || 'unknown';
  }
}

function systemdState(unit) {
  const active = systemctlQuery(['is-active', unit]);
  const enabled = systemctlQuery(['is-enabled', unit]);
  // Timers report as loaded when waiting; oneshot services as inactive between
  // runs — both count as loaded. "failed" is the state that matters.
  const loaded = active !== 'unknown' && enabled !== 'not-found';
  return { agent: unit, loaded, running: active === 'active', lastState: active, enabled };
}

function serviceStates() {
  if (process.platform === 'darwin') {
    return [
      launchdState('com.xyra.apocalypse-ews.refresh'),
      launchdState('com.xyra.apocalypse-ews.server'),
      launchdState('com.xyra.apocalypse-ews.repair'),
    ];
  }
  return [
    systemdState('apocalypse-ews.service'),
    systemdState('apocalypse-ews-refresh.timer'),
    systemdState('apocalypse-ews-refresh-imports.timer'),
    systemdState('apocalypse-ews-repair.timer'),
    systemdState('apocalypse-ews-watchdog.timer'),
    systemdState('apocalypse-ews-backup.timer'),
    systemdState('cloudflared.service'),
    systemdState('ntfy.service'),
    systemdState('apocalypse-ews-canary.timer'),
    systemdState('apocalypse-ews-canary.service'),
    systemdState('apocalypse-ews-selftest.timer'),
    systemdState('apocalypse-ews-selftest.service'),
  ];
}

function backupsReport() {
  const backupRoot = process.env.EWS_BACKUP_DIR
    ? path.resolve(process.env.EWS_BACKUP_DIR)
    : path.join(DATA_DIR, 'backups');
  const days = safe(() => fs.readdirSync(backupRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry)).sort(), []);
  if (!days.length) return { latestDay: null, dayCount: 0 };
  const latestDay = days[days.length - 1];
  const files = safe(() => fs.readdirSync(path.join(backupRoot, latestDay)).filter((f) => f.endsWith('.sqlite')), []);
  const ageHours = +(((Date.now() - Date.parse(`${latestDay}T02:10:00Z`)) / 3600000).toFixed(1));
  return { latestDay, dayCount: days.length, latestFiles: files.length, ageHours };
}

function alertsReport() {
  const dbPath = path.join(DATA_DIR, 'ews-main.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const total = safe(() => db.prepare('SELECT COUNT(*) AS c FROM alert_events').get()?.c, 0);
    const last = safe(() => db.prepare('SELECT severity, title, occurred_at FROM alert_events ORDER BY id DESC LIMIT 1').get());
    const cursors = safe(() => Object.fromEntries(
      db.prepare("SELECT key, value FROM meta WHERE key IN ('local_push_last_alert_id', 'ntfy_last_alert_id')").all()
        .map((row) => [row.key, Number(row.value)])
    ), {});
    return { totalEvents: total, lastEvent: last || null, publisherCursors: cursors };
  } finally {
    db.close();
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  cohorts: [
    dbReport(path.join(DATA_DIR, 'ews-main.sqlite'), 'global_business_jet', 'concurrent_metrics'),
    dbReport(path.join(DATA_DIR, 'ews-military.sqlite'), 'global_military_aircraft', 'concurrent_metrics'),
    dbReport(path.join(DATA_DIR, 'ews-untracked.sqlite'), 'non_icao_untracked', 'non_icao_metrics'),
  ],
  services: serviceStates(),
  serverHttp: safe(() => {
    execFileSync('curl', ['-sf', '-o', '/dev/null', '--max-time', '5', 'http://127.0.0.1:3030/dashboard.json']);
    return 'ok';
  }, 'unreachable'),
  alerts: alertsReport(),
  backups: process.platform === 'darwin' ? null : backupsReport(),
  verdict: null,
};

// Instrument bounds (rationale table in OPERATIONS.md "Instrument bounds").
// Slot cadence 30 min + refresh at :05/:35 means healthy data age tops out
// near 40 min; 75 min = one full missed refresh cycle plus margin.
const MAX_DATA_AGE_HOURS = 1.25;
const MAX_LIVE_AGE_MINUTES = 75;
const MIN_LIVE_SLOTS_24H = 42; // 48 expected; tolerate 6 missed live slots/day
const MIN_COMPLETENESS_PCT_30D = 98;

const problems = [];
for (const cohort of report.cohorts) {
  if (cohort.missing) { problems.push(`${cohort.label}: database missing`); continue; }
  if (cohort.staleHours === null || cohort.staleHours > MAX_DATA_AGE_HOURS) {
    problems.push(`${cohort.label}: history stale (${cohort.staleHours}h > ${MAX_DATA_AGE_HOURS}h bound) — run npm run repair:gaps`);
  }
  const provenance = cohort.provenance;
  if (provenance) {
    if (provenance.liveAgeMinutes === null || provenance.liveAgeMinutes > MAX_LIVE_AGE_MINUTES) {
      problems.push(`${cohort.label}: live ingestion stale (${provenance.liveAgeMinutes}m > ${MAX_LIVE_AGE_MINUTES}m bound) — check apocalypse-ews-refresh.timer`);
    }
    if (provenance.liveSlots24h < MIN_LIVE_SLOTS_24H) {
      problems.push(`${cohort.label}: only ${provenance.liveSlots24h}/48 live slots in 24h (bound ${MIN_LIVE_SLOTS_24H}) — live ingestion is skipping slots`);
    }
    if (provenance.completenessPct30d !== null && provenance.completenessPct30d < MIN_COMPLETENESS_PCT_30D) {
      problems.push(`${cohort.label}: 30d slot completeness ${provenance.completenessPct30d}% < ${MIN_COMPLETENESS_PCT_30D}% (${provenance.missingSlots30d} slots missing) — run npm run repair:gaps`);
    }
  }
}
for (const service of report.services) {
  if (!service.loaded) problems.push(`${service.agent}: not loaded — see OPERATIONS.md`);
  else if (service.lastState === 'failed') problems.push(`${service.agent}: failed — check journalctl -u ${service.agent}`);
}
if (report.serverHttp !== 'ok') problems.push('dashboard server unreachable on :3030');
if (report.backups) {
  if (!report.backups.dayCount) problems.push('no sqlite backups yet — run npm run backup');
  else if (report.backups.latestFiles < 3) problems.push(`latest backup day ${report.backups.latestDay} has ${report.backups.latestFiles}/3 databases`);
  else if (report.backups.ageHours > 50) problems.push(`sqlite backups stale (${report.backups.ageHours}h) — check apocalypse-ews-backup.timer`);
}
report.verdict = problems.length ? { healthy: false, problems } : { healthy: true };

console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
