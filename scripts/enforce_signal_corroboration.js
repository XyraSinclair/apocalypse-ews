#!/usr/bin/env node

// Corroboration gate for the top severity.
//
// The roadmap's signal-integrity contract (S6) says level 5 requires k-of-n
// independent evidence across cohorts: business jets, military, and non-ICAO
// dark traffic are three instruments, not three votes from one instrument. The
// calibrated detectors each score their own cohort and can therefore reach
// `critical` alone, which is the difference between an instrument people trust
// and one that cries wolf once and is ignored forever.
//
// This pass runs after every cohort detector and before delivery. It leaves the
// calibrated scoring untouched: an uncorroborated critical is reported at
// `high`, says so in its own message, and records the cap in its payload, so
// the suppression is visible rather than silent. Nothing is ever upgraded.
//
// It is deliberately conservative about history: an event that has already been
// delivered is left exactly as delivered. Rewriting a sent alert would falsify
// the record of what subscribers were told.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DB = process.env.EWS_DB_PATH || path.join(ROOT_DIR, 'data', 'ews-main.sqlite');
const COHORTS = ['global_business_jet', 'global_military_aircraft', 'non_icao_untracked'];
const DELIVERED_STATUSES = ['processing', 'sent', 'no_recipients', 'partial', 'failed'];
const MINUTE = 60000;
// How far back selection looks for undelivered criticals. Pairing keeps its own
// narrower window; this only bounds how much history can be rewritten.
const DEFAULT_MAX_AGE_MINUTES = 1440;

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, windowMinutes: 90, maxAgeMinutes: 1440, dryRun: false };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--window-minutes') args.windowMinutes = Number(argv[++index]);
    else if (value === '--max-age-minutes') args.maxAgeMinutes = Number(argv[++index]);
    else if (value === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const [name, value] of [['--window-minutes', args.windowMinutes], ['--max-age-minutes', args.maxAgeMinutes]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10080) throw new Error(`${name} must be an integer from 1 to 10080.`);
  }
  return args;
}

function enforce(db, settings, now = Date.now()) {
  const summary = { checked: 0, capped: 0, corroborated: 0, leftDelivered: 0, dry_run: settings.dryRun, window_minutes: settings.windowMinutes, max_age_minutes: settings.maxAgeMinutes };
  // Selection is wider than pairing on purpose: pairing asks whether two
  // instruments agreed within an hour and a half, while selection must catch
  // any critical that has not yet gone out, however long the delivery path has
  // been stalled. Bounded by age so an old archive is never rewritten.
  const since = new Date(now - (settings.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES) * MINUTE).toISOString();
  const placeholders = COHORTS.map(() => '?').join(', ');
  const criticals = db.prepare(
    `SELECT id, cohort, severity, kind, status, occurred_at, title, message, payload_json
       FROM alert_events
      WHERE cohort IN (${placeholders}) AND severity = 'critical' AND occurred_at >= ?
      ORDER BY id`,
  ).all(...COHORTS, since);
  summary.checked = criticals.length;
  const others = db.prepare(
    `SELECT 1 FROM alert_events
      WHERE cohort <> ? AND cohort IN (${placeholders}) AND severity IN ('elevated', 'high', 'critical')
        AND occurred_at >= ? AND occurred_at <= ?
      LIMIT 1`,
  );
  const update = db.prepare('UPDATE alert_events SET severity = ?, message = ?, payload_json = ? WHERE id = ? AND severity = \'critical\'');

  for (const event of criticals) {
    const occurred = Date.parse(event.occurred_at);
    const corroborated = others.get(
      event.cohort,
      ...COHORTS,
      new Date(occurred - settings.windowMinutes * MINUTE).toISOString(),
      new Date(occurred + settings.windowMinutes * MINUTE).toISOString(),
    );
    if (corroborated) {
      summary.corroborated += 1;
      continue;
    }
    if (DELIVERED_STATUSES.includes(event.status)) {
      // Already told to subscribers; the record stands as delivered.
      summary.leftDelivered += 1;
      continue;
    }
    const note = `\n\nSeverity reported as high, not critical: this cohort's signal had no independent corroboration from another cohort within ${settings.windowMinutes} minutes. The top tier requires agreement across instruments (business aviation, military, or non-ICAO traffic), so one instrument's statistics alone cannot reach it.`;
    const payload = JSON.parse(event.payload_json);
    payload.corroboration = { required: 2, present: 1, capped_from: 'critical', window_minutes: settings.windowMinutes };
    summary.capped += 1;
    if (settings.dryRun) continue;
    update.run('high', `${event.message}${note}`, JSON.stringify(payload), event.id);
  }
  return summary;
}

function main() {
  const settings = parseArgs(process.argv);
  if (!fs.existsSync(settings.db)) throw new Error(`Alert database not found: ${settings.db}`);
  const db = new Database(settings.db);
  db.pragma('busy_timeout = 10000');
  try {
    console.log(JSON.stringify(enforce(db, settings)));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, enforce, COHORTS };
