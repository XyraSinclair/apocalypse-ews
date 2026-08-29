#!/usr/bin/env node

// Backtest harness for the detection stack (ROADMAP Phase 1 acceptance).
//
// Replays history through the same code paths production uses:
//   - concurrent model: buildConcurrentPredictionContext scores every
//     historical slot with the calibrated alarm threshold (note: baselines
//     and calibration see the full history, exactly as the live gauge's
//     calibration does — this is the model's own view of its past, not a
//     strict walk-forward)
//   - CUSUM: the shared cusumStep law over the scored sigma-shift sequence
//   - takeoff-rate model: strict walk-forward — getTakeoffRateStats at each
//     slot only reads data before that slot
//   - --inject-exodus: multiplies the trailing hour's concurrent counts and
//     verifies the model reaches emergency level 5 within 60 minutes
//     (the "3x exodus fires critical" exit criterion)
//
// Output: JSON frequency tables — what would have fired, how often, and on
// which days. The acceptance question is legibility: does the alarm budget
// match intent (~1 critical/year of concurrent alarm, takeoff highs rare)?
//
// Usage:
//   node scripts/backtest_detector.js --db data/ews-main.sqlite --cohort global_business_jet
//     [--takeoff-days 30] [--inject-exodus] [--inject-factor 3]

const path = require('node:path');
const Database = require('better-sqlite3');

const {
  buildTakeoffBaseline,
  getTakeoffWindow,
  takeoffSeverityForZScore,
  cusumStep,
} = require('./detect_alert_events');
const {
  buildConcurrentPredictionContext,
  CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
} = require('../server/dashboard');

function parseArgs(argv) {
  const args = {
    db: null,
    cohort: null,
    takeoffDays: Number(process.env.EWS_BACKTEST_TAKEOFF_DAYS || 30),
    injectExodus: false,
    injectFactor: 3,
    takeoffWindowMinutes: Number(process.env.EWS_TAKEOFF_WINDOW_MINUTES || 30),
    takeoffRateLookbackDays: Number(process.env.EWS_TAKEOFF_RATE_LOOKBACK_DAYS || 28),
    takeoffRateMinCount: Number(process.env.EWS_TAKEOFF_RATE_MIN_COUNT || 3),
    takeoffRateZScore: Number(process.env.EWS_TAKEOFF_RATE_Z_SCORE || 3.5),
    takeoffLiveSource: process.env.EWS_TAKEOFF_LIVE_SOURCE || 'adsbx_heatmap',
    cusumK: Number(process.env.EWS_CUSUM_K || 1.5),
    cusumThreshold: Number(process.env.EWS_CUSUM_THRESHOLD || 12),
    cusumCritical: Number(process.env.EWS_CUSUM_CRITICAL || 20),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--cohort') args.cohort = argv[++index];
    else if (value === '--takeoff-days') args.takeoffDays = Number(argv[++index]);
    else if (value === '--inject-exodus') args.injectExodus = true;
    else if (value === '--inject-factor') args.injectFactor = Number(argv[++index]);
    else if (value === '--assert') args.assert = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.db || !args.cohort) {
    throw new Error('Usage: node scripts/backtest_detector.js --db path --cohort id [--takeoff-days n] [--inject-exodus]');
  }
  return args;
}

