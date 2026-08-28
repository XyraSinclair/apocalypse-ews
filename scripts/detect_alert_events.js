#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_TAKEOFF_RATE_MIN_DAYS = 7;
const DEFAULT_CONCURRENT_MIN_HISTORY_SAMPLES = 7 * 48;

function envNumber(name, fallback = null) {
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
}

function parseArgs(argv) {
  const args = {
    db: null,
    snapshot: null,
    cohort: null,
    eventsDb: null,
    anomalyLevel: Number(process.env.EWS_ANOMALY_ALERT_LEVEL || 5),
    takeoffBatchMin: Number(process.env.EWS_TAKEOFF_BATCH_MIN || 3),
    takeoffAnomalyLevel: Number(process.env.EWS_TAKEOFF_ANOMALY_LEVEL || 4),
    takeoffWindowMinutes: Number(process.env.EWS_TAKEOFF_WINDOW_MINUTES || 30),
    takeoffRateLookbackDays: Number(process.env.EWS_TAKEOFF_RATE_LOOKBACK_DAYS || 28),
    takeoffRateMinSamples: envNumber('EWS_TAKEOFF_RATE_MIN_SAMPLES'),
    takeoffRateMinDays: envNumber('EWS_TAKEOFF_RATE_MIN_DAYS', DEFAULT_TAKEOFF_RATE_MIN_DAYS),
    takeoffRateMinCount: Number(process.env.EWS_TAKEOFF_RATE_MIN_COUNT || 3),
    takeoffRateZScore: Number(process.env.EWS_TAKEOFF_RATE_Z_SCORE || 3.5),
    // The takeoff-rate detector counts one consistent process: ground->air
    // transitions seen by the live slot ingester. Trace-backfilled events
    // (source adsbx_history, ~45x denser) must never enter the numerator or
    // the baseline, or every repair pass that touches the current window
    // manufactures a false critical.
    takeoffLiveSource: process.env.EWS_TAKEOFF_LIVE_SOURCE || 'adsbx_heatmap',
    cusumK: Number(process.env.EWS_CUSUM_K || 0.5),
    cusumThreshold: Number(process.env.EWS_CUSUM_THRESHOLD || 8),
    cusumCritical: Number(process.env.EWS_CUSUM_CRITICAL || 12),
    dataQualityMinRatio: Number(process.env.EWS_DATA_QUALITY_MIN_RATIO || 0.6),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--events-db') {
      args.eventsDb = argv[++index];
    } else if (value === '--snapshot') {
      args.snapshot = argv[++index];
    } else if (value === '--cohort') {
      args.cohort = argv[++index];
    } else if (value === '--anomaly-level') {
      args.anomalyLevel = Number(argv[++index]);
    } else if (value === '--takeoff-batch-min') {
      args.takeoffBatchMin = Number(argv[++index]);
    } else if (value === '--takeoff-anomaly-level') {
      args.takeoffAnomalyLevel = Number(argv[++index]);
    } else if (value === '--takeoff-window-minutes') {
      args.takeoffWindowMinutes = Number(argv[++index]);
    } else if (value === '--takeoff-rate-lookback-days') {
      args.takeoffRateLookbackDays = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-samples') {
      args.takeoffRateMinSamples = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-count') {
      args.takeoffRateMinCount = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-days') {
      args.takeoffRateMinDays = Number(argv[++index]);
    } else if (value === '--takeoff-rate-z-score') {
      args.takeoffRateZScore = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!args.db || !args.snapshot || !args.cohort) {
    throw new Error('Usage: node scripts/detect_alert_events.js --db path [--events-db path] --snapshot path --cohort id');
  }

  args.eventsDb ||= args.db;

  return args;
}

