#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const MAIN_DB = process.env.EWS_DB_PATH || path.join(DATA_DIR, 'ews-main.sqlite');
const RESEARCH_JSON = path.join(ROOT_DIR, 'localized_event_signal_research.json');

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function formatCluster(cluster) {
  if (!cluster?.center) return null;
  return {
    lat: Number(cluster.center.lat),
    lon: Number(cluster.center.lon),
    delta: Number(cluster.total_delta || 0),
    currentCount: Number(cluster.current_count || 0),
    baselineMedianCount: Number(cluster.baseline_median_count || 0),
  };
}

function distanceForResult(result) {
  const distances = result.distances_miles || {};
  if (result.phase === 'arrival') {
    return distances.landing_endpoint_top ?? distances.landing_top ?? null;
  }
  if (String(result.phase || '').includes('departure')) {
    return distances.takeoff_endpoint_top ?? distances.takeoff_top ?? null;
  }
  return distances.presence_top ?? null;
}

function recordsFromResearch() {
  if (!fs.existsSync(RESEARCH_JSON)) return [];
  const payload = JSON.parse(fs.readFileSync(RESEARCH_JSON, 'utf8'));
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((result) => ({
    id: `research:${result.key || result.event}:${result.phase}`,
    source: 'localized_event_signal_research',
    event: result.event,
    phase: result.phase,
    windowStart: result.local_start,
    windowEnd: result.local_end,
    timezone: result.timezone,
    label: result.classification?.label || 'Unclassified',
    method: result.classification?.primary_cluster_method || null,
    primaryCluster: formatCluster(result.classification?.primary_cluster),
    distanceMiles: distanceForResult(result),
    peakResidual: result.current_global_residual?.peak_residual ?? null,
    observedAircraft: result.current_observed_aircraft ?? null,
    takeoffEvents: result.current_takeoff_events ?? null,
    landingEvents: result.current_landing_events ?? null,
    provenance: result.source_note || 'Localized event signal research.',
  }));
}

function recordsFromLiveAlerts(limit) {
  if (!fs.existsSync(MAIN_DB)) return [];
  const db = new Database(MAIN_DB, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(`
        SELECT id, kind, severity, cohort, event_key AS eventKey, occurred_at AS occurredAt, title, message, payload_json AS payloadJson, status
        FROM alert_events
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map((event) => {
        const payload = parseJson(event.payloadJson, {});
        return {
          id: `alert:${event.eventKey}`,
          source: 'live_alert_event',
          event: event.title,
          phase: event.kind,
          windowStart: event.occurredAt,
          windowEnd: event.occurredAt,
          timezone: 'UTC',
          label: event.severity,
          method: 'refresh_pipeline_alert_event',
          primaryCluster: null,
          distanceMiles: null,
          peakResidual: payload.zScore ?? null,
          observedAircraft: payload.concurrentCount ?? null,
          takeoffEvents: payload.takeoffCount ?? null,
          landingEvents: null,
          provenance: `${event.cohort}: ${event.message}`,
          status: event.status,
          alertEventKey: event.eventKey,
        };
      });
  } finally {
    db.close();
  }
}

function main() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  const liveLimit = Math.min(Math.max(Number(process.env.EWS_EVENT_SIGNAL_LIVE_LIMIT) || 100, 1), 500);
  const records = [...recordsFromLiveAlerts(liveLimit), ...recordsFromResearch()];
  fs.writeFileSync(
    path.join(PUBLISHED_DIR, 'event-signals.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, records: records.length }));
}

main();
