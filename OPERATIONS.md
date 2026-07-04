# Operations — Apocalypse EWS

The signal: sustained anomalies in the number of business jets simultaneously
airborne (the "elite exodus" cohort, 31k+ tracked airframes), plus batch-takeoff
rate anomalies (z-score over a 28-day baseline), across three cohorts:
`global_business_jet`, `global_military_aircraft`, `non_icao_untracked`.

## Re-entry protocol (start here after any absence)

```sh
npm run status        # one JSON report: cohort freshness, baselines, services, verdict
```

If `verdict.healthy` is true, the system has been running the whole time and
there is nothing to do. If not, the `problems` array names each issue and its
fix. The common one after the laptop was off is stale history — the repair
agent fixes it automatically within 6 hours, or force it now:

```sh
npm run repair:gaps   # detects + backfills missing history, bounded to 30 days
```

Continuation work is tracked as beads: `br ready` lists what is unblocked
(see ROADMAP.md for the full arc). The single most valuable next step is
Phase 2: move this off the laptop onto a Hetzner box.

## What runs on this machine (installed 2026-07-03/04)

Three launchd agents (in `~/Library/LaunchAgents/`):

| Agent | What | Cadence |
|---|---|---|
| `com.xyra.apocalypse-ews.refresh` | `node scripts/refresh_all_snapshots.js` → full pipeline pass (ingest ADS-B slot → snapshots → detection → RSS/Telegram/dispatch/bridge → owner push → ntfy → feeds) | every 10 min (lock-guarded in-script; skips if no new 30-min slot) |
| `com.xyra.apocalypse-ews.server` | `server/index.js` Express server | always on (KeepAlive) |
| `com.xyra.apocalypse-ews.repair` | `node scripts/repair_history_gaps.js` — self-healing: detects history holes (laptop sleep) and backfills exactly the missing range | every 6 h + on load |

Local endpoints (subscribe-able today, no credentials needed):

- Dashboard: <http://127.0.0.1:3030/> (UI), `/dashboard.json`, `/military-dashboard.json`, `/untracked-dashboard.json`
- **RSS feed**: <http://127.0.0.1:3030/rss.xml> — any feed reader; fires on emergency-level changes and alert events
- Ops/event feeds: `data/published/operations.json`, `event-signals.json`

Logs: `data/logs/refresh.launchd.log`, `data/logs/server.launchd.log`.

Note: the agents invoke the nvm `node` binary directly — macOS TCC denies
`/bin/sh` scripts under `~/Documents` in the launchd context, so shell wrappers
do not work here; the overlap lock lives inside `refresh_all_snapshots.js`.

Manage:

```sh
launchctl bootout   gui/$UID/com.xyra.apocalypse-ews.refresh   # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.xyra.apocalypse-ews.refresh.plist  # start
```

## Signal semantics

- `emergencyLevel` 1–5 from concurrent-airborne deviation vs. a 7-day (336-sample)
  baseline; level ≥ `EWS_ANOMALY_ALERT_LEVEL` (default 5) generates an alert event.
- Takeoff-batch anomaly: ≥ N takeoffs in a 30-min window with rate z-score ≥ 3.5
  vs. 28-day lookback (min 7 days of history) → level-4 event.
- Detection is calm-by-default: no baseline → no alert (fail-quiet, not fail-noisy).

## Subscription channels