function loadSnapshot(snapshotPath) {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function finiteNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
function hasReadyConcurrentBaseline(snapshot) {
  const current = snapshot.current || {};
  const composite = snapshot.signals?.composite || {};
  const explicitModelReady = composite.modelReady ?? current.modelReady;
  const sampleCount = finiteNumber(
    composite.weeklyBaselineSampleCount ??
      composite.baselineHistorySampleCount ??
      current.weeklyBaselineSampleCount ??
      current.baselineHistorySampleCount ??
      composite.historySampleCount ??
      current.historySampleCount,
    0,
  );
  const requiredSampleCount = Math.max(
    1,
    finiteNumber(
      composite.requiredHistorySampleCount ?? current.requiredHistorySampleCount,
      DEFAULT_CONCURRENT_MIN_HISTORY_SAMPLES,
    ),
  );
  return {
    ready: explicitModelReady === true && sampleCount >= requiredSampleCount,
    modelReady: explicitModelReady === true,
    sampleCount,
    requiredSampleCount,
  };
}


function parseIso(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} is not a valid ISO timestamp: ${value}`);
  }
  return parsed;
}

function isoOffset(value, offsetMs) {
  return new Date(parseIso(value, 'timestamp').getTime() + offsetMs).toISOString();
}

function medianOf(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median + MAD-derived sigma: a past anomaly in the lookback cannot drag the
// baseline the way it drags a plain mean/stddev. Sigma is floored at the
// Poisson noise floor sqrt(median) and at 1 so near-constant groups cannot
// produce runaway z-scores.
function robustStats(values) {
  const median = medianOf(values);
  const mad = medianOf(values.map((value) => Math.abs(value - median)));
  const rawSigma = 1.4826 * mad;
  return {
    median,
    rawSigma,
    sigma: Math.max(rawSigma, Math.sqrt(Math.max(median, 1)), 1),
    sampleCount: values.length,
  };
}

function formatDecimal(value, digits = 1) {
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function takeoffSeverityForZScore(zScore) {
  if (zScore >= 6) return 'critical';
  if (zScore >= 4.5) return 'high';
  return 'elevated';
}

function getTakeoffWindow(observedAt, windowMinutes) {
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60 * 1000;
  const windowEnd = parseIso(observedAt, 'observedAt');
  const windowStart = new Date(windowEnd.getTime() - windowMs);
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs,
    windowMinutes: Math.round(windowMs / 60000),
  };
}

function defaultTakeoffRateMinSamples(windowMinutes) {
  const safeWindowMinutes = Math.max(1, Number(windowMinutes) || 30);
  return Math.ceil((DEFAULT_TAKEOFF_RATE_MIN_DAYS * 24 * 60) / safeWindowMinutes);
}

function severityForLevel(level) {
  if (level >= 5) return 'critical';
  if (level >= 4) return 'high';
  if (level >= 3) return 'elevated';
  return 'watch';
}

function findExistingEvent(db, event) {
  return db
    .prepare(`
      SELECT id, event_key AS eventKey, status
      FROM alert_events
      WHERE event_key = @eventKey
         OR (kind = @kind AND cohort = @cohort AND occurred_at = @occurredAt)
      ORDER BY CASE WHEN event_key = @eventKey THEN 0 ELSE 1 END
      LIMIT 1
    `)
    .get(event);
}

function updateExistingEvent(db, existing, event) {
  if (!existing) {
    return;
  }

  db.prepare(`
    UPDATE alert_events
    SET
      event_key = @eventKey,
      severity = @severity,
      title = @title,
      message = @message,
      payload_json = @payloadJson,
      status = CASE
        WHEN status IN ('processing', 'sent', 'no_recipients', 'partial', 'failed') THEN status
        ELSE @status
      END
    WHERE id = @id
  `).run({ ...event, id: existing.id });
}

function insertAlertEvent(db, event) {
  const existing = findExistingEvent(db, event);
  if (existing) {
    updateExistingEvent(db, existing, event);
    return false;
  }

  db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status
    ) VALUES (
      @kind,
      @severity,
      @cohort,
      @eventKey,
      @occurredAt,
      @title,
      @message,
      @payloadJson,
      @status
    )
  `).run(event);
  return true;
}

