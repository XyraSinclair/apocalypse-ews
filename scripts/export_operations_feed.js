#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const MAIN_DB = process.env.EWS_DB_PATH || path.join(DATA_DIR, 'ews-main.sqlite');
const COHORT_DBS = [
  MAIN_DB,
  process.env.EWS_MILITARY_DB_PATH || path.join(DATA_DIR, 'ews-military.sqlite'),
  process.env.EWS_UNTRACKED_DB_PATH || path.join(DATA_DIR, 'ews-untracked.sqlite'),
];

function openReadonly(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function listAlertEvents(dbPath, limit) {
  const db = openReadonly(dbPath);
  if (!db) return [];
  try {
    return db
      .prepare(`
        SELECT
          id,
          kind,
          severity,
          cohort,
          event_key AS eventKey,
          occurred_at AS occurredAt,
          title,
          message,
          payload_json AS payloadJson,
          status,
          created_at AS createdAt,
          dispatched_at AS dispatchedAt,
          dispatch_summary_json AS dispatchSummaryJson
        FROM alert_events
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map((event) => ({
        stableId: `alert:${event.eventKey}`,
        ...event,
        payload: parseJsonField(event.payloadJson, null),
        payloadJson: undefined,
        dispatchSummary: parseJsonField(event.dispatchSummaryJson, null),
        dispatchSummaryJson: undefined,
      }));
  } finally {
    db.close();
  }
}

function listTakeoffEvents(dbPath, limit) {
  const db = openReadonly(dbPath);
  if (!db) return [];
  try {
    return db
      .prepare(`
        SELECT
          id,
          cohort,
          hex,
          registration,
          label,
          source,
          observed_at AS observedAt,
          previous_observed_at AS previousObservedAt,
          lat,
          lon,
          altitude_ft AS altitudeFt,
          ground_speed_kt AS groundSpeedKt,
          track,
          created_at AS createdAt
        FROM takeoff_events
        ORDER BY observed_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit);
  } finally {
    db.close();
  }
}

function writeFeed(fileName, events) {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PUBLISHED_DIR, fileName),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), events }, null, 2)}\n`,
  );
}

function main() {
  const alertLimit = Math.min(Math.max(Number(process.env.EWS_OPERATIONS_ALERT_LIMIT) || 100, 1), 500);
  const takeoffLimit = Math.min(Math.max(Number(process.env.EWS_OPERATIONS_TAKEOFF_LIMIT) || 500, 1), 2000);
  const alerts = listAlertEvents(MAIN_DB, alertLimit);
  const takeoffs = COHORT_DBS.flatMap((dbPath) => listTakeoffEvents(dbPath, takeoffLimit))
    .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)) || Number(right.id) - Number(left.id))
    .slice(0, takeoffLimit);
  writeFeed('alerts.json', alerts);
  writeFeed('takeoffs.json', takeoffs);
  console.log(JSON.stringify({ ok: true, alerts: alerts.length, takeoffs: takeoffs.length }));
}

main();
