#!/usr/bin/env node
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnvFile } = require('../server/env');
loadEnvFile();
if (process.env.EWS_WATCH_ENV_PATH) loadEnvFile(process.env.EWS_WATCH_ENV_PATH);
const { DATA_DIR } = require('../server/config');
const { SOURCE_DEFINITIONS, collectSource } = require('../server/watch-sources');
const {
  openWatchDb, syncSources, listDueSources, claimRun, finishRun,
  recordSourceResult, recordSourceFailure, claimInvestigation,
  completeInvestigation, failInvestigation, getWatchSnapshot,
  getInvestigationBudget, pruneWatch,
} = require('../server/watch-store');
const { investigateIncident, getAgentConfiguration } = require('../server/watch-agents');

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function options() {
  const result = { force: false, collectOnly: false, sourceIds: [], maxInvestigations: 1 };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') result.force = true;
    else if (arg === '--collect-only') result.collectOnly = true;
    else if (arg === '--source') {
      const id = args[++index];
      if (!SOURCE_DEFINITIONS.some((source) => source.id === id && source.enabled)) {
        throw new Error('The requested --source is not an enabled registry source.');
      }
      result.sourceIds.push(id);
    } else if (arg === '--max-investigations') {
      result.maxInvestigations = integer(args[++index], '--max-investigations', 0, 2);
    } else throw new Error(`Unknown watch option: ${arg}`);
  }
  result.dailyLimit = integer(process.env.EWS_WATCH_DAILY_INVESTIGATIONS || '12', 'EWS_WATCH_DAILY_INVESTIGATIONS', 0, 24);
  return result;
}

async function run() {
  const settings = options();
  const db = openWatchDb();
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const runController = new AbortController();
  const deadline = setTimeout(() => runController.abort(new Error('Watch run exceeded its 210-second work bound.')), 210_000);
  const interrupt = () => runController.abort(new Error('Watch run interrupted.'));
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  let claimed = false;
  const summary = {
    startedAt: new Date(startedAt).toISOString(), lastError: null,
    summary: '', openQuestions: [], coverageGaps: [],
    agent: getAgentConfiguration(process.env),
    collection: { sources: 0, inserted: 0, changed: 0, incidentsOpened: 0, failures: [] },
    investigations: { completed: 0, failed: 0 },
  };
  try {
    if (!claimRun(db, owner, startedAt, 270_000)) {
      console.log(JSON.stringify({ ok: true, skipped: 'Another watch run holds the durable lease.' }));
      return;
    }
    claimed = true;
    syncSources(db, SOURCE_DEFINITIONS, startedAt);
    const due = listDueSources(db, SOURCE_DEFINITIONS, startedAt, { force: settings.force })
      .filter((source) => !settings.sourceIds.length || settings.sourceIds.includes(source.id));
    const publishedDir = process.env.EWS_PUBLISHED_DIR
      ? path.resolve(process.env.EWS_PUBLISHED_DIR) : path.join(DATA_DIR, 'published');
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
      while (next < due.length && !runController.signal.aborted) {
        const source = due[next++];
        const signal = AbortSignal.any([runController.signal, AbortSignal.timeout(25_000)]);
        summary.collection.sources += 1;
        try {
          const result = await collectSource(source, { now: Date.now(), signal, publishedDir, cursor: source.cursor || null });
          signal.throwIfAborted();
          const counts = recordSourceResult(db, source.id, result);
          summary.collection.inserted += counts.inserted;
          summary.collection.changed += counts.changed;
          summary.collection.incidentsOpened += counts.incidentsOpened;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Source collection failed.';
          recordSourceFailure(db, source.id, message);
          summary.collection.failures.push({ sourceId: source.id, error: message });
        }
      }
    }));
    runController.signal.throwIfAborted();
    if (!settings.collectOnly && summary.agent.configured) {
      for (let index = 0; index < settings.maxInvestigations; index += 1) {
        // Do not claim work that cannot finish within the remaining run lease.
        if (Date.now() - startedAt > 105_000) break;
        const incident = claimInvestigation(db, owner, Date.now(), 180_000, { dailyLimit: settings.dailyLimit });
        if (!incident) break;
        try {
          const result = await investigateIncident(incident, { env: process.env, signal: runController.signal });
          completeInvestigation(db, incident.id, owner, result);
          summary.investigations.completed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Investigation failed.';
          const audit = error?.model && error?.usage ? { model: error.model, usage: error.usage } : null;
          failInvestigation(db, incident.id, owner, message, Date.now(), audit);
          summary.investigations.failed += 1;
          summary.lastError = message;
        }
      }
    }
    summary.budget = getInvestigationBudget(db, settings.dailyLimit);
    const snapshot = getWatchSnapshot(db, { internal: true });
    summary.openQuestions = snapshot.incidents
      .filter((incident) => incident.status === 'open')
      .map((incident) => incident.title).slice(0, 12);
    summary.coverageGaps = snapshot.sources.filter((source) => source.health !== 'healthy')
      .map((source) => `${source.name}: ${source.health}${source.lastError ? ` — ${source.lastError}` : ''}`);
    if (!summary.agent.configured) summary.coverageGaps.push(`Machine investigations unavailable: ${summary.agent.reason}`);
    if (!summary.budget.remaining && snapshot.counts.pending) summary.coverageGaps.push('Daily investigation allowance exhausted; collection continues and pending work is retained.');
    if (settings.collectOnly) summary.coverageGaps.push('This pass was explicitly collection-only.');
    summary.summary = `${summary.collection.sources} sources checked; ${summary.collection.inserted} new observations, ${summary.collection.changed} revisions; ${summary.investigations.completed} machine investigations completed. Investigation priority is not a threat assessment.`;
    if (summary.collection.failures.length) summary.lastError = `${summary.collection.failures.length} source collections failed${summary.lastError ? `; ${summary.lastError}` : ''}.`;
    summary.retention = pruneWatch(db);
  } catch (error) {
    summary.lastError = error instanceof Error ? error.message : 'Watch run failed.';
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    if (claimed) {
      summary.finishedAt = new Date().toISOString();
      summary.durationMs = Date.now() - startedAt;
      finishRun(db, owner, summary);
      console.log(JSON.stringify({ ok: !summary.lastError, ...summary }));
      if (summary.lastError) process.exitCode = 1;
    }
    db.close();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Watch startup failed.');
  process.exitCode = 1;
});