function getTakeoffEvents(db, cohort, observedAt, windowMinutes, liveSource) {
  const window = getTakeoffWindow(observedAt, windowMinutes);
  const rows = db
    .prepare(`
      SELECT
        id,
        hex,
        registration,
        label,
        observed_at AS observedAt,
        previous_observed_at AS previousObservedAt,
        lat,
        lon,
        altitude_ft AS altitudeFt,
        ground_speed_kt AS groundSpeedKt
      FROM takeoff_events
      WHERE cohort = ?
        AND source = ?
        AND CAST(strftime('%s', observed_at) AS INTEGER) > CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', observed_at) AS INTEGER) <= CAST(strftime('%s', ?) AS INTEGER)
      ORDER BY observed_at DESC, label ASC
    `)
    .all(cohort, liveSource, window.windowStart, window.windowEnd);
  const byHex = new Map();
  for (const row of rows) {
    if (!byHex.has(row.hex)) {
      byHex.set(row.hex, row);
    }
  }
  return {
    ...window,
    takeoffs: Array.from(byHex.values()).sort((left, right) => {
      const leftLabel = left.label || left.registration || left.hex;
      const rightLabel = right.label || right.registration || right.hex;
      return leftLabel.localeCompare(rightLabel);
    }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TAKEOFF_BASELINE_MIN_GROUP_SAMPLES = 6;

function takeoffDayClass(utcDay) {
  return utcDay === 0 || utcDay === 6 ? 'weekend' : 'weekday';
}

// Databases created before the provenance table (or opened read-only where
// schema.sql cannot run) simply have no provenance — the model then treats
// every slot as unknown-provenance, which is the pre-provenance behavior.
function hasIngestSlotsTable(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_slots'").get(),
  );
}

// Seasonal robust baseline for the live takeoff-rate process. Windows are
// grouped by (weekday-vs-weekend, slot-of-day) so a normal morning wave is
// compared against other mornings, not against the flat 24h average that made
// every busy morning read hot. Group statistics are median/MAD (robustStats).
// Tier ladder when a group is thin: (dayClass, slot) -> slot across all days
// -> global.
function getTakeoffRateStats(db, cohort, observedAt, options) {
  const window = getTakeoffWindow(observedAt, options.takeoffWindowMinutes);
  const lookbackStart = isoOffset(window.windowStart, -Math.max(1, options.takeoffRateLookbackDays) * DAY_MS);
  const slotSourceSelect = hasIngestSlotsTable(db)
    ? '(SELECT s.source FROM ingest_slots s WHERE s.sampled_at = m.sampled_at)'
    : 'NULL';
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
        ${slotSourceSelect} AS slotSource
      FROM concurrent_metrics m
      WHERE CAST(strftime('%s', m.sampled_at) AS INTEGER) >= CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', m.sampled_at) AS INTEGER) < CAST(strftime('%s', ?) AS INTEGER)
      ORDER BY m.sampled_at ASC
    `)
    .all(cohort, options.takeoffLiveSource, lookbackStart, window.windowStart);

  // Slots known to come from trace backfill carry a structural zero for the
  // live process — excluding them keeps repaired outages from dragging the
  // baseline down. Slots with no provenance row (pre-provenance history) are
  // kept; robust group stats tolerate the residual contamination.
  const usableRows = rows.filter((row) => !row.slotSource || row.slotSource === options.takeoffLiveSource);

  const bucketCounts = new Map();
  for (const row of usableRows) {
    const bucket = Math.floor(parseIso(row.sampledAt, 'sampledAt').getTime() / window.windowMs);
    bucketCounts.set(bucket, Number(bucketCounts.get(bucket) || 0) + Number(row.takeoffCount || 0));
  }

  const groups = new Map();
  const slotGroups = new Map();
  const allCounts = [];
  for (const [bucket, count] of bucketCounts) {
    const bucketStart = new Date(bucket * window.windowMs);
    const slotOfDay = Math.floor((bucket * window.windowMs) % DAY_MS / window.windowMs);
    const groupKey = `${takeoffDayClass(bucketStart.getUTCDay())}:${slotOfDay}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(count);
    if (!slotGroups.has(slotOfDay)) {
      slotGroups.set(slotOfDay, []);
    }
    slotGroups.get(slotOfDay).push(count);
    allCounts.push(count);
  }

  const windowStartDate = parseIso(window.windowStart, 'windowStart');
  const windowBucket = Math.floor(windowStartDate.getTime() / window.windowMs);
  const windowSlotOfDay = Math.floor((windowBucket * window.windowMs) % DAY_MS / window.windowMs);
  const windowDayClass = takeoffDayClass(windowStartDate.getUTCDay());
  const windowGroupKey = `${windowDayClass}:${windowSlotOfDay}`;

  let baselineTier = 'day_class_slot';
  let baselineValues = groups.get(windowGroupKey) || [];
  if (baselineValues.length < TAKEOFF_BASELINE_MIN_GROUP_SAMPLES) {
    baselineTier = 'slot';
    baselineValues = slotGroups.get(windowSlotOfDay) || [];
  }
  if (baselineValues.length < TAKEOFF_BASELINE_MIN_GROUP_SAMPLES) {
    baselineTier = 'global';
    baselineValues = allCounts;
  }
  const baselineStats = robustStats(baselineValues);

  const sampleDays = new Set(usableRows.map((row) => parseIso(row.sampledAt, 'sampledAt').toISOString().slice(0, 10)));
  const requiredSampleCount = Math.max(
    defaultTakeoffRateMinSamples(options.takeoffWindowMinutes),
    Number(options.takeoffRateMinSamples) || 0,
    1,
  );
  const requiredDayCount = Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(Number(options.takeoffRateLookbackDays) || 1)),
      Math.floor(Number(options.takeoffRateMinDays) || DEFAULT_TAKEOFF_RATE_MIN_DAYS),
    ),
  );
  const modelReady = allCounts.length >= requiredSampleCount && sampleDays.size >= requiredDayCount;
  return {
    model: 'takeoff-rate-seasonal-robust',
    modelReady,
    sampleCount: allCounts.length,
    sampleDayCount: sampleDays.size,
    requiredSampleCount,
    requiredDayCount,
    lookbackStart,
    lookbackDays: options.takeoffRateLookbackDays,
    expectedTakeoffCount: baselineStats.median,
    takeoffStdDev: baselineStats.rawSigma,
    effectiveTakeoffStdDev: baselineStats.sigma,
    baselineTier,
    baselineDayClass: windowDayClass,
    baselineSlotOfDay: windowSlotOfDay,
    baselineGroupSampleCount: baselineStats.sampleCount,
    excludedRepairedSlots: rows.length - usableRows.length,
  };
}

