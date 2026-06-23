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
    takeoffBatchMin: Number(process.env.EWS_TAKEOFF_BATCH_MIN || 1),
    takeoffAnomalyLevel: Number(process.env.EWS_TAKEOFF_ANOMALY_LEVEL || 4),
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

function severityForLevel(level) {
  if (level >= 5) return 'critical';
  if (level >= 4) return 'high';
  if (level >= 3) return 'elevated';
  return 'watch';
}

function eventExists(db, eventKey) {
  return Boolean(db.prepare('SELECT 1 FROM alert_events WHERE event_key = ?').get(eventKey));
}

function insertAlertEvent(db, event) {
  if (eventExists(db, event.eventKey)) {
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

function getTakeoffEvents(db, cohort, observedAt) {
  return db
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
        AND observed_at = ?
      ORDER BY label ASC
    `)
    .all(cohort, observedAt);
}

function compactAircraftList(takeoffs) {
  return takeoffs.slice(0, 10).map((event) => event.label || event.registration || event.hex.toUpperCase());
}

function buildEvents({ db, snapshot, cohort, anomalyLevel, takeoffBatchMin, takeoffAnomalyLevel }) {
  const occurredAt = snapshot.current?.asOf || snapshot.liveStatus?.latestSampledAt;
  if (!occurredAt) {
    throw new Error(`Snapshot for ${cohort} does not include an observation time.`);
  }

  const emergencyLevel = Math.round(finiteNumber(snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel, 1));
  const concurrentCount = finiteNumber(snapshot.current?.concurrentCount);
  const expectedCount = finiteNumber(snapshot.current?.baselineMean ?? snapshot.signals?.composite?.expectedConcurrentCount);
  const zScore = finiteNumber(snapshot.current?.zScore ?? snapshot.signals?.composite?.sigmaShift);
  const takeoffs = getTakeoffEvents(db, cohort, occurredAt);
  const events = [];

  if (takeoffs.length >= takeoffBatchMin) {
    events.push({
      kind: 'takeoff_batch',
      severity: 'watch',
      cohort,
      eventKey: `takeoff_batch:${cohort}:${occurredAt}`,
      occurredAt,
      title: `${takeoffs.length} tracked aircraft became airborne`,
      message: `${takeoffs.length} tracked aircraft in ${cohort} became airborne at ${occurredAt}.`,
      payloadJson: JSON.stringify({
        cohort,
        occurredAt,
        takeoffCount: takeoffs.length,
        aircraft: compactAircraftList(takeoffs),
      }),
      status: 'pending',
    });
  }

  if (emergencyLevel >= anomalyLevel) {
    events.push({
      kind: 'statistical_anomaly',
      severity: severityForLevel(emergencyLevel),
      cohort,
      eventKey: `statistical_anomaly:${cohort}:${occurredAt}:level${emergencyLevel}`,
      occurredAt,
      title: `Emergency level ${emergencyLevel} aircraft activity anomaly`,
      message: `${cohort} reached emergency level ${emergencyLevel}: ${Math.round(concurrentCount).toLocaleString()} airborne vs ${Math.round(expectedCount).toLocaleString()} expected.`,
      payloadJson: JSON.stringify({
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
      eventKey: `takeoff_anomaly:${cohort}:${occurredAt}:level${emergencyLevel}`,
      occurredAt,
      title: `${takeoffs.length} takeoffs during emergency level ${emergencyLevel}`, 
      message: `${takeoffs.length} tracked aircraft became airborne while ${cohort} was at emergency level ${emergencyLevel}.`,
      payloadJson: JSON.stringify({
        cohort,
        occurredAt,
        emergencyLevel,
        takeoffCount: takeoffs.length,
        concurrentCount,
        expectedCount,
        zScore,
        aircraft: compactAircraftList(takeoffs),
      }),
      status: 'pending',
    });
  }

  return { events, takeoffCount: takeoffs.length, emergencyLevel, occurredAt };
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
      emergencyLevel: result.emergencyLevel,
      takeoffCount: result.takeoffCount,
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
