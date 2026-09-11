#!/usr/bin/env node

const Database = require('better-sqlite3');
const { KIND, openCbrnDb, robustStats, robustZ, readAlarmState, writeAlarmState, buildCbrnEvent } = require('./cbrn_lib');
const { options, matcher, saveEvents } = require('./detect_cbrn_notices');
const lexicon = require('../config/cbrn-lexicon.json');
const HOUR = 3600000;
const DAY = 24 * HOUR;
const STREAMS = ['gdelt-reporting', 'bluesky-posts'];
const TERMS = [...new Set(Object.values(lexicon.terms).flat())].map((term) => [term, matcher(term)]);
const PLACES = Object.entries(lexicon.places).map(([place, forms]) => [place, forms.map(matcher)]);
const countryNames = new Map(Object.entries(lexicon.places).flatMap(([place, forms]) => forms.map((form) => [form.normalize('NFKC').toLowerCase(), place])));

function detect(watch, db, settings, now = Date.now()) {
  const hour = Math.floor(now / HOUR) * HOUR;
  // Refresh complete overlapping hours, so repeated rolling-window runs never truncate a bucket.
  const since = Math.floor((now - settings.minutes * 60000) / HOUR) * HOUR;
  const summary = { detector: 'cbrn_lexical', dry_run: settings.dryRun, heads: {}, scanned: {}, matched: {}, regions: [], buckets: 0, warming: [], suppressed: [], events: 0, events_written: 0, events_escalated: 0, invalid: 0, unavailable: [], coverage: 'Current heads only; scan extends to the start of the oldest overlapping UTC hour. GDELT geography is publisher country, not event location. Bluesky geography is title place-name matching, not geolocation. Unmatched geography is recorded only as global and can never alert. Coverage is partial and platform-biased; missing hours are not zero samples. post_count counts distinct vocabulary-matched observations; surface forms count once per observation. No post bodies retained.' };
  const buckets = new Map();
  const events = [];
  const states = [];
  const known = db.prepare('SELECT DISTINCT stream, region FROM cbrn_lexical_buckets WHERE bucket_start >= ?').all(new Date(hour - 14 * DAY).toISOString());
  const make = (stream, region, time) => {
    const key = JSON.stringify([stream, region, time]);
    if (!buckets.has(key)) buckets.set(key, { stream, region, bucket_start: new Date(time).toISOString(), term_count: 0, post_count: 0, terms: new Map() });
    return buckets.get(key);
  };
  for (const stream of STREAMS) {
    summary.heads[stream] = watch.prepare('SELECT count(*) AS n FROM watch_items WHERE source_id = ?').get(stream).n;
    summary.scanned[stream] = 0;
    summary.matched[stream] = 0;
    if (!summary.heads[stream]) summary.unavailable.push(stream);
    const rows = watch.prepare('SELECT e.* FROM watch_items i JOIN watch_evidence e ON e.id = i.evidence_id WHERE i.source_id = ? AND e.observed_at >= ? AND e.observed_at <= ? ORDER BY e.observed_at, e.id').all(stream, since, now);
    const activeHours = new Set();
    const observedRegions = new Set();
    for (const row of rows) {
      summary.scanned[stream] += 1;
      let o;
      try { o = JSON.parse(row.observation); } catch { summary.invalid += 1; continue; }
      if (!o || typeof o !== 'object') { summary.invalid += 1; continue; }
      if (o.status === 'cancelled') continue;
      const text = String(o.title || '').normalize('NFKC');
      let places;
      if (stream === 'gdelt-reporting') {
        const country = typeof o.data?.publisherCountry === 'string' ? o.data.publisherCountry.trim().normalize('NFKC') : '';
        // Preserve the publisher's supplied country instead of inventing a location from article text.
        places = country ? [countryNames.get(country.toLowerCase()) || country] : ['global'];
      } else {
        places = PLACES.filter(([, patterns]) => patterns.some((pattern) => pattern.test(text))).map(([place]) => place);
        if (!places.length) places = ['global'];
      }
      const matched = TERMS.filter(([, pattern]) => pattern.test(text)).map(([term]) => term);
      const bucketTime = Math.floor(row.observed_at / HOUR) * HOUR;
      activeHours.add(bucketTime);
      if (matched.length) summary.matched[stream] += 1;
      for (const region of places) {
        observedRegions.add(region);
        const bucket = make(stream, region, bucketTime);
        if (matched.length) bucket.post_count += 1;
        bucket.term_count += matched.length;
        for (const term of matched) bucket.terms.set(term, (bucket.terms.get(term) || 0) + 1);
      }
    }
    // Explicit zeros require evidence that the stream was actually observed in that hour.
    for (const region of new Set([...observedRegions, ...known.filter((entry) => entry.stream === stream).map((entry) => entry.region)])) {
      for (const time of activeHours) make(stream, region, time);
    }
  }
  const baseline = db.prepare('SELECT bucket_start, term_count FROM cbrn_lexical_buckets WHERE stream = ? AND region = ? AND bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start');
  for (const bucket of buckets.values()) {
    bucket.terms_json = JSON.stringify(Object.fromEntries([...bucket.terms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)));
    delete bucket.terms;
    if (Date.parse(bucket.bucket_start) !== hour || bucket.region === 'global') continue;
    const samples = baseline.all(bucket.stream, bucket.region, new Date(hour - 14 * DAY).toISOString(), new Date(hour).toISOString()).filter((row) => new Date(row.bucket_start).getUTCHours() === new Date(hour).getUTCHours()).map((row) => row.term_count);
    if (samples.length < 10) { summary.warming.push({ stream: bucket.stream, region: bucket.region, samples: samples.length, required: 10 }); continue; }
    const stats = robustStats(samples);
    const z = robustZ(bucket.term_count, stats, 1.0);
    if (!(z > 0) || bucket.term_count < 8 || bucket.post_count < 3 || bucket.term_count < 3 * stats.median) continue;
    const level = bucket.term_count >= 25 && bucket.post_count >= 8 ? 4 : 3;
    const series = `lexical:${bucket.stream}:${bucket.region}`;
    const state = readAlarmState(db, series, 'burst');
    const history = (Array.isArray(state?.history) ? state.history : []).filter((entry) => Number.isFinite(entry.at) && entry.at >= hour - 6 * HOUR && entry.at <= hour);
    if (history.some((entry) => entry.at === hour || (entry.at > hour - 6 * HOUR && entry.level >= level))) {
      summary.suppressed.push({ stream: bucket.stream, region: bucket.region, level, reason: 'Already fired this hour or at the same/higher severity in the preceding six hours' });
      continue;
    }
    events.push(buildCbrnEvent({ kind: KIND.LEXICAL_BURST, level, occurredAt: new Date(now).toISOString(), title: `CBRN vocabulary burst: ${bucket.region}`, message: `${bucket.stream}, ${bucket.region}: ${bucket.term_count} matched surface forms across ${bucket.post_count} distinct matched observations this UTC hour. The trailing 14-day same-hour baseline median is ${stats.median}, from ${samples.length} historical samples (robust z ${z.toFixed(2)}, scale floor 1.0). This is a count of matched vocabulary on one platform or index; it is not verified reporting. Coverage is partial and platform-biased, and this stream is not established to precede official reporting. ${bucket.stream === 'gdelt-reporting' ? 'The place is publisher country, not incident location.' : 'The place is a name mentioned in the title, not verified incident geography.'} Corroborating official notices, independent measurements and sustained geographically verified reporting would change the assessment; a falling vocabulary count alone would not establish safety.`, source: bucket.stream, keyParts: [bucket.stream, bucket.region, bucket.bucket_start].map(encodeURIComponent), payload: { stream: bucket.stream, region: bucket.region, bucket_start: bucket.bucket_start, term_count: bucket.term_count, post_count: bucket.post_count, terms: JSON.parse(bucket.terms_json), baseline_median: stats.median, baseline_samples: samples.length, baseline_days: 14, z, scale_floor: 1, minimum_posts: 3, minimum_terms: 8, median_multiplier: 3, high_terms: 25, high_posts: 8 }, action: 'Check local official notices and independent observations. Do not take protective medication or infer a release from vocabulary counts alone; follow any local authority protective instruction.' }));
    states.push({ series, method: 'burst', state: { history: [...history, { at: hour, level }] } });
  }
  summary.regions = [...new Set([...buckets.values()].map((bucket) => bucket.region))].sort();
  summary.buckets = buckets.size;
  summary.events = events.length;
  return { summary, events, states, buckets: [...buckets.values()] };
}