| Channel | Status | Needs |
|---|---|---|
| RSS | **live locally** | nothing |
| Web dashboard | **live locally** | nothing |
| Owner push (xmsg → iMessage/email/desktop by severity) | **live locally** | nothing — `scripts/notify_local_push.js`, cursor in meta table |
| **ntfy public push** | **live** | nothing — topic `apocalypse-ews-alerts-caaea5` on ntfy.sh; subscribers install the ntfy app and subscribe to the topic. Publishes elevated+ only (`scripts/publish_ntfy_alert.js`). Caveat: ntfy.sh topics are public-write; self-host with auth on the Hetzner box (Phase 2) to close the spoof vector |
| Telegram channel | token wired (@XyraClawdBot, reused from xyra_claw — sends don't conflict with its polling) | one 45-second phone step: create channel, add bot as admin, set `TELEGRAM_CHANNEL` in `.env` |
| Email (SendGrid) | code ready | production deploy (below) |
| SMS (Telnyx) | code ready | production deploy (below) |
| Browser push (VAPID) | keys generated in `.env` | production deploy (below) |
| Paid signup (Stripe) | code ready | production deploy (below) |

## Production deploy (Cloudflare Pages + D1 + maintenance worker)

Everything generable is already in `.env` (VAPID keypair, `INTERNAL_ALERT_TOKEN`,
`NOTIFICATION_HASH_SECRET`, `NOTIFICATION_ENCRYPTION_KEY`). The irreducible
credentials — fill these in `.env`:

1. `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`
2. `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (Access service token for smoke)
3. `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_WEBHOOK_PUBLIC_KEY`
4. `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_NUMBER`
5. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`
6. `EWS_SMOKE_TEST_EMAIL`, `EWS_SMOKE_TEST_PHONE` (live end-to-end proof targets)
7. `EWS_PUBLIC_URL` / `APP_BASE_URL` — **your** domain. `wrangler.toml` currently
   carries the upstream reference deployment's domain (`ews.kylemcdonald.net`);
   change before deploying.

Then:

```sh
npm run check:deploy          # validates every var + formats
npm run seed:production-env   # pushes secrets to Pages + worker
npm run deploy:pages          # build, D1 migrations, deploy, worker cron
npm run smoke:live            # Access-authed live smoke
npm run smoke:pages-pipeline  # signup → alert → fanout, real providers
```

The local refresh loop bridges alert events to production automatically once
`EWS_ALERT_EVENTS_WEBHOOK_URL` (or `APP_BASE_URL`) is set — the bridge no-ops
until then (`missing_EWS_ALERT_EVENTS_WEBHOOK_URL`).

## Codebase map (for cold-start agents)

- **`server/` + `scripts/` is the real implementation** — the Express server,
  ingestion, detection, and all channel publishers. This is what runs.
- **`functions/` + `workers/` is a PARALLEL implementation** for Cloudflare
  Pages/D1 (signup, Stripe, SendGrid/Telnyx fanout). It duplicates large parts
  of the logic (`functions/_lib/db.js` ~106KB). ROADMAP.md recommends retiring
  it in favor of one Hetzner box; do not extend both sides.
- `scripts/refresh_all_snapshots.js` is the pipeline entrypoint and the
  authoritative ordering of stages.
- `detect_alert_events.js` writes `alert_events` rows (UNIQUE event_key,
  idempotent). Channel publishers each keep their own cursor in the `meta`
  table: `local_push_last_alert_id` (owner xmsg push, elevated+ paged),
  `ntfy_last_alert_id` (public ntfy topic, elevated+). Cursors advance past
  skipped events; a failed send halts cursor advance so the event retries.
- Severity ladder: watch < elevated < high < critical (see
  `severityForLevel` / `takeoffSeverityForZScore` in detect_alert_events.js).
- Python does ingestion/backfill (`update_latest_heatmap.py`,
  `backfill_history.py`, `track_non_icao_hex.py`); Node does everything else.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm run status` → history stale | machine was asleep/off | `npm run repair:gaps` (or wait ≤6 h for the repair agent) |
| SQLITE_BUSY crashes | long writer + missing busy_timeout on a new DB open | every `new Database()` must be followed by `pragma('busy_timeout = 30000')` |
| launchd agent "Operation not permitted" | macOS TCC denies `/bin/sh` under `~/Documents` | invoke the node binary directly in the plist (see existing plists) |
| refresh exits 1 on `export_event_signals_feed` | snapshot vs DB timestamp skew > 35 min | genuine staleness — check ingestion; the 35-min slot tolerance is intentional (untracked cohort rounds `sampled_at`) |
| backfill locks everything | running an unpatched/old backfill | range DELETEs must commit before the download phase (fixed 2026-07-03); never run with default `--days 365` |
| ntfy topic spammed | ntfy.sh topics are public-write | Phase 2: self-host ntfy with write auth on the Hetzner box; rotate topic |

## Known operational notes

- ADS-B ingest is the free ADSBx globe-history heatmap: 30-min slots, no key.
- `scripts/backfill_history.py` defaults to `--days 365`; always pass
  `--start-date/--end-date` for gap repair.
- All Node DB opens set `busy_timeout = 30000` (2026-07-03 fix) so the server
  and pipeline survive long writer transactions (backfills).
- History gaps stall the takeoff-rate model (needs 336 samples / 7 days); the
  concurrent-anomaly model likewise needs 7 days of continuous samples.
