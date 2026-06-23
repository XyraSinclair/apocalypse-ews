#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

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
    takeoffRateMinSamples: Number(process.env.EWS_TAKEOFF_RATE_MIN_SAMPLES || 48),
    takeoffRateMinCount: Number(process.env.EWS_TAKEOFF_RATE_MIN_COUNT || 3),
    takeoffRateZScore: Number(process.env.EWS_TAKEOFF_RATE_Z_SCORE || 3.5),
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

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values, average) {
  if (values.length < 2) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
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

function severityForLevel(level) {
  if (level >= 5) return 'critical';
  if (level >= 4) return 'high';
  if (level >= 3) return 'elevated';
  return 'watch';
}

function findExistingEvent(db, event) {
  return db
    .prepare(`
      SELECT id, event_key AS eventKey
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
      payload_json = @payloadJson
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

function getTakeoffEvents(db, cohort, observedAt, windowMinutes) {
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
        AND CAST(strftime('%s', observed_at) AS INTEGER) > CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', observed_at) AS INTEGER) <= CAST(strftime('%s', ?) AS INTEGER)
      ORDER BY observed_at DESC, label ASC
    `)
    .all(cohort, window.windowStart, window.windowEnd);
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

function getTakeoffRateStats(db, cohort, observedAt, options) {
  const window = getTakeoffWindow(observedAt, options.takeoffWindowMinutes);
  const lookbackStart = isoOffset(window.windowStart, -Math.max(1, options.takeoffRateLookbackDays) * 24 * 60 * 60 * 1000);
  const rows = db
    .prepare(`
      SELECT
        m.sampled_at AS sampledAt,
        COUNT(DISTINCT t.hex) AS takeoffCount
      FROM concurrent_metrics m
      LEFT JOIN takeoff_events t
        ON t.cohort = ?
       AND t.observed_at = m.sampled_at
      WHERE CAST(strftime('%s', m.sampled_at) AS INTEGER) >= CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', m.sampled_at) AS INTEGER) < CAST(strftime('%s', ?) AS INTEGER)
      GROUP BY m.sampled_at
      ORDER BY m.sampled_at ASC
    `)
    .all(cohort, lookbackStart, window.windowStart);
  const bucketCounts = new Map();
  for (const row of rows) {
    const bucket = Math.floor(parseIso(row.sampledAt, 'sampledAt').getTime() / window.windowMs);
    bucketCounts.set(bucket, Number(bucketCounts.get(bucket) || 0) + Number(row.takeoffCount || 0));
  }
  const counts = Array.from(bucketCounts.values());
  const expectedTakeoffCount = mean(counts);
  const takeoffStdDev = stdDev(counts, expectedTakeoffCount);
  const effectiveTakeoffStdDev = Math.max(takeoffStdDev, 1);
  const modelReady = counts.length >= Math.max(1, Number(options.takeoffRateMinSamples) || 1);
  return {
    model: 'takeoff-rate-window-baseline',
    modelReady,
    sampleCount: counts.length,
    lookbackStart,
    lookbackDays: options.takeoffRateLookbackDays,
    expectedTakeoffCount,
    takeoffStdDev,
    effectiveTakeoffStdDev,
  };
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
  takeoffRateMinCount,
  takeoffRateZScore,
}) {
  const occurredAt = snapshot.current?.asOf || snapshot.liveStatus?.latestSampledAt;
  if (!occurredAt) {
    throw new Error(`Snapshot for ${cohort} does not include an observation time.`);
  }

  const emergencyLevel = Math.round(finiteNumber(snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel, 1));
  const concurrentCount = finiteNumber(snapshot.current?.concurrentCount);
  const expectedCount = finiteNumber(snapshot.current?.baselineMean ?? snapshot.signals?.composite?.expectedConcurrentCount);
  const zScore = finiteNumber(snapshot.current?.zScore ?? snapshot.signals?.composite?.sigmaShift);
  const takeoffWindow = getTakeoffEvents(db, cohort, occurredAt, takeoffWindowMinutes);
  const takeoffs = takeoffWindow.takeoffs;
  const takeoffRateStats = getTakeoffRateStats(db, cohort, occurredAt, {
    takeoffWindowMinutes,
    takeoffRateLookbackDays,
    takeoffRateMinSamples,
  });
  const takeoffRateZ = (takeoffs.length - takeoffRateStats.expectedTakeoffCount) / takeoffRateStats.effectiveTakeoffStdDev;
  const aircraft = compactAircraftList(takeoffs);
  const events = [];

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
      status: 'pending',
    });
  }

  if (
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
        takeoffRateZScore: takeoffRateZ,
        takeoffRateZScoreThreshold: takeoffRateZScore,
        takeoffRateMinCount,
        sampleCount: takeoffRateStats.sampleCount,
        lookbackStart: takeoffRateStats.lookbackStart,
        lookbackDays: takeoffRateStats.lookbackDays,
        aircraft,
      }),
      status: 'pending',
    });
  }

  if (emergencyLevel >= anomalyLevel) {
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
      }),
      status: 'pending',
    });
  }

  if (takeoffs.length > 0 && emergencyLevel >= takeoffAnomalyLevel) {
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
        aircraft,
      }),
      status: 'pending',
    });
  }

  return {
    events,
    takeoffCount: takeoffs.length,
    takeoffRateZScore: takeoffRateZ,
    takeoffRateModelReady: takeoffRateStats.modelReady,
    takeoffRateSampleCount: takeoffRateStats.sampleCount,
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
      takeoffRateZScore: result.takeoffRateZScore,
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

main();