// L0 data-quality gate. The live ingester records how many aircraft the
// global feed carried in each slot (ingest_slots.total_aircraft) — a
// cohort-independent denominator. A collapsed feed shrinks every count, and
// the statistical layers would read that infrastructure failure as an
// anomaly (or mask a real one), so detection is suppressed instead and the
// degradation is surfaced as its own event.
//
// Statuses:
//   ok         - current slot is live and the feed volume is normal
//   degraded   - current slot is live but the feed carried under
//                dataQualityMinRatio x the recent same-slot median
//   stale_live - current slot came from trace backfill (live ingester did
//                not run); the takeoff-rate process has no data
//   unknown    - no provenance row (pre-provenance history); proceed
function getDataQuality(db, observedAt, options) {
  if (!hasIngestSlotsTable(db)) {
    return { status: 'unknown', liveSlot: false };
  }
  const windowMs = Math.max(1, Number(options.takeoffWindowMinutes) || 30) * 60 * 1000;
  const slotOf = (value) => Math.floor((parseIso(value, 'sampledAt').getTime() % DAY_MS) / windowMs);
  const current = db
    .prepare(`
      SELECT source, total_aircraft AS totalAircraft
      FROM ingest_slots
      WHERE CAST(strftime('%s', sampled_at) AS INTEGER) = CAST(strftime('%s', ?) AS INTEGER)
    `)
    .get(observedAt);
  if (!current) {
    return { status: 'unknown', liveSlot: false };
  }
  if (current.source !== options.takeoffLiveSource) {
    return { status: 'stale_live', liveSlot: false, slotSource: current.source };
  }

  const lookbackStart = isoOffset(observedAt, -14 * DAY_MS);
  const referenceRows = db
    .prepare(`
      SELECT sampled_at AS sampledAt, total_aircraft AS totalAircraft
      FROM ingest_slots
      WHERE source = ?
        AND total_aircraft IS NOT NULL
        AND CAST(strftime('%s', sampled_at) AS INTEGER) >= CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', sampled_at) AS INTEGER) < CAST(strftime('%s', ?) AS INTEGER)
    `)
    .all(options.takeoffLiveSource, lookbackStart, observedAt);
  const currentSlot = slotOf(observedAt);
  const reference = referenceRows
    .filter((row) => slotOf(row.sampledAt) === currentSlot)
    .map((row) => Number(row.totalAircraft));
  const referenceMedian = medianOf(reference);
  const base = {
    liveSlot: true,
    currentTotal: Number(current.totalAircraft),
    referenceMedian,
    referenceCount: reference.length,
    minRatio: options.dataQualityMinRatio,
  };
  if (
    reference.length >= 8 &&
    Number.isFinite(base.currentTotal) &&
    base.currentTotal < options.dataQualityMinRatio * referenceMedian
  ) {
    return { ...base, status: 'degraded' };
  }
  return { ...base, status: 'ok' };
}