function main() {
  const settings = options(process.argv.slice(2), 120);
  const watch = new Database(settings.watchDb, { readonly: true, fileMustExist: true });
  let db;
  let eventsDb;
  try {
    db = openCbrnDb({ dbPath: settings.cbrnDb, readonly: settings.dryRun });
    const result = detect(watch, db, settings);
    if (settings.dryRun) {
      for (const event of result.events) console.log(JSON.stringify(event));
    } else {
      eventsDb = new Database(settings.eventsDb, { fileMustExist: true });
      saveEvents(eventsDb, result);
      // Events first: state must never suppress an event that failed to persist.
      db.transaction(() => {
        const save = db.prepare('INSERT INTO cbrn_lexical_buckets (stream, region, bucket_start, term_count, post_count, terms_json) VALUES (@stream, @region, @bucket_start, @term_count, @post_count, @terms_json) ON CONFLICT(stream, region, bucket_start) DO UPDATE SET term_count = excluded.term_count, post_count = excluded.post_count, terms_json = excluded.terms_json');
        for (const bucket of result.buckets) save.run(bucket);
        for (const entry of result.states) writeAlarmState(db, entry.series, entry.method, entry.state);
      })();
    }
    console.log(JSON.stringify(result.summary));
  } finally { watch.close(); db?.close(); eventsDb?.close(); }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { detect };
