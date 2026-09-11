#!/usr/bin/env node

const { openCbrnDb, readAlarmState, writeAlarmState, recordIngestRun, nowIso } = require('./cbrn_lib');
const USER_AGENT = 'Warning.watch/1.0 (https://warning.watch; CBRN public-source watch)';
const NETWORKS = { de: 'odlinfo_odl_1h_latest', eurdep: 'eurdep_latestValue' };
// Live comparison: projected GeoJSON 567985 bytes / 44556 gzip, CSV
// 358921 bytes / 65671 gzip. Keep the smaller compressed, typed GeoJSON.
const PROPERTIES = 'id,name,value,unit,end_measure,site_status,site_status_text,validated,geom';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FEATURES = 30000;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, networks: ['de', 'eurdep'], minIntervalMinutes: 30, force: false };
  const names = { '--db': 'db', '--networks': 'networks', '--min-interval-minutes': 'minIntervalMinutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') result.force = true;
    else if (arg === '--once') continue;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (typeof result.networks === 'string') result.networks = [...new Set(result.networks.split(','))];
  if (!result.networks.length || result.networks.some((name) => !Object.hasOwn(NETWORKS, name))) throw new Error('--networks must contain de and/or eurdep.');
  result.minIntervalMinutes = Number(result.minIntervalMinutes);
  if (!Number.isFinite(result.minIntervalMinutes) || result.minIntervalMinutes < 30) throw new Error('--min-interval-minutes must be at least 30.');
  return result;
}

async function fetchNetwork(network) {
  const url = new URL('https://www.imis.bfs.de/ogc/opendata/ows');
  url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeName: `opendata:${NETWORKS[network]}`, outputFormat: 'application/json', propertyName: PROPERTIES }).toString();
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`WFS HTTP ${response.status}`); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error(`WFS body exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length || data.features.length > MAX_FEATURES) throw new Error('Invalid, empty or oversized WFS FeatureCollection');
  return { data, bytes, contentEncoding: response.headers.get('content-encoding'), wireBytes: response.headers.get('content-length') };
}

function ingestCollection(db, network, result, now = Date.now()) {
  const roster = new Set(db.prepare('SELECT station_id FROM cbrn_stations WHERE source = ?').all(network).map((row) => row.station_id));
  const seen = new Map();
  const rows = [];
  const statuses = {};
  let newest = null;
  let invalidReadings = 0;
  for (const feature of result.data.features) {
    const p = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.type !== 'Feature' || !p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || feature.geometry?.type !== 'Point' || !Array.isArray(coordinates) || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('Malformed WFS station');
    // EURDEP repeats identical hourly values across five analysis-window labels.
    const signature = JSON.stringify([coordinates, p.name, p.value, p.unit, p.end_measure, p.site_status, p.site_status_text, p.validated]);
    if (seen.has(p.id)) {
      if (seen.get(p.id) !== signature) throw new Error(`Conflicting WFS copies for ${p.id}`);
      continue;
    }
    seen.set(p.id, signature);
    const quality = JSON.stringify({ site_status: p.site_status ?? null, site_status_text: p.site_status_text ?? null, validated: p.validated ?? null });
    const statusKey = JSON.stringify([p.site_status ?? null, p.site_status_text ?? null]);
    statuses[statusKey] = (statuses[statusKey] || 0) + 1;
    const time = typeof p.end_measure === 'string' ? Date.parse(p.end_measure) : NaN;
    const valid = Number.isFinite(time) && time <= now + 5 * 60000 && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= 0 && typeof p.unit === 'string' && p.unit.length > 0;
    if (!valid) invalidReadings += 1;
    const observedAt = valid ? new Date(time).toISOString().replace(/\.000Z$/, 'Z') : null;
    if (valid && (!newest || observedAt > newest)) newest = observedAt;
    rows.push({ id: p.id, name: p.name, lat: coordinates[1], lon: coordinates[0], country: /^[A-Z]{2}\d+/.test(p.id) ? p.id.slice(0, 2) : null, quality, value: p.value, unit: p.unit, observedAt });
  }
  const returnedKnown = [...roster].filter((id) => seen.has(id)).length;
  const partial = roster.size > 0 && returnedKnown < 0.8 * roster.size;
  const stale = !newest || now - Date.parse(newest) > 3 * 3600000;
  const detail = { features: result.data.features.length, stations: rows.length, readings: rows.length - invalidReadings, invalid_readings: invalidReadings, roster: roster.size, returned_known: returnedKnown, shortfall: roster.size - returnedKnown, partial, stale, newest, bytes: result.bytes, content_encoding: result.contentEncoding, wire_bytes: result.wireBytes, statuses };
  const at = nowIso();
  const station = db.prepare(`INSERT INTO cbrn_stations (source, station_id, name, lat, lon, country, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, station_id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, country=excluded.country, last_seen=excluded.last_seen`);
  const reading = db.prepare(`INSERT INTO cbrn_readings (source, station_id, observed_at, value, unit, quality, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, station_id, observed_at) DO UPDATE SET value=excluded.value, unit=excluded.unit, quality=excluded.quality, ingested_at=excluded.ingested_at`);
  db.transaction(() => {
    for (const row of rows) {
      station.run(network, row.id, row.name, row.lat, row.lon, row.country, at, at);
      if (row.observedAt) reading.run(network, row.id, row.observedAt, row.value, row.unit, row.quality, at);
    }
    recordIngestRun(db, { source: network, ok: !partial && !stale, error: partial || stale ? `partial=${partial}; shortfall=${detail.shortfall}/${roster.size}; stale=${stale}` : null, detail });
  })();
  return { network, ok: !partial && !stale, ...detail };
}

async function main() {
  const settings = options(process.argv.slice(2));
  const db = openCbrnDb({ dbPath: settings.db });
  const results = [];
  try {
    for (const network of settings.networks) {
      const now = Date.now();
      const allowed = db.transaction(() => {
        const previous = readAlarmState(db, `ingest:${network}`, 'cadence');
        if (!settings.force && previous && now - Date.parse(previous.polled_at) < settings.minIntervalMinutes * 60000) return false;
        writeAlarmState(db, `ingest:${network}`, 'cadence', { polled_at: new Date(now).toISOString() });
        return true;
      }).immediate();
      if (!allowed) { results.push({ network, skipped: 'cadence' }); continue; }
      try { results.push(ingestCollection(db, network, await fetchNetwork(network))); }
      catch (error) {
        const roster = db.prepare('SELECT COUNT(*) AS n FROM cbrn_stations WHERE source = ?').get(network).n;
        const detail = { roster, returned_known: 0, shortfall: roster, failed: true };
        recordIngestRun(db, { source: network, ok: false, error: error.message, detail });
        results.push({ network, ok: false, error: error.message, ...detail });
        process.exitCode = 1;
      }
    }
    console.log(JSON.stringify({ networks: results }));
  } finally { db.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, fetchNetwork, ingestCollection };
