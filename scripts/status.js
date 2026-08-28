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
    return { label, latestSample: latest, staleHours, sampleCount7d, sampleCount30d, baselineReady };
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

function systemdState(unit) {
  const active = safe(() => execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'unknown');
  const enabled = safe(() => execFileSync('systemctl', ['is-enabled', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'unknown');
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

const problems = [];
for (const cohort of report.cohorts) {
  if (cohort.missing) problems.push(`${cohort.label}: database missing`);
  else if (cohort.staleHours === null || cohort.staleHours > 2) problems.push(`${cohort.label}: history stale (${cohort.staleHours}h) — run npm run repair:gaps`);
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