// Sustained-shift detector: one-sided CUSUM over the concurrent model's
// sigma-shift, S <- max(0, S + clamp(z) - k). A slow exodus that never
// spikes past the instantaneous alarm threshold still accumulates here.
// State persists in meta so it survives process restarts; the step only
// advances when the sample timestamp advances, so re-runs are idempotent.
// Crossing cusumThreshold fires once (high), cusumCritical escalates once
// (critical); both re-arm after S falls below half the threshold.
// The pure accumulation law, shared with the backtest harness. The input
// shift is clamped so a single wild sample cannot teleport the accumulator.
function cusumStep(previousS, sigmaShift, k) {
  const clampedShift = Math.max(-4, Math.min(8, finiteNumber(sigmaShift)));
  return Math.max(0, finiteNumber(previousS) + clampedShift - k);
}

function updateCusumState(db, cohort, occurredAt, sigmaShift, options) {
  const key = `cusum_state:${cohort}`;
  let state = { s: 0, lastSampledAt: null, armedHigh: true, armedCritical: true };
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (row) {
    try {
      state = { ...state, ...JSON.parse(row.value) };
    } catch {
      // Corrupt state resets to a fresh accumulator rather than crashing detection.
    }
  }
  const nowMs = parseIso(occurredAt, 'occurredAt').getTime();
  const lastMs = state.lastSampledAt ? Date.parse(state.lastSampledAt) : null;
  if (Number.isFinite(lastMs) && nowMs <= lastMs) {
    return { state, advanced: false, crossings: [] };
  }

  const nextS = cusumStep(state.s, sigmaShift, options.cusumK);
  const crossings = [];
  let armedHigh = state.armedHigh !== false;
  let armedCritical = state.armedCritical !== false;
  if (armedCritical && nextS >= options.cusumCritical) {
    crossings.push('critical');
    armedCritical = false;
    armedHigh = false;
  } else if (armedHigh && nextS >= options.cusumThreshold) {
    crossings.push('high');
    armedHigh = false;
  }
  if (nextS < options.cusumThreshold / 2) {
    armedHigh = true;
    armedCritical = true;
  }
  const nextState = { s: nextS, lastSampledAt: occurredAt, armedHigh, armedCritical };
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(nextState));
  return { state: nextState, advanced: true, crossings };
}

function compactAircraftList(takeoffs) {
  const sample = [];
  const seen = new Set();
  for (const event of takeoffs) {
    const identifier = event.registration || event.hex.toUpperCase();
    const label = event.label && event.label !== identifier ? event.label : null;
    const aircraft = [identifier, label].filter(Boolean).join(' · ');
    if (seen.has(aircraft)) {
      continue;
    }
    seen.add(aircraft);
    sample.push(aircraft);
    if (sample.length >= 10) {
      break;
    }
  }
  return sample;
}

