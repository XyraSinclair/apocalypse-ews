const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");

const DAY = 86400000;
const MAX_ATTEMPTS = 3;
const statements = new WeakMap();
const iso = (value) => value == null ? null : new Date(value).toISOString();
const parse = (value) => JSON.parse(value);
function sql(db, text) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, cache = new Map());
  if (!cache.has(text)) cache.set(text, db.prepare(text));
  return cache.get(text);
}
function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function text(value, name, max = 2000, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw problem(`Invalid ${name}.`);
  return value.trim();
}
function timestamp(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw problem(`Invalid ${name}.`);
  return iso(Date.parse(value));
}
function safeUrl(value) {
  const raw = text(value, "source URL", 4096);
  let url;
  try { url = new URL(raw); } catch { throw problem("Invalid source URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw problem("Unsafe source URL.");
  return url.href;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem(`Invalid ${name}.`);
  const encoded = JSON.stringify(value);
  if (encoded.length > 64000) throw problem(`${name} is too large.`);
  return parse(encoded);
}
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !/^(retrievedAt|fetchedAt|checkedAt|polledAt|observedAt|retrieved_at|fetched_at|checked_at|polled_at)$/.test(key)).map((key) => [key, semantic(value[key])]));
}
const digest = (value) => createHash("sha256").update(JSON.stringify(semantic(value))).digest("hex");
function observation(raw) {
  if (!raw || typeof raw !== "object") throw problem("Invalid observation.");
  if (!["notice", "report", "measurement", "official_alert", "context"].includes(raw.kind) || !["current", "updated", "cancelled"].includes(raw.status)) throw problem("Invalid observation kind or status.");
  if (!Array.isArray(raw.topics) || raw.topics.length > 20) throw problem("Invalid observation topics.");
  const data = object(raw.data, "observation data");
  if (data.expiresAt != null) data.expiresAt = timestamp(data.expiresAt, "expiry");
  for (const key of ["sourceCommitAt", "indexSeenAt"]) if (data[key] != null) data[key] = timestamp(data[key], key);
  if (data.references != null && (!Array.isArray(data.references) || data.references.length > 200 || data.references.some((ref) => typeof (typeof ref === "string" ? ref : ref?.identifier) !== "string" || !(typeof ref === "string" ? ref : ref.identifier).trim() || (typeof ref === "string" ? ref : ref.identifier).length > 1000))) throw problem("Invalid observation references.");
  return { externalId: text(raw.externalId, "externalId", 1000), title: text(raw.title, "title", 2000), summary: text(raw.summary, "summary", 20000, true), url: safeUrl(raw.url), occurredAt: timestamp(raw.occurredAt, "occurredAt"), publishedAt: timestamp(raw.publishedAt, "publishedAt"), region: text(raw.region, "region", 500, true), topics: [...new Set(raw.topics.map((topic) => text(topic, "topic", 100)))].sort(), kind: raw.kind, status: raw.status, data };
}
function openWatchDb(filename = process.env.EWS_WATCH_DB_PATH || path.join(__dirname, "..", "data", "ews-watch.sqlite")) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_sources (
      id TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL,
      checked_at INTEGER, success_at INTEGER, observed_at INTEGER, baseline_at INTEGER,
      last_error TEXT, observation_count INTEGER NOT NULL DEFAULT 0, cursor TEXT, metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS watch_evidence (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES watch_sources(id), external_id TEXT NOT NULL,
      digest TEXT NOT NULL, observation TEXT NOT NULL, provenance TEXT NOT NULL, observed_at INTEGER NOT NULL,
      supersedes TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_evidence_age ON watch_evidence(observed_at);
    CREATE INDEX IF NOT EXISTS watch_evidence_parent ON watch_evidence(supersedes);
    CREATE INDEX IF NOT EXISTS watch_evidence_message ON watch_evidence(source_id,json_extract(observation,'$.data.messageId'),observed_at DESC);
    CREATE INDEX IF NOT EXISTS watch_evidence_region ON watch_evidence(json_extract(observation,'$.region'),observed_at DESC);
    CREATE INDEX IF NOT EXISTS watch_evidence_identity ON watch_evidence(source_id,external_id,digest);
    CREATE TABLE IF NOT EXISTS watch_evidence_edges (
      successor TEXT NOT NULL REFERENCES watch_evidence(id), predecessor TEXT NOT NULL REFERENCES watch_evidence(id),
      PRIMARY KEY(successor,predecessor), CHECK(successor!=predecessor)
    );
    CREATE INDEX IF NOT EXISTS watch_evidence_edges_reverse ON watch_evidence_edges(predecessor,successor);
    CREATE TABLE IF NOT EXISTS watch_evidence_references (
      successor TEXT NOT NULL REFERENCES watch_evidence(id), source_id TEXT NOT NULL, identifier TEXT NOT NULL,
      PRIMARY KEY(successor,identifier)
    );
    CREATE INDEX IF NOT EXISTS watch_evidence_references_target ON watch_evidence_references(source_id,identifier);
    CREATE TABLE IF NOT EXISTS watch_items (
      source_id TEXT NOT NULL REFERENCES watch_sources(id), external_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL REFERENCES watch_evidence(id), PRIMARY KEY(source_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS watch_items_evidence ON watch_items(evidence_id);
    CREATE TABLE IF NOT EXISTS watch_incidents (
      id TEXT PRIMARY KEY, group_key TEXT NOT NULL, title TEXT NOT NULL, region TEXT NOT NULL, topics TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', attention TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, investigation_status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      owner TEXT, lease_until INTEGER, claimed_generation INTEGER, updated_at INTEGER, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_incidents_group ON watch_incidents(group_key,last_at DESC);
    CREATE INDEX IF NOT EXISTS watch_incidents_recent ON watch_incidents(last_at DESC);
    CREATE INDEX IF NOT EXISTS watch_incidents_queue ON watch_incidents(status,investigation_status,next_attempt_at,last_at);
    CREATE INDEX IF NOT EXISTS watch_incidents_page ON watch_incidents(status,last_at DESC,id);
    CREATE INDEX IF NOT EXISTS watch_incidents_leases ON watch_incidents(lease_until) WHERE investigation_status='running';
    CREATE TABLE IF NOT EXISTS watch_incident_evidence (
      incident_id TEXT NOT NULL REFERENCES watch_incidents(id), evidence_id TEXT NOT NULL REFERENCES watch_evidence(id),
      association TEXT NOT NULL DEFAULT 'primary',
      PRIMARY KEY(incident_id,evidence_id)
    );
    CREATE INDEX IF NOT EXISTS watch_incident_evidence_reverse ON watch_incident_evidence(evidence_id,incident_id);
    CREATE TABLE IF NOT EXISTS watch_jobs (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES watch_incidents(id), owner TEXT NOT NULL,
      generation INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
      evidence_ids TEXT NOT NULL, result TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_jobs_day ON watch_jobs(started_at);
    CREATE INDEX IF NOT EXISTS watch_jobs_incident ON watch_jobs(incident_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS watch_reviews (
      id INTEGER PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES watch_incidents(id), status TEXT NOT NULL,
      note TEXT NOT NULL, reviewed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_reviews_incident ON watch_reviews(incident_id,id DESC);
    CREATE TABLE IF NOT EXISTS watch_run (
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER, started_at INTEGER, finished_at INTEGER,
      last_error TEXT, summary TEXT
    );
    INSERT OR IGNORE INTO watch_run(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS watch_runs (
      id INTEGER PRIMARY KEY, owner TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_runs_age ON watch_runs(finished_at);
  `);
  if (!db.pragma("table_info(watch_incident_evidence)").some((column) => column.name === "association")) db.exec("ALTER TABLE watch_incident_evidence ADD COLUMN association TEXT NOT NULL DEFAULT 'primary'");
  if (db.pragma("user_version", { simple: true }) < 1) {
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO watch_evidence_edges
          SELECT id,supersedes FROM watch_evidence
          WHERE supersedes IS NOT NULL AND supersedes IN (SELECT id FROM watch_evidence) AND id!=supersedes;
        INSERT OR IGNORE INTO watch_evidence_references
          SELECT e.id,e.source_id,CASE WHEN r.type='text' THEN r.value ELSE json_extract(r.value,'$.identifier') END
          FROM watch_evidence e,json_each(e.observation,'$.data.references') r
          WHERE CASE WHEN r.type='text' THEN r.value ELSE json_extract(r.value,'$.identifier') END IS NOT NULL;
        PRAGMA user_version=1;
      `);
    }).immediate();
  }
  return db;
}
function syncSources(db, definitions, now = Date.now()) {
  if (!Array.isArray(definitions) || definitions.length > 500) throw problem("Invalid source definitions.");
  const normalized = definitions.map((raw) => {
    for (const key of ["id", "name", "family", "mechanism", "dependenceGroup", "accessStatus"]) text(raw[key], key, 500);
    if (typeof raw.enabled !== "boolean" || !Number.isFinite(raw.pollSeconds) || raw.pollSeconds < 1 || !Number.isFinite(raw.staleSeconds) || raw.staleSeconds < 1) throw problem("Invalid source cadence.");
    if (raw.sampleStaleSeconds != null && (!Number.isFinite(raw.sampleStaleSeconds) || raw.sampleStaleSeconds < 1)) throw problem("Invalid source sample freshness.");
    return { id: raw.id, name: raw.name, family: raw.family, mechanism: raw.mechanism, dependenceGroup: raw.dependenceGroup, url: safeUrl(raw.url), enabled: raw.enabled, accessStatus: raw.accessStatus, pollSeconds: raw.pollSeconds, staleSeconds: raw.staleSeconds, sampleStaleSeconds: raw.sampleStaleSeconds ?? null, notes: text(raw.notes, "notes", 10000, true) };
  });
  if (new Set(normalized.map((row) => row.id)).size !== normalized.length) throw problem("Duplicate source definition.");
  db.transaction(() => {
    const ids = new Set(normalized.map((row) => row.id));
    for (const row of sql(db, "SELECT id,definition FROM watch_sources").all()) {
      if (!ids.has(row.id)) {
        const definition = { ...parse(row.definition), enabled: false, accessStatus: "retired" };
        sql(db, "UPDATE watch_sources SET enabled=0,definition=? WHERE id=?").run(JSON.stringify(definition), row.id);
      }
    }
    for (const row of normalized) sql(db, "INSERT INTO watch_sources(id,definition,enabled) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled").run(row.id, JSON.stringify(row), Number(row.enabled));
  }).immediate();
}
function listDueSources(db, definitions, now = Date.now(), { force = false } = {}) {
  return definitions.flatMap((definition) => {
    if (!definition.enabled) return [];
    const row = sql(db, "SELECT checked_at,cursor FROM watch_sources WHERE id=?").get(definition.id);
    return !row || force || row.checked_at == null || now - row.checked_at >= definition.pollSeconds * 1000
      ? [{ ...definition, cursor: row?.cursor || null }] : [];
  });
}
function claimRun(db, owner, now, ttlMs) {
  text(owner, "owner", 200);
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw problem("Invalid run lease.");
  return sql(db, "UPDATE watch_run SET owner=?,lease_until=?,started_at=? WHERE id=1 AND (owner IS NULL OR lease_until<=?)").run(owner, now + ttlMs, now, now).changes === 1;
}
function finishRun(db, owner, summary, now = Date.now()) {
  const encoded = JSON.stringify(object(summary, "run summary"));
  db.transaction(() => {
    const row = sql(db, "SELECT * FROM watch_run WHERE id=1 AND owner=?").get(owner);
    if (!row) throw problem("Run lease is not owned by this worker.", 409);
    sql(db, "INSERT INTO watch_runs(owner,started_at,finished_at,summary) VALUES(?,?,?,?)").run(owner, row.started_at, now, encoded);
    sql(db, "UPDATE watch_run SET owner=NULL,lease_until=NULL,finished_at=?,last_error=?,summary=? WHERE id=1").run(now, typeof summary.lastError === "string" ? summary.lastError.slice(0, 2000) : null, encoded);
  }).immediate();
}
function eligible(item, now, baseline, staleSeconds) {
  const expires = item.data.expiresAt ? Date.parse(item.data.expiresAt) : null;
  if (expires != null && expires <= now) return false;
  if (item.status === "cancelled") return false;
  if (item.data.actual === false || item.data.test === true) return false;
  const eventAt = Date.parse(item.publishedAt || item.occurredAt || "");
  if (item.kind === "official_alert") return !baseline || (Number.isFinite(eventAt) && eventAt <= now + 300000 && (now - eventAt <= DAY || expires > now));
  if (baseline) return false;
  if (item.kind === "measurement" || item.data.anomaly != null) return !item.data.sourceError && Number.isFinite(eventAt) && eventAt <= now + 300000 && now - eventAt <= staleSeconds * 1000 && (item.data.anomaly === true || ["investigate", "review", "urgent"].includes(item.data.attention));
  if (item.topics.some((topic) => ["nuclear_reporting", "missile_reporting", "radiation_reporting", "radiological_reporting", "civil_protection", "military_escalation", "nuclear", "radiation", "radiological", "missile"].includes(topic))) return true;
  return /\b(nuclear|radiological|radiation|missile|mobiliz(?:ation|e)|evacuat\w*|shelter.in.place|armed attack|airstrike|air strike|state of emergency|civil emergency|military escalation|do not travel|leave immediately|border clos(?:ure|ed)|airspace clos(?:ure|ed))\b/i.test(`${item.title} ${item.summary} ${item.topics.join(" ")}`);
}
function groupKey(sourceId, item) {
  const title = item.title.toLowerCase().replace(/\b(?:updated?|update|breaking)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 240);
  return digest([explicitRegion(item.region) ? null : sourceId, item.region.toLowerCase(), item.kind, title]);
}
function explicitRegion(region) {
  return Boolean(region.trim()) && !/global|unknown|unspecified|worldwide|multiple|;/i.test(region);
}
function attachCandidateContext(db, incident, now) {
  if (!explicitRegion(incident.region)) return;
  const generic = new Set(["public_post", "official_warning", "observation_context", "scientific_context", "aviation_activity", "conflict_zone", "aviation_notice", "news", "context"]);
  const topics = parse(incident.topics).filter((topic) => !generic.has(topic));
  if (!topics.length) return;
  const candidates = sql(db, `SELECT e.id FROM watch_evidence e JOIN watch_items h ON h.evidence_id=e.id
    WHERE json_extract(e.observation,'$.region')=? AND e.observed_at>=?
      AND e.source_id NOT IN (SELECT p.source_id FROM watch_incident_evidence l JOIN watch_evidence p ON p.id=l.evidence_id WHERE l.incident_id=? AND l.association='primary')
      AND json_extract(e.observation,'$.status')!='cancelled'
      AND COALESCE(json_extract(e.observation,'$.publishedAt'),json_extract(e.observation,'$.occurredAt')) BETWEEN ? AND ?
      AND (json_extract(e.observation,'$.data.expiresAt') IS NULL OR json_extract(e.observation,'$.data.expiresAt')>?)
      AND COALESCE(json_extract(e.observation,'$.data.actual'),1)!=0 AND COALESCE(json_extract(e.observation,'$.data.test'),0)!=1
      AND NOT EXISTS(SELECT 1 FROM watch_evidence_edges n WHERE n.predecessor=e.id)
      AND EXISTS(SELECT 1 FROM json_each(e.observation,'$.topics') t JOIN json_each(?) wanted ON t.value=wanted.value)
    ORDER BY e.observed_at DESC LIMIT 12`).all(incident.region, now - 3 * DAY, incident.id, iso(now - 3 * DAY), iso(now + 300000), iso(now), JSON.stringify(topics));
  for (const candidate of candidates) sql(db, "INSERT OR IGNORE INTO watch_incident_evidence(incident_id,evidence_id,association) VALUES(?,?,'candidate_context')").run(incident.id, candidate.id);
}
function recordSourceResult(db, sourceId, result, now = Date.now()) {
  if (!result || !Array.isArray(result.observations) || result.observations.length > 2000) throw problem("Invalid source result.");
  const items = result.observations.map(observation);
  if (new Set(items.map((item) => item.externalId)).size !== items.length) throw problem("Duplicate external IDs in source result.");
  const sourceMetadata = result.metadata == null ? null : object(result.metadata, "source metadata");
  if (sourceMetadata?.sourceUpdatedAt != null) sourceMetadata.sourceUpdatedAt = timestamp(sourceMetadata.sourceUpdatedAt, "upstream source timestamp");
  const metadata = sourceMetadata == null ? null : JSON.stringify(sourceMetadata);
  const cursor = result.cursor == null ? null : text(result.cursor, "cursor", 160000, true);
  return db.transaction(() => {
    const source = sql(db, "SELECT * FROM watch_sources WHERE id=?").get(sourceId);
    if (!source) throw problem("Unknown watch source.", 404);
    const definition = parse(source.definition);
    const counts = { inserted: 0, changed: 0, incidentsOpened: 0 };
    const staged = [];
    const changedIncidents = new Map();
    for (const item of items) {
      const hash = digest(item);
      const previous = sql(db, "SELECT e.* FROM watch_items i JOIN watch_evidence e ON e.id=i.evidence_id WHERE i.source_id=? AND i.external_id=?").get(sourceId, item.externalId);
      if (previous?.digest === hash) continue;
      const id = randomUUID();
      const provenance = { sourceId, sourceName: definition.name, family: definition.family, mechanism: definition.mechanism, dependenceGroup: definition.dependenceGroup };
      sql(db, "INSERT INTO watch_evidence(id,source_id,external_id,digest,observation,provenance,observed_at,supersedes) VALUES(?,?,?,?,?,?,?,?)").run(id, sourceId, item.externalId, hash, JSON.stringify(item), JSON.stringify(provenance), now, previous?.id || null);
      sql(db, "INSERT INTO watch_items(source_id,external_id,evidence_id) VALUES(?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET evidence_id=excluded.evidence_id").run(sourceId, item.externalId, id);
      if (previous) {
        counts.changed++;
        sql(db, "INSERT OR IGNORE INTO watch_evidence_edges(successor,predecessor) VALUES(?,?)").run(id, previous.id);
      } else counts.inserted++;
      for (const reference of item.data.references || []) sql(db, "INSERT OR IGNORE INTO watch_evidence_references(successor,source_id,identifier) VALUES(?,?,?)").run(id, sourceId, typeof reference === "string" ? reference : reference.identifier);
      staged.push({ id, item, previous });
    }
    // Resolve after staging the entire batch. Persisted reference names also catch late originals.
    sql(db, `INSERT OR IGNORE INTO watch_evidence_edges(successor,predecessor)
      SELECT r.successor,e.id FROM watch_evidence_references r JOIN watch_evidence e
      ON e.source_id=r.source_id AND e.external_id=r.identifier WHERE r.source_id=? AND r.successor!=e.id`).run(sourceId);
    sql(db, `INSERT OR IGNORE INTO watch_evidence_edges(successor,predecessor)
      SELECT r.successor,e.id FROM watch_evidence_references r JOIN watch_evidence e
      ON e.source_id=r.source_id AND json_extract(e.observation,'$.data.messageId')=r.identifier WHERE r.source_id=? AND r.successor!=e.id`).run(sourceId);
    const stagedIds = new Set(staged.map(({ id }) => id));
    const affected = sql(db, `WITH RECURSIVE successors(id) AS (
      SELECT value FROM json_each(?) UNION SELECT e.successor FROM watch_evidence_edges e JOIN successors s ON e.predecessor=s.id)
      SELECT e.id,e.observation FROM successors s JOIN watch_evidence e ON e.id=s.id ORDER BY e.observed_at,e.rowid`).all(JSON.stringify([...stagedIds]));
    // Follow all predecessor paths, retaining candidate roles and all incident associations.
    for (const { id, observation: encoded } of affected) {
      const item = parse(encoded);
      const links = sql(db, `WITH RECURSIVE ancestors(id) AS (
        SELECT predecessor FROM watch_evidence_edges WHERE successor=?
        UNION SELECT e.predecessor FROM watch_evidence_edges e JOIN ancestors a ON e.successor=a.id)
        SELECT l.incident_id,CASE WHEN MAX(l.association='primary') THEN 'primary' ELSE 'candidate_context' END AS association
        FROM ancestors a JOIN watch_incident_evidence l ON l.evidence_id=a.id GROUP BY l.incident_id`).all(id);
      for (const link of links) {
        const added = sql(db, "INSERT OR IGNORE INTO watch_incident_evidence(incident_id,evidence_id,association) VALUES(?,?,?)").run(link.incident_id, id, link.association).changes;
        if (added || stagedIds.has(id)) {
          const priorTitle = changedIncidents.get(link.incident_id);
          const currentPrimary = link.association === "primary" && !sql(db, "SELECT 1 FROM watch_evidence_edges WHERE predecessor=?").get(id);
          changedIncidents.set(link.incident_id, currentPrimary ? item.title : priorTitle || null);
        }
      }
    }
    for (const { id, item, previous } of staged) {
      if (sql(db, "SELECT 1 FROM watch_incident_evidence WHERE evidence_id=?").get(id)) continue;
      if (sql(db, "SELECT 1 FROM watch_evidence_edges WHERE predecessor=?").get(id)) continue;
      const enrollment = source.baseline_at ?? now;
      const historical = source.baseline_at == null || (!previous && [item.data.sourceCommitAt, item.data.indexSeenAt].some((value) => value != null && Date.parse(value) <= enrollment));
      if (!eligible(item, now, historical, definition.staleSeconds)) continue;
      const key = groupKey(sourceId, item);
      let incident = sql(db, "SELECT * FROM watch_incidents WHERE group_key=? AND last_at>=? ORDER BY last_at DESC,id LIMIT 1").get(key, now - 3 * DAY);
      if (!incident) {
        incident = { id: randomUUID() };
        sql(db, "INSERT INTO watch_incidents(id,group_key,title,region,topics,attention,first_at,last_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(incident.id, key, item.title, item.region, JSON.stringify(item.topics), item.kind === "official_alert" ? "review" : "investigate", now, now, now);
        counts.incidentsOpened++;
      } else changedIncidents.set(incident.id, item.title);
      sql(db, "INSERT INTO watch_incident_evidence(incident_id,evidence_id) VALUES(?,?) ON CONFLICT(incident_id,evidence_id) DO UPDATE SET association='primary'").run(incident.id, id);
    }
    // Newly created primary threads retain all originals, even when originals arrived in this batch.
    for (const { id } of affected) {
      sql(db, `WITH RECURSIVE ancestors(id) AS (
        SELECT predecessor FROM watch_evidence_edges WHERE successor=?
        UNION SELECT e.predecessor FROM watch_evidence_edges e JOIN ancestors a ON e.successor=a.id)
        INSERT OR IGNORE INTO watch_incident_evidence(incident_id,evidence_id,association)
        SELECT l.incident_id,a.id,l.association FROM watch_incident_evidence l CROSS JOIN ancestors a WHERE l.evidence_id=?`).run(id, id);
    }
    for (const [id, title] of changedIncidents) sql(db, "UPDATE watch_incidents SET title=COALESCE(?,title),last_at=?,generation=generation+1,status='open',attempts=0,next_attempt_at=0,investigation_status=CASE WHEN investigation_status='running' THEN 'running' ELSE 'pending' END,last_error=NULL,updated_at=? WHERE id=?").run(title, now, now, id);
    const observed = staged.length ? now : source.observed_at;
    sql(db, "UPDATE watch_sources SET checked_at=?,success_at=?,observed_at=?,baseline_at=COALESCE(baseline_at,?),last_error=NULL,observation_count=observation_count+?,cursor=COALESCE(?,cursor),metadata=? WHERE id=?").run(now, now, observed, now, counts.inserted, cursor, metadata, sourceId);
    return counts;
  }).immediate();
}
function recordSourceFailure(db, sourceId, error, now = Date.now()) {
  const message = text(error, "source error", 20000).slice(0, 2000);
  if (!sql(db, "UPDATE watch_sources SET checked_at=?,last_error=? WHERE id=?").run(now, message, sourceId).changes) throw problem("Unknown watch source.", 404);
}
function evidenceRows(db, id, citationIds = []) {
  return sql(db, `SELECT e.*,l.association,json_extract(s.definition,'$.sampleStaleSeconds') AS sample_stale_seconds,
    (EXISTS(SELECT 1 FROM watch_items h WHERE h.evidence_id=e.id) AND NOT EXISTS(SELECT 1 FROM watch_evidence_edges n WHERE n.predecessor=e.id)) AS is_head,
    (SELECT json_group_array(predecessor) FROM watch_evidence_edges WHERE successor=e.id) AS predecessor_ids,
    (SELECT json_group_array(successor) FROM watch_evidence_edges WHERE predecessor=e.id) AS successor_ids
    FROM watch_incident_evidence l JOIN watch_evidence e ON e.id=l.evidence_id JOIN watch_sources s ON s.id=e.source_id
    WHERE l.incident_id=? AND (e.id IN (SELECT e2.id FROM watch_incident_evidence l2 JOIN watch_evidence e2 ON e2.id=l2.evidence_id WHERE l2.incident_id=? ORDER BY e2.observed_at DESC,e2.rowid DESC LIMIT 80) OR e.id IN (SELECT value FROM json_each(?)))
    ORDER BY e.observed_at DESC,e.rowid DESC`).all(id, id, JSON.stringify(citationIds));
}
function evidence(row, now, internal) {
  const item = parse(row.observation);
  const result = { id: row.id, ...parse(row.provenance), ...item, observedAt: iso(row.observed_at) };
  // Currentness is explicit, never inferred from the collection timestamp.
  result.data = internal ? item.data : Object.fromEntries(Object.entries(item.data).filter(([key]) => ["expiresAt", "severity", "urgency", "certainty", "event", "area", "effectiveAt", "instruction", "level", "count", "anomaly", "sampledAt", "unit", "value", "actual", "test", "capStatus", "scope", "messageType"].includes(key)));
  if (item.data.expiresAt && Date.parse(item.data.expiresAt) <= now) result.data.expired = true;
  const sampleAt = Date.parse(item.publishedAt || item.occurredAt || "");
  if (row.sample_stale_seconds != null && (!Number.isFinite(sampleAt) || sampleAt > now + 300000 || now - sampleAt > row.sample_stale_seconds * 1000)) result.data.stale = true;
  result.data.current = Boolean(row.is_head && item.status !== "cancelled" && !result.data.expired && !result.data.stale && item.data.actual !== false && item.data.test !== true);
  result.data.supersedes = row.supersedes;
  result.data.supersedesIds = parse(row.predecessor_ids);
  result.data.supersededBy = parse(row.successor_ids);
  if (row.association === "candidate_context") result.data.association = "candidate_context";
  return result;
}
function getInvestigationBudget(db, dailyLimit = 12, now = Date.now()) {
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 24) throw problem("Invalid daily investigation limit.");
  const start = Math.floor(now / DAY) * DAY;
  const used = sql(db, "SELECT count(*) AS n FROM watch_jobs WHERE started_at>=? AND started_at<?").get(start, start + DAY).n;
  return { dailyLimit, used, remaining: Math.max(0, dailyLimit - used), resetsAt: iso(start + DAY) };
}
function claimInvestigation(db, owner, now = Date.now(), leaseMs = 180000, { dailyLimit = 12 } = {}) {
  text(owner, "owner", 200);
  if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw problem("Invalid investigation lease.");
  return db.transaction(() => {
    for (const row of sql(db, "SELECT * FROM watch_incidents WHERE investigation_status='running' AND lease_until<=? LIMIT 100").all(now)) {
      sql(db, "UPDATE watch_jobs SET status='expired',finished_at=?,error='Worker lease expired.' WHERE incident_id=? AND owner=? AND status='running'").run(now, row.id, row.owner);
      const status = row.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      sql(db, "UPDATE watch_incidents SET investigation_status=?,owner=NULL,lease_until=NULL,last_error='Worker lease expired.',updated_at=? WHERE id=?").run(status, now, row.id);
    }
    if (getInvestigationBudget(db, dailyLimit, now).remaining === 0) return null;
    const row = sql(db, "SELECT * FROM watch_incidents WHERE status='open' AND investigation_status='pending' AND next_attempt_at<=? AND attempts<? ORDER BY CASE attention WHEN 'urgent' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,last_at DESC LIMIT 1").get(now, MAX_ATTEMPTS);
    if (!row) return null;
    attachCandidateContext(db, row, now);
    const prior = sql(db, "SELECT result FROM watch_jobs WHERE incident_id=? AND status='completed' ORDER BY started_at DESC,id DESC LIMIT 1").get(row.id);
    const previousFindings = prior ? parse(prior.result).findings : [];
    const observations = evidenceRows(db, row.id, citedIds(previousFindings)).map((item) => evidence(item, now, true));
    sql(db, "UPDATE watch_incidents SET investigation_status='running',owner=?,lease_until=?,claimed_generation=generation,attempts=attempts+1,updated_at=? WHERE id=?").run(owner, now + leaseMs, now, row.id);
    sql(db, "INSERT INTO watch_jobs(id,incident_id,owner,generation,started_at,status,evidence_ids) VALUES(?,?,?,?,?,'running',?)").run(randomUUID(), row.id, owner, row.generation, now, JSON.stringify(observations.map((item) => item.id)));
    return { id: row.id, title: row.title, region: row.region, topics: parse(row.topics), attention: row.attention, status: row.status, observations, previousFindings };
  }).immediate();
}
function ownedJob(db, incidentId, owner, now) {
  const incident = sql(db, "SELECT * FROM watch_incidents WHERE id=?").get(incidentId);
  if (!incident) throw problem("Unknown watch incident.", 404);
  if (incident.owner !== owner || incident.investigation_status !== "running" || incident.lease_until <= now) throw problem("Investigation lease is not owned or has expired.", 409);
  const job = sql(db, "SELECT * FROM watch_jobs WHERE incident_id=? AND owner=? AND status='running' ORDER BY started_at DESC LIMIT 1").get(incidentId, owner);
  if (!job) throw problem("Investigation audit is missing.", 409);
  return { incident, job };
}
function completeInvestigation(db, incidentId, owner, result, now = Date.now()) {
  db.transaction(() => {
    const { incident, job } = ownedJob(db, incidentId, owner, now);
    const allowed = new Set(parse(job.evidence_ids));
    const clean = object(result, "investigation result");
    for (const key of ["summary", "alternative", "nextQuestion", "model"]) text(clean[key], key, 12000, key === "nextQuestion");
    if (!["background", "investigate", "review", "urgent"].includes(clean.attention) || !["unresolved", "routine", "correction"].includes(clean.resolution) || !Array.isArray(clean.findings) || !clean.findings.length || clean.findings.length > 30) throw problem("Invalid investigation result.");
    object(clean.usage, "usage");
    for (const finding of clean.findings) {
      text(finding.text, "finding", 12000);
      if (!["specialist", "skeptic", "synthesis"].includes(finding.role) || !Array.isArray(finding.evidenceIds) || !finding.evidenceIds.length || finding.evidenceIds.some((id) => !allowed.has(id))) throw problem("Invalid finding citation.");
    }
    if (citedIds(clean.findings).length > 240) throw problem("Too many investigation citations.");
    sql(db, "UPDATE watch_jobs SET status='completed',finished_at=?,result=? WHERE id=?").run(now, JSON.stringify(clean), job.id);
    sql(db, "UPDATE watch_incidents SET investigation_status=?,owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?").run(incident.generation === job.generation ? "completed" : "pending", now, incidentId);
  }).immediate();
}
function citedIds(findings) {
  return [...new Set((findings || []).flatMap((finding) => finding.evidenceIds))];
}
function failInvestigation(db, incidentId, owner, error, now = Date.now(), audit = null) {
  const message = text(error, "investigation error", 20000).slice(0, 2000);
  let partial = null;
  if (audit != null) {
    const clean = object(audit, "failed investigation audit");
    const model = text(clean.model, "model", 500);
    const usage = object(clean.usage, "usage");
    const validNumbers = (value, depth = 0) => {
      if (value === null || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
      return depth < 5 && value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, child]) => /^[a-z_]{1,64}$/i.test(key) && validNumbers(child, depth + 1));
    };
    if (usage.provider == null) {
      if (!validNumbers(usage) || JSON.stringify(usage).length > 8000) throw problem("Invalid failed investigation usage.");
    } else {
      if (!["scry", "openrouter"].includes(usage.provider) || usage.complete !== false || !validNumbers(usage.coverage) || !Array.isArray(usage.calls) || usage.calls.length > 3 || JSON.stringify(usage).length > 30000) throw problem("Invalid failed investigation usage.");
      for (const call of usage.calls) {
        if (!call || !["specialist", "skeptic", "synthesis"].includes(call.role)) throw problem("Invalid failed investigation call.");
        text(call.model, "call model", 500);
        if (call.servedModel != null) text(call.servedModel, "served model", 500);
        if (!validNumbers(call.usage) || JSON.stringify(call.usage).length > 8000 || Object.keys(call).some((key) => !["role", "model", "servedModel", "usage"].includes(key))) throw problem("Invalid failed investigation call usage.");
      }
      if (Object.keys(usage).some((key) => !["provider", "coverage", "calls", "complete"].includes(key))) throw problem("Invalid failed investigation usage fields.");
    }
    partial = JSON.stringify({ model, usage, incomplete: true });
  }
  db.transaction(() => {
    const { incident, job } = ownedJob(db, incidentId, owner, now);
    sql(db, "UPDATE watch_jobs SET status='failed',finished_at=?,error=?,result=? WHERE id=?").run(now, message, partial, job.id);
    const newer = incident.generation !== job.generation;
    sql(db, "UPDATE watch_incidents SET investigation_status=?,owner=NULL,lease_until=NULL,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?").run(newer || incident.attempts < MAX_ATTEMPTS ? "pending" : "failed", message, newer ? now : now + Math.min(3600000, 60000 * 2 ** incident.attempts), now, incidentId);
  }).immediate();
}
function serializeIncident(db, row, { internal, now, detail = false }) {
  const links = sql(db, "SELECT DISTINCT e.source_id FROM watch_incident_evidence l JOIN watch_evidence e ON e.id=l.evidence_id WHERE l.incident_id=?").all(row.id);
  const count = sql(db, "SELECT count(*) AS n FROM watch_incident_evidence WHERE incident_id=?").get(row.id).n;
  const result = { id: row.id, title: row.title, region: row.region, topics: parse(row.topics), status: row.status, attention: row.attention, firstObservedAt: iso(row.first_at), lastObservedAt: iso(row.last_at), sourceIds: links.map((item) => item.source_id), evidenceCount: count, investigation: { status: row.investigation_status, lastError: internal ? row.last_error : row.last_error ? "Investigation unavailable; operator review required." : null, updatedAt: iso(row.updated_at) } };
  if (internal) {
    const job = row.investigation_status === "completed" ? sql(db, "SELECT result FROM watch_jobs WHERE incident_id=? AND generation=? AND status='completed' ORDER BY started_at DESC,id DESC LIMIT 1").get(row.id, row.generation) : null;
    if (job) result.assessment = parse(job.result);
    const review = sql(db, "SELECT note,reviewed_at FROM watch_reviews WHERE incident_id=? ORDER BY id DESC LIMIT 1").get(row.id);
    if (review) result.review = { note: review.note, reviewedAt: iso(review.reviewed_at) };
  }
  if (detail) {
    result.observations = evidenceRows(db, row.id, citedIds(result.assessment?.findings)).map((item) => evidence(item, now, internal));
    result.returnedEvidenceCount = result.observations.length;
  }
  return result;
}
function getIncident(db, id, { internal = false, now = Date.now() } = {}) {
  const row = sql(db, "SELECT * FROM watch_incidents WHERE id=?").get(id);
  return row ? serializeIncident(db, row, { internal, now, detail: true }) : null;
}
function getWatchSnapshot(db, { internal = false, limit = 40, status = "all", cursor = null, now = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problem("Invalid watch limit.");
  if (!["all", "open", "resolved"].includes(status)) throw problem("Invalid watch status.");
  let after = null;
  if (cursor != null) {
    if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw problem("Invalid watch cursor.");
    try { after = parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw problem("Invalid watch cursor."); }
    if (!Array.isArray(after) || after.length !== 5 || after[0] !== 1 || after[1] !== status || !["open", "resolved"].includes(after[2]) || (status !== "all" && after[2] !== status) || !Number.isSafeInteger(after[3]) || after[3] < 0 || typeof after[4] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after[4])) throw problem("Invalid watch cursor.");
  }
  const sources = sql(db, "SELECT * FROM watch_sources ORDER BY enabled DESC,id").all().map((row) => {
    const definition = parse(row.definition);
    let health = !definition.enabled ? "disabled" : row.last_error ? "degraded" : row.success_at == null ? "warming" : now - row.success_at > definition.staleSeconds * 1000 ? "stale" : "healthy";
    const metadata = row.metadata ? parse(row.metadata) : null;
    const sampleAt = definition.sampleStaleSeconds != null && metadata?.sourceUpdatedAt == null ? sql(db, "SELECT MAX(COALESCE(json_extract(e.observation,'$.publishedAt'),json_extract(e.observation,'$.occurredAt'))) AS at FROM watch_items h JOIN watch_evidence e ON e.id=h.evidence_id WHERE h.source_id=?").get(row.id).at : null;
    const upstreamAt = Date.parse(metadata?.sourceUpdatedAt ?? sampleAt ?? "");
    if (health === "healthy" && definition.sampleStaleSeconds != null && (upstreamAt == null || !Number.isFinite(upstreamAt) || upstreamAt > now + 300000 || now - upstreamAt > definition.sampleStaleSeconds * 1000)) health = "stale";
    if (health === "healthy" && metadata?.sourceGap === true) health = "degraded";
    return { ...definition, health, lastCheckedAt: iso(row.checked_at), lastSuccessAt: iso(row.success_at), lastObservedAt: iso(row.observed_at), lastError: internal ? row.last_error : row.last_error ? "Source check failed; previous evidence retained." : null, observationCount: row.observation_count, baselineSince: iso(row.baseline_at), metadata };
  });
  const run = sql(db, "SELECT * FROM watch_run WHERE id=1").get();
  const handover = run.summary ? parse(run.summary) : {};
  const config = handover.agent || {};
  const agent = { configured: config.configured === true, model: typeof config.model === "string" ? config.model : null, reason: typeof config.reason === "string" ? config.reason : handover.agent ? null : "No worker agent configuration has been recorded." };
  const rows = sql(db, `SELECT * FROM watch_incidents WHERE (?='all' OR status=?)
    AND (? IS NULL OR status>? OR (status=? AND (last_at<? OR (last_at=? AND id>?))))
    ORDER BY status,last_at DESC,id LIMIT ?`).all(status, status, after?.[2] ?? null, after?.[2] ?? null, after?.[2] ?? null, after?.[3] ?? null, after?.[3] ?? null, after?.[4] ?? null, limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  const page = { nextCursor: hasMore ? Buffer.from(JSON.stringify([1, status, last.status, last.last_at, last.id])).toString("base64url") : null, status };
  const incidents = rows.map((row) => serializeIncident(db, row, { internal, now }));
  const pending = sql(db, "SELECT count(*) AS n FROM watch_incidents WHERE status='open' AND investigation_status IN ('pending','running','failed')").get().n;
  const openIncidents = sql(db, "SELECT count(*) AS n FROM watch_incidents WHERE status='open'").get().n;
  const coverageGaps = sources.filter((source) => source.health !== "healthy").map((source) => `${source.name}: ${source.health}${source.enabled ? "" : ` (${source.accessStatus})`}`);
  const openQuestions = internal ? sql(db, "SELECT j.result FROM watch_jobs j JOIN watch_incidents i ON i.id=j.incident_id WHERE i.status='open' AND i.investigation_status='completed' AND j.generation=i.generation AND j.status='completed' AND j.id=(SELECT j2.id FROM watch_jobs j2 WHERE j2.incident_id=i.id AND j2.generation=i.generation AND j2.status='completed' ORDER BY j2.started_at DESC,j2.id DESC LIMIT 1) ORDER BY j.started_at DESC LIMIT 20").all().map((row) => parse(row.result).nextQuestion).filter(Boolean) : [];
  const budget = getInvestigationBudget(db, Number.isInteger(handover.budget?.dailyLimit) ? handover.budget.dailyLimit : 12, now);
  if (budget.remaining === 0) coverageGaps.push(`Investigation daily cap reached (${budget.used}/${budget.dailyLimit}); resumes ${budget.resetsAt}.`);
  if (!agent.configured) coverageGaps.push("Investigation provider is not configured; evidence collection does not establish safety.");
  if (internal && Array.isArray(handover.coverageGaps)) coverageGaps.push(...handover.coverageGaps.filter((gap) => typeof gap === "string").slice(0, 50));
  return { generatedAt: iso(now), mode: "machine_watch", page, reviewPolicy: "Investigation priority is not a threat level. Machine drafts require human review; missing coverage is not evidence of safety.", run: { lastStartedAt: iso(run.started_at), lastFinishedAt: iso(run.finished_at), lastError: internal ? run.last_error : run.last_error ? "The last watch run reported an error." : null, running: Boolean(run.owner && run.lease_until > now) }, agent, counts: { sources: sources.length, enabled: sources.filter((source) => source.enabled).length, healthy: sources.filter((source) => source.health === "healthy").length, degraded: sources.filter((source) => source.enabled && source.health !== "healthy").length, pending, openIncidents }, sources, incidents, handover: { generatedAt: iso(run.finished_at), summary: internal && typeof handover.summary === "string" ? handover.summary : sources.length ? `${openIncidents} open factual incident threads; ${pending} investigations pending, running, or failed. Coverage and incident priority do not establish safety or danger.` : "Watch source registry has not been initialized.", openQuestions, coverageGaps: [...new Set(coverageGaps)] } };
}
function reviewIncident(db, id, { status, note }, now = Date.now()) {
  if (!["open", "resolved"].includes(status)) throw problem("Review status must be open or resolved.");
  const cleanNote = text(note, "review note", 4000);
  return db.transaction(() => {
    const row = sql(db, "SELECT * FROM watch_incidents WHERE id=?").get(id);
    if (!row) throw problem("Unknown watch incident.", 404);
    sql(db, "INSERT INTO watch_reviews(incident_id,status,note,reviewed_at) VALUES(?,?,?,?)").run(id, status, cleanNote, now);
    sql(db, "UPDATE watch_incidents SET status=?,investigation_status=CASE WHEN ?='open' AND investigation_status!='running' THEN 'pending' ELSE investigation_status END,attempts=CASE WHEN ?='open' THEN 0 ELSE attempts END,next_attempt_at=0,updated_at=? WHERE id=?").run(status, status, status, now, id);
    return getIncident(db, id, { internal: true, now });
  }).immediate();
}
function pruneWatch(db, now = Date.now()) {
  return db.transaction(() => {
    const runs = sql(db, "DELETE FROM watch_runs WHERE id IN (SELECT id FROM watch_runs WHERE finished_at<? ORDER BY finished_at LIMIT 1000)").run(now - 90 * DAY).changes;
    // Incident/job-linked revisions and current heads are never pruned.
    const evidenceCount = sql(db, "DELETE FROM watch_evidence WHERE id IN (SELECT e.id FROM watch_evidence e WHERE e.observed_at<? AND NOT EXISTS (SELECT 1 FROM watch_items i WHERE i.evidence_id=e.id) AND NOT EXISTS (SELECT 1 FROM watch_incident_evidence l WHERE l.evidence_id=e.id) AND NOT EXISTS (SELECT 1 FROM watch_evidence_edges g WHERE g.successor=e.id OR g.predecessor=e.id) AND NOT EXISTS (SELECT 1 FROM watch_evidence_references r WHERE r.successor=e.id) ORDER BY e.observed_at LIMIT 1000)").run(now - 90 * DAY).changes;
    return { runs, evidence: evidenceCount };
  }).immediate();
}
module.exports = { openWatchDb, syncSources, listDueSources, claimRun, finishRun, recordSourceResult, recordSourceFailure, claimInvestigation, completeInvestigation, failInvestigation, getWatchSnapshot, getIncident, reviewIncident, pruneWatch, getInvestigationBudget };
