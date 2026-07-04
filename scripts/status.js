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

function dbReport(dbPath, label) {
  if (!fs.existsSync(dbPath)) {
    return { label, missing: true };
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const latest = safe(() => db.prepare('SELECT MAX(sampled_at) AS v FROM concurrent_metrics').get()?.v);
    const latestMs = latest ? Date.parse(latest) : null;
    const staleHours = latestMs ? +((Date.now() - latestMs) / 3600000).toFixed(1) : null;
    const sampleCount7d = safe(() => db.prepare(
      "SELECT COUNT(*) AS c FROM concurrent_metrics WHERE sampled_at >= datetime('now', '-7 days')"
    ).get()?.c, 0);
    const baselineReady = sampleCount7d >= 7 * 48 * 0.95; // tolerate a few missed slots
    return { label, latestSample: latest, staleHours, sampleCount7d, baselineReady };
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
    dbReport(path.join(DATA_DIR, 'ews-main.sqlite'), 'global_business_jet'),
    dbReport(path.join(DATA_DIR, 'ews-military.sqlite'), 'global_military_aircraft'),
    dbReport(path.join(DATA_DIR, 'ews-untracked.sqlite'), 'non_icao_untracked'),
  ],
  services: [
    launchdState('com.xyra.apocalypse-ews.refresh'),
    launchdState('com.xyra.apocalypse-ews.server'),
    launchdState('com.xyra.apocalypse-ews.repair'),
  ],
  serverHttp: safe(() => {
    execFileSync('curl', ['-sf', '-o', '/dev/null', '--max-time', '5', 'http://127.0.0.1:3030/dashboard.json']);
    return 'ok';
  }, 'unreachable'),
  alerts: alertsReport(),
  verdict: null,
};

const problems = [];
for (const cohort of report.cohorts) {
  if (cohort.missing) problems.push(`${cohort.label}: database missing`);
  else if (cohort.staleHours === null || cohort.staleHours > 2) problems.push(`${cohort.label}: history stale (${cohort.staleHours}h) — run npm run repair:gaps`);
}
for (const service of report.services) {
  if (!service.loaded) problems.push(`${service.agent}: not loaded — see OPERATIONS.md`);
}
if (report.serverHttp !== 'ok') problems.push('dashboard server unreachable on :3030');
report.verdict = problems.length ? { healthy: false, problems } : { healthy: true };

console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