function buildEvents({
  db,
  snapshot,
  cohort,
  anomalyLevel,
  takeoffBatchMin,
  takeoffAnomalyLevel,
  takeoffWindowMinutes,
  takeoffRateLookbackDays,
  takeoffRateMinSamples,
  takeoffRateMinDays,
  takeoffRateMinCount,
  takeoffRateZScore,
  takeoffLiveSource,
  cusumK,
  cusumThreshold,
  cusumCritical,
  dataQualityMinRatio,
}) {
  const occurredAt = snapshot.current?.asOf || snapshot.liveStatus?.latestSampledAt;
  if (!occurredAt) {
    throw new Error(`Snapshot for ${cohort} does not include an observation time.`);
  }

  const emergencyLevel = Math.round(finiteNumber(snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel, 1));
  const concurrentCount = finiteNumber(snapshot.current?.concurrentCount);
  const expectedCount = finiteNumber(snapshot.current?.baselineMean ?? snapshot.signals?.composite?.expectedConcurrentCount);
  const zScore = finiteNumber(snapshot.current?.zScore ?? snapshot.signals?.composite?.sigmaShift);
  const concurrentBaseline = hasReadyConcurrentBaseline(snapshot);
  const dataQuality = getDataQuality(db, occurredAt, { takeoffWindowMinutes, takeoffLiveSource, dataQualityMinRatio });
  // degraded: the feed itself collapsed — every statistical layer is blind,
  // suppress them all and surface the degradation instead.
  // stale_live: the live ingester did not produce the current slot, so only
  // the takeoff-rate process (which is defined by that ingester) is mute;
  // the concurrent model still sees real counts from the trace backfill.
  const feedDegraded = dataQuality.status === 'degraded';
  const takeoffScoringActive = !feedDegraded && dataQuality.status !== 'stale_live';
  const takeoffWindow = getTakeoffEvents(db, cohort, occurredAt, takeoffWindowMinutes, takeoffLiveSource);
  const takeoffs = takeoffWindow.takeoffs;
  const takeoffRateStats = getTakeoffRateStats(db, cohort, occurredAt, {
    takeoffWindowMinutes,
    takeoffRateLookbackDays,
    takeoffRateMinSamples,
    takeoffRateMinDays,
    takeoffLiveSource,
  });
  const takeoffRateZ = (takeoffs.length - takeoffRateStats.expectedTakeoffCount) / takeoffRateStats.effectiveTakeoffStdDev;
  const aircraft = compactAircraftList(takeoffs);
  const events = [];

  if (feedDegraded) {
    events.push({
      kind: 'data_quality',
      severity: 'watch',
      cohort,
      eventKey: `data_quality:${cohort}:${occurredAt}`,
      occurredAt,
      title: 'Ingest feed degraded — detection suppressed for this slot',
      message: `The upstream feed carried ${Math.round(dataQuality.currentTotal).toLocaleString()} aircraft vs a recent same-slot median of ${Math.round(dataQuality.referenceMedian).toLocaleString()}; anomaly scoring for ${cohort} is suppressed until feed volume recovers.`,
      payloadJson: JSON.stringify({
        signalFamily: 'data_quality',
        cohort,
        occurredAt,
        currentTotal: dataQuality.currentTotal,
        referenceMedian: dataQuality.referenceMedian,
        referenceCount: dataQuality.referenceCount,
        minRatio: dataQuality.minRatio,
      }),
      status: 'observed',
    });
  }

  if (takeoffs.length >= takeoffBatchMin) {
    events.push({
      kind: 'takeoff_batch',
      severity: 'watch',
      cohort,
      eventKey: `takeoff_batch:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} tracked aircraft became airborne`,
      message: `${takeoffs.length} tracked aircraft in ${cohort} became airborne within ${takeoffWindow.windowMinutes} minutes ending ${occurredAt}.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_batch',
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        takeoffCount: takeoffs.length,
        aircraft,
      }),
      status: 'observed',
    });
  }

  if (
    takeoffScoringActive &&
    takeoffRateStats.modelReady &&
    takeoffs.length >= takeoffRateMinCount &&
    takeoffRateZ >= takeoffRateZScore
  ) {
    events.push({
      kind: 'takeoff_rate_anomaly',
      severity: takeoffSeverityForZScore(takeoffRateZ),
      cohort,
      eventKey: `takeoff_rate_anomaly:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} takeoffs vs ${formatDecimal(takeoffRateStats.expectedTakeoffCount)} expected`,
      message: `${cohort} produced ${takeoffs.length} takeoffs within ${takeoffWindow.windowMinutes} minutes, ${formatDecimal(takeoffRateZ)}σ above its recent takeoff-rate baseline.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_rate',
        model: takeoffRateStats.model,
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        takeoffCount: takeoffs.length,
        expectedTakeoffCount: takeoffRateStats.expectedTakeoffCount,
        takeoffStdDev: takeoffRateStats.takeoffStdDev,
        effectiveTakeoffStdDev: takeoffRateStats.effectiveTakeoffStdDev,
        baselineTier: takeoffRateStats.baselineTier,
        baselineDayClass: takeoffRateStats.baselineDayClass,
        baselineSlotOfDay: takeoffRateStats.baselineSlotOfDay,
        baselineGroupSampleCount: takeoffRateStats.baselineGroupSampleCount,
        takeoffRateZScore: takeoffRateZ,
        takeoffRateZScoreThreshold: takeoffRateZScore,
        takeoffRateMinCount,
        sampleCount: takeoffRateStats.sampleCount,
        sampleDayCount: takeoffRateStats.sampleDayCount,
        requiredSampleCount: takeoffRateStats.requiredSampleCount,
        requiredDayCount: takeoffRateStats.requiredDayCount,
        lookbackStart: takeoffRateStats.lookbackStart,
        lookbackDays: takeoffRateStats.lookbackDays,
        aircraft,
      }),
      status: 'pending',
    });
  }

  if (!feedDegraded && concurrentBaseline.ready && emergencyLevel >= anomalyLevel) {
    events.push({
      kind: 'statistical_anomaly',
      severity: severityForLevel(emergencyLevel),
      cohort,
      eventKey: `statistical_anomaly:${cohort}:${occurredAt}`,
      occurredAt,
      title: `Emergency level ${emergencyLevel} aircraft activity anomaly`,
      message: `${cohort} reached emergency level ${emergencyLevel}: ${Math.round(concurrentCount).toLocaleString()} airborne vs ${Math.round(expectedCount).toLocaleString()} expected.`,
      payloadJson: JSON.stringify({
        signalFamily: 'concurrent_count',
        cohort,
        occurredAt,
        emergencyLevel,
        concurrentCount,
        expectedCount,
        zScore,
        concurrentModelReady: concurrentBaseline.modelReady,
        concurrentSampleCount: concurrentBaseline.sampleCount,
        concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
      }),
      status: 'pending',
    });
  }

  if (!feedDegraded && concurrentBaseline.ready && takeoffs.length >= takeoffBatchMin && emergencyLevel >= takeoffAnomalyLevel) {
    events.push({
      kind: 'takeoff_anomaly',
      severity: severityForLevel(emergencyLevel),
      cohort,
      eventKey: `takeoff_anomaly:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} takeoffs during emergency level ${emergencyLevel}`,
      message: `${takeoffs.length} tracked aircraft became airborne while ${cohort} was at emergency level ${emergencyLevel}.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_during_concurrent_anomaly',
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        emergencyLevel,
        takeoffCount: takeoffs.length,
        concurrentCount,
        expectedCount,
        zScore,
        concurrentModelReady: concurrentBaseline.modelReady,
        concurrentSampleCount: concurrentBaseline.sampleCount,
        concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
        aircraft,
      }),
      status: 'pending',
    });
  }

  let cusum = { state: null, advanced: false, crossings: [] };
  if (!feedDegraded && concurrentBaseline.ready) {
    cusum = updateCusumState(db, cohort, occurredAt, zScore, { cusumK, cusumThreshold, cusumCritical });
    for (const severity of cusum.crossings) {
      const threshold = severity === 'critical' ? cusumCritical : cusumThreshold;
      events.push({
        kind: 'sustained_shift',
        severity,
        cohort,
        eventKey: `sustained_shift:${cohort}:${severity}:${occurredAt}`,
        occurredAt,
        title: 'Sustained above-baseline aircraft activity',
        message: `${cohort} concurrent activity has stayed persistently above its baseline: cumulative deviation ${formatDecimal(cusum.state.s)} crossed ${formatDecimal(threshold)} (drift allowance ${formatDecimal(cusumK, 2)}σ per slot). A slow, sustained shift like this will not spike the instantaneous gauge.`,
        payloadJson: JSON.stringify({
          signalFamily: 'sustained_shift',
          cohort,
          occurredAt,
          cusum: cusum.state.s,
          cusumK,
          cusumThreshold,
          cusumCritical,
          sigmaShift: zScore,
          concurrentCount,
          expectedCount,
        }),
        status: 'pending',
      });
    }
  }

  return {
    events,
    dataQuality,
    cusum: cusum.state ? { s: cusum.state.s, advanced: cusum.advanced, crossings: cusum.crossings } : null,
    takeoffCount: takeoffs.length,
    takeoffRateZScore: takeoffRateZ,
    takeoffRateModelReady: takeoffRateStats.modelReady,
    takeoffRateSampleCount: takeoffRateStats.sampleCount,
    takeoffRateSampleDayCount: takeoffRateStats.sampleDayCount,
    takeoffRateRequiredSampleCount: takeoffRateStats.requiredSampleCount,
    takeoffRateRequiredDayCount: takeoffRateStats.requiredDayCount,
    concurrentModelReady: concurrentBaseline.modelReady,
    concurrentSampleCount: concurrentBaseline.sampleCount,
    concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
    emergencyLevel,
    occurredAt,
    windowStart: takeoffWindow.windowStart,
    windowEnd: takeoffWindow.windowEnd,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const sourceDbPath = path.resolve(args.db);
  const eventsDbPath = path.resolve(args.eventsDb);
  const sourceDb = new Database(sourceDbPath);
  const eventsDb = eventsDbPath === sourceDbPath ? sourceDb : new Database(eventsDbPath);
  sourceDb.pragma('busy_timeout = 30000');
  if (eventsDb !== sourceDb) {
    eventsDb.pragma('busy_timeout = 30000');
  }
  try {
    const schema = fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8');
    sourceDb.exec(schema);
    if (eventsDb !== sourceDb) {
      eventsDb.exec(schema);
    }
    const snapshot = loadSnapshot(path.resolve(args.snapshot));
    const result = buildEvents({ ...args, db: sourceDb, snapshot });
    const transaction = eventsDb.transaction((events) => events.filter((event) => insertAlertEvent(eventsDb, event)).length);
    const inserted = transaction(result.events);
    console.log(JSON.stringify({
      ok: true,
      cohort: args.cohort,
      occurredAt: result.occurredAt,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      emergencyLevel: result.emergencyLevel,
      takeoffCount: result.takeoffCount,
      takeoffRateModelReady: result.takeoffRateModelReady,
      takeoffRateSampleCount: result.takeoffRateSampleCount,
      takeoffRateSampleDayCount: result.takeoffRateSampleDayCount,
      takeoffRateRequiredSampleCount: result.takeoffRateRequiredSampleCount,
      takeoffRateRequiredDayCount: result.takeoffRateRequiredDayCount,
      takeoffRateZScore: result.takeoffRateZScore,
      dataQuality: result.dataQuality?.status,
      cusum: result.cusum,
      candidateEvents: result.events.length,
      insertedEvents: inserted,
      eventsDb: eventsDbPath,
    }));
  } finally {
    if (eventsDb !== sourceDb) {
      eventsDb.close();
    }
    sourceDb.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getTakeoffRateStats,
  getTakeoffEvents,
  getTakeoffWindow,
  getDataQuality,
  takeoffSeverityForZScore,
  severityForLevel,
  cusumStep,
  robustStats,
  medianOf,
  parseArgs,
};