function tally(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function loadConcurrentRows(db) {
  return db
    .prepare('SELECT sampled_at AS sampledAt, concurrent_count AS concurrentCount FROM concurrent_metrics ORDER BY sampled_at ASC')
    .all();
}

function scoreConcurrent(rows) {
  return buildConcurrentPredictionContext(rows, {
    concurrentPredictionModel: CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
    weeklyBaselineTimeZone: process.env.EWS_MODEL_TIME_ZONE || CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  });
}

function concurrentReplay(context) {
  const ready = context.records.filter((record) => record.modelReady);
  const dailyPeaks = new Map();
  for (const record of ready) {
    const day = record.sampledAt.slice(0, 10);
    const current = dailyPeaks.get(day);
    if (!current || record.sigmaShift > current.sigmaShift) {
      dailyPeaks.set(day, record);
    }
  }
  const peaks = Array.from(dailyPeaks.entries())
    .map(([day, record]) => ({
      day,
      sigmaShift: +record.sigmaShift.toFixed(2),
      emergencyLevel: record.emergencyLevel,
      alertLevel: record.alertLevel,
      concurrentCount: record.concurrentCount,
      expected: Math.round(record.expectedConcurrentCount),
    }))
    .sort((left, right) => right.sigmaShift - left.sigmaShift);
  const dayPeakLevels = Array.from(dailyPeaks.values()).map((record) => record.emergencyLevel);
  return {
    scoredSlots: ready.length,
    scoredDays: dailyPeaks.size,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    emergencyLevelFrequency: tally(ready.map((record) => record.emergencyLevel)),
    alertLevelFrequency: tally(ready.map((record) => record.alertLevel)),
    level5Days: dayPeakLevels.filter((level) => level >= 5).length,
    level4PlusDays: dayPeakLevels.filter((level) => level >= 4).length,
    hottestDays: peaks.slice(0, 10),
  };
}

function cusumReplay(context, args) {
  const ready = context.records.filter((record) => record.modelReady);
  let s = 0;
  let peakS = 0;
  let armedHigh = true;
  let armedCritical = true;
  const crossings = [];
  for (const record of ready) {
    s = cusumStep(s, record.sigmaShift, args.cusumK);
    peakS = Math.max(peakS, s);
    if (armedCritical && s >= args.cusumCritical) {
      crossings.push({ severity: 'critical', sampledAt: record.sampledAt, s: +s.toFixed(2) });
      armedCritical = false;
      armedHigh = false;
    } else if (armedHigh && s >= args.cusumThreshold) {
      crossings.push({ severity: 'high', sampledAt: record.sampledAt, s: +s.toFixed(2) });
      armedHigh = false;
    }
    if (s < args.cusumThreshold / 2) {
      armedHigh = true;
      armedCritical = true;
    }
  }
  return {
    scoredSlots: ready.length,
    k: args.cusumK,
    threshold: args.cusumThreshold,
    critical: args.cusumCritical,
    peakS: +peakS.toFixed(2),
    crossingCount: crossings.length,
    crossings: crossings.slice(0, 20),
  };
}

// Strict walk-forward: at each historical slot, both the numerator (window
// takeoffs) and the baseline only see data before/at that slot — the same
// view live detection had at that moment. One query fetches the whole
// replay range plus lookback; the shared buildTakeoffBaseline pure function
// then scores each slot in memory.
function takeoffReplay(db, args) {
  const lookbackDays = Math.max(1, args.takeoffRateLookbackDays);
  const replayDays = Math.max(1, args.takeoffDays);
  const rows = db
    .prepare(`
      SELECT
        m.sampled_at AS sampledAt,
        (
          SELECT COUNT(DISTINCT t.hex)
          FROM takeoff_events t
          WHERE t.cohort = ?
            AND t.source = ?
            AND t.observed_at = m.sampled_at
        ) AS takeoffCount,
        ${db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_slots'").get()
          ? '(SELECT s.live_ingested FROM ingest_slots s WHERE s.sampled_at = m.sampled_at)'
          : 'NULL'} AS liveIngested
      FROM concurrent_metrics m
      WHERE m.sampled_at >= datetime('now', ?)
      ORDER BY m.sampled_at ASC
    `)
    .all(args.cohort, args.takeoffLiveSource, `-${lookbackDays + replayDays} days`);
  for (const row of rows) {
    row.sampledAtMs = Date.parse(row.sampledAt);
  }
  const replayStartMs = Date.now() - replayDays * 24 * 60 * 60 * 1000;
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const options = {
    takeoffWindowMinutes: args.takeoffWindowMinutes,
    takeoffRateMinSamples: null,
    takeoffRateMinDays: null,
    takeoffRateLookbackDays: lookbackDays,
    takeoffLiveSource: args.takeoffLiveSource,
  };
  const slots = rows.filter((row) => row.sampledAtMs >= replayStartMs);
  const fired = [];
  const zValues = [];
  let readySlots = 0;
  let lowerIndex = 0;
  let upperIndex = 0;
  for (const slot of slots) {
    // Live detection suppresses takeoff scoring on non-live slots
    // (stale_live); the replay mirrors that.
    if (Number(slot.liveIngested) !== 1) {
      continue;
    }
    const window = getTakeoffWindow(slot.sampledAt, args.takeoffWindowMinutes);
    const windowStartMs = Date.parse(window.windowStart);
    while (upperIndex < rows.length && rows[upperIndex].sampledAtMs < windowStartMs) {
      upperIndex += 1;
    }
    while (lowerIndex < rows.length && rows[lowerIndex].sampledAtMs < windowStartMs - lookbackMs) {
      lowerIndex += 1;
    }
    const stats = buildTakeoffBaseline(rows.slice(lowerIndex, upperIndex), window, options);
    if (!stats.modelReady) {
      continue;
    }
    readySlots += 1;
    // Live-process events sit exactly on slot timestamps, so the window
    // count ending at this slot is the slot's own live count.
    const count = Number(slot.takeoffCount || 0);
    const z = (count - stats.expectedTakeoffCount) / stats.effectiveTakeoffStdDev;
    zValues.push(z);
    if (count >= args.takeoffRateMinCount && z >= args.takeoffRateZScore) {
      fired.push({
        sampledAt: slot.sampledAt,
        count,
        expected: +stats.expectedTakeoffCount.toFixed(1),
        sigma: +stats.effectiveTakeoffStdDev.toFixed(1),
        z: +z.toFixed(2),
        severity: takeoffSeverityForZScore(z),
        tier: stats.baselineTier,
      });
    }
  }
  zValues.sort((left, right) => left - right);
  const quantileOf = (fraction) => (zValues.length ? +zValues[Math.min(zValues.length - 1, Math.floor(fraction * zValues.length))].toFixed(2) : null);
  return {
    replayedDays: args.takeoffDays,
    slots: slots.length,
    readySlots,
    zQuantiles: { p50: quantileOf(0.5), p90: quantileOf(0.9), p99: quantileOf(0.99), max: quantileOf(1) },
    firedCount: fired.length,
    severityFrequency: tally(fired.map((event) => event.severity)),
    fired: fired.slice(0, 20),
  };
}

// Synthetic acceptance test: multiply the trailing hour's concurrent counts
// (in memory) and check the model reads it as a level-5 alarm within 60
// minutes, plus that CUSUM starts accumulating.
function injectExodus(rows, args) {
  const injectedSlotCount = Math.max(1, Math.round(60 / Math.max(1, args.takeoffWindowMinutes)));
  const injected = rows.map((row, index) => (
    index >= rows.length - injectedSlotCount
      ? { ...row, concurrentCount: Math.round(Number(row.concurrentCount) * args.injectFactor) }
      : { ...row }
  ));
  const context = scoreConcurrent(injected);
  const injectedRecords = context.records.slice(-injectedSlotCount);
  let cusumS = 0;
  for (const record of context.records) {
    cusumS = cusumStep(cusumS, record.sigmaShift, args.cusumK);
  }
  const firstCritical = injectedRecords.find((record) => record.emergencyLevel >= 5);
  return {
    injectFactor: args.injectFactor,
    injectedSlots: injectedSlotCount,
    records: injectedRecords.map((record) => ({
      sampledAt: record.sampledAt,
      concurrentCount: record.concurrentCount,
      expected: Math.round(record.expectedConcurrentCount || 0),
      sigmaShift: +Number(record.sigmaShift || 0).toFixed(2),
      emergencyLevel: record.emergencyLevel,
      alertLevel: record.alertLevel,
      modelReady: record.modelReady,
    })),
    criticalWithin60Min: Boolean(firstCritical),
    firstCriticalAt: firstCritical?.sampledAt ?? null,
    cusumAfterInjection: +cusumS.toFixed(2),
  };
}

// The instrument's alarm limits, made executable (bounds documented with
// rationale in OPERATIONS.md "Instrument bounds"). Rates are normalized to
// the replayed span so the same limits hold as history deepens. Any
// violation exits non-zero, which the nightly selftest timer surfaces
// through status.js -> ops watchdog: if data drift or a code change pushes
// the detector out of spec, the box pages a human within a day.
function assertBounds(report, args) {
  const cusumDays = report.cusum.scoredSlots / 48;
  const concurrentDays = report.concurrent.scoredDays || 1;
  const cusumCriticals = report.cusum.crossings.filter((c) => c.severity === 'critical').length;
  const bounds = [
    {
      name: 'injected 3x exodus fires critical within 60 min',
      ok: !args.injectExodus || report.injectedExodus.criticalWithin60Min === true,
    },
    {
      name: 'takeoff replay: zero critical fires on real history',
      ok: !(report.takeoffRate.severityFrequency.critical > 0),
    },
    {
      name: `takeoff replay: fired ${report.takeoffRate.firedCount} <= 0.2/day noise budget`,
      ok: report.takeoffRate.firedCount <= Math.ceil(args.takeoffDays * 0.2),
    },
    {
      name: `takeoff replay: ${report.takeoffRate.readySlots} scoreable slots >= 336 (instrument warm)`,
      ok: report.takeoffRate.readySlots >= 336,
    },
    {
      name: `cusum: ${report.cusum.crossingCount} crossings <= 1.5/30d`,
      ok: report.cusum.crossingCount <= Math.ceil(cusumDays / 20),
    },
    {
      name: `cusum: ${cusumCriticals} critical crossings <= 0.5/30d`,
      ok: cusumCriticals <= Math.ceil(cusumDays / 60),
    },
    {
      name: `concurrent: ${report.concurrent.level5Days} level-5 days <= 1/30d`,
      ok: report.concurrent.level5Days <= Math.ceil(concurrentDays / 30),
    },
    {
      name: `concurrent: ${report.concurrent.level4PlusDays} level>=4 days <= 2/30d`,
      ok: report.concurrent.level4PlusDays <= Math.ceil(concurrentDays / 15),
    },
  ];
  return { passed: bounds.every((bound) => bound.ok), bounds };
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(path.resolve(args.db), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    const rows = loadConcurrentRows(db);
    const context = scoreConcurrent(rows);
    const report = {
      ok: true,
      cohort: args.cohort,
      db: path.resolve(args.db),
      historyStart: rows[0]?.sampledAt ?? null,
      historyEnd: rows[rows.length - 1]?.sampledAt ?? null,
      historySlots: rows.length,
      concurrent: concurrentReplay(context),
      cusum: cusumReplay(context, args),
      takeoffRate: takeoffReplay(db, args),
      injectedExodus: args.injectExodus ? injectExodus(rows, args) : null,
    };
    if (args.assert) {
      report.assert = assertBounds(report, args);
      report.ok = report.assert.passed;
    }
    console.log(JSON.stringify(report, null, 2));
    if (args.assert && !report.assert.passed) {
      process.exit(2);
    }
  } finally {
    db.close();
  }
}

main();
