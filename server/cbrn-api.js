const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { DATA_DIR } = require("./config");

// The public CBRN picture: which instruments are actually reporting, what the
// system has alerted on, and what it cannot see. Public alerts only — `watch`
// events are operator-facing and never leave the private surface.
const PUBLIC_SEVERITIES = ["elevated", "high", "critical"];
const MAX_ALERTS = 25;

const LIMITS = [
  "Gamma telemetry covers the European reporting networks mirrored by the German federal radiation office, plus the German national network. It is not global coverage, and a normal reading outside a monitored area proves nothing.",
  "Aircraft observation samples a fixed roster of public CBRN-relevant geographies; it is not a global traffic picture, and it says nothing about aircraft purpose, cargo or passengers.",
  "Vocabulary counts come from one public post stream and one news index. They are not verified reporting, they are platform-biased, and they are not established to precede official reporting.",
  "Nothing here predicts a release. Every alert states what was measured, where, and what would change the assessment.",
];

function iso(value) {
  return typeof value === "string" && value ? value : null;
}

function ageMinutes(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 60000)) : null;
}

function readCbrnDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { available: false };
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    const networks = db.prepare(
      "SELECT source, COUNT(DISTINCT station_id) AS stations, MAX(observed_at) AS newestReading FROM cbrn_readings GROUP BY source ORDER BY source",
    ).all();
    const health = db.prepare(
      "SELECT source, last_success_at AS lastSuccessAt, last_error AS lastError, consecutive_failures AS consecutiveFailures FROM cbrn_ingest_runs",
    ).all();
    const healthBySource = new Map(health.map((row) => [row.source, row]));
    const aircraft = db.prepare(
      "SELECT COUNT(DISTINCT region) AS regions, MAX(sampled_at) AS newestSample FROM cbrn_aircraft_slots",
    ).get();
    const lexical = db.prepare(
      "SELECT COUNT(DISTINCT region) AS regions, MAX(bucket_start) AS newestBucket FROM cbrn_lexical_buckets",
    ).get();
    return {
      available: true,
      radiation: networks.map((row) => ({
        source: row.source,
        stations: row.stations,
        newestReading: iso(row.newestReading),
        readingAgeMinutes: ageMinutes(row.newestReading),
        consecutiveFailures: healthBySource.get(row.source)?.consecutiveFailures ?? 0,
        lastError: healthBySource.get(row.source)?.lastError ?? null,
      })),
      aircraft: {
        regions: aircraft?.regions ?? 0,
        newestSample: iso(aircraft?.newestSample),
        sampleAgeMinutes: ageMinutes(aircraft?.newestSample),
      },
      lexical: {
        regions: lexical?.regions ?? 0,
        newestBucket: iso(lexical?.newestBucket),
      },
    };
  } catch (error) {
    return { available: false, error: "CBRN database could not be read." };
  } finally {
    db?.close();
  }
}

function readPublicAlerts(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    const placeholders = PUBLIC_SEVERITIES.map(() => "?").join(", ");
    return db.prepare(
      `SELECT kind, severity, occurred_at AS occurredAt, title, message, created_at AS createdAt
         FROM alert_events
        WHERE cohort = 'cbrn' AND severity IN (${placeholders})
        ORDER BY id DESC LIMIT ?`,
    ).all(...PUBLIC_SEVERITIES, MAX_ALERTS);
  } catch (error) {
    return [];
  } finally {
    db?.close();
  }
}

function cbrnDbPath() {
  return process.env.EWS_CBRN_DB_PATH
    ? path.resolve(process.env.EWS_CBRN_DB_PATH)
    : path.join(DATA_DIR, "ews-cbrn.sqlite");
}

function getCbrnSummary(mainDbPath) {
  const instruments = readCbrnDatabase(cbrnDbPath());
  const alerts = readPublicAlerts(mainDbPath || (process.env.EWS_DB_PATH
    ? path.resolve(process.env.EWS_DB_PATH)
    : path.join(DATA_DIR, "ews-main.sqlite")));
  const reporting = (instruments.radiation ?? []).filter(
    (network) => network.stations > 0 && network.readingAgeMinutes != null && network.readingAgeMinutes <= 240,
  );
  return {
    generatedAt: new Date().toISOString(),
    instruments: {
      radiation: {
        networks: instruments.radiation ?? [],
        reportingNetworks: reporting.length,
        // Stated as a fact about the instrument, never as a statement about safety.
        status: !instruments.available
          ? "unavailable"
          : reporting.length
            ? "reporting"
            : "no network reporting within four hours",
      },
      aircraft: instruments.aircraft ?? { regions: 0, newestSample: null, sampleAgeMinutes: null },
      lexical: instruments.lexical ?? { regions: 0, newestBucket: null },
    },
    alerts,
    limits: LIMITS,
  };
}

function mountCbrnRoutes(app, { getDbPath } = {}) {
  app.get("/api/cbrn", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    try {
      const dbPath = typeof getDbPath === "function" ? getDbPath() : null;
      response.json(getCbrnSummary(dbPath));
    } catch (error) {
      // Never leak SQL, paths or upstream payloads.
      console.error("CBRN API failed:", error.code || error.name || "Error");
      response.status(500).json({ error: "CBRN status could not be read." });
    }
  });
}

module.exports = { getCbrnSummary, mountCbrnRoutes, LIMITS };
