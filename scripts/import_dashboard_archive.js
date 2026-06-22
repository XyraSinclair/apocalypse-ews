#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { db: null, file: null, url: null };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--file') {
      args.file = argv[++index];
    } else if (value === '--url') {
      args.url = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!args.db) {
    throw new Error('Missing required --db path.');
  }

  if (Boolean(args.file) === Boolean(args.url)) {
    throw new Error('Pass exactly one of --file or --url.');
  }

  return args;
}

async function readSnapshot(args) {
  if (args.file) {
    return JSON.parse(fs.readFileSync(args.file, 'utf8'));
  }

  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(`Snapshot fetch failed with HTTP ${response.status}: ${args.url}`);
  }

  return response.json();
}

function expandTimestampRuns(t0, runs) {
  if (!t0) {
    return [];
  }

  const timestamps = [t0];
  let currentTimestamp = Date.parse(t0);
  for (const [deltaMs, count] of runs || []) {
    for (let offset = 0; offset < count; offset += 1) {
      currentTimestamp += deltaMs;
      timestamps.push(new Date(currentTimestamp).toISOString());
    }
  }

  return timestamps;
}

function normalizeArchive(archive) {
  if (Array.isArray(archive)) {
    return archive;
  }

  if (!archive || archive.v !== 1) {
    throw new Error('Unsupported dashboard archive format.');
  }

  const timestamps = expandTimestampRuns(archive.t0, archive.tr);
  return timestamps.map((sampledAt, index) => ({
    sampledAt,
    concurrentCount: archive.c[index],
  })).filter((record) => sampledAtIsValid(record.sampledAt) && Number.isFinite(Number(record.concurrentCount)));
}

function sampledAtIsValid(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function importConcurrentMetrics(dbPath, records) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
    const statement = db.prepare(`
      INSERT INTO concurrent_metrics (sampled_at, concurrent_count)
      VALUES (?, ?)
      ON CONFLICT(sampled_at) DO UPDATE SET concurrent_count = excluded.concurrent_count
    `);
    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        statement.run(row.sampledAt, Math.round(Number(row.concurrentCount)));
      }
    });
    transaction(records);
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const snapshot = await readSnapshot(args);
  const records = normalizeArchive(snapshot.trends?.archive);
  importConcurrentMetrics(path.resolve(args.db), records);
  console.log(JSON.stringify({ ok: true, db: path.resolve(args.db), imported: records.length }));
}

main();
