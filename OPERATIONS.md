# Operations — Apocalypse EWS

The signal: sustained anomalies in the number of business jets simultaneously
airborne (the "elite exodus" cohort, 31k+ tracked airframes), plus batch-takeoff
rate anomalies (z-score over a 28-day baseline), across three cohorts:
`global_business_jet`, `global_military_aircraft`, `non_icao_untracked`.

## Re-entry protocol (start here after any absence)

The live deployment is on **xyra-dev-hetzner** at `/opt/dev/apocalypse-ews`
(a git checkout of this repo's `main`; the laptop checkout is development
only — its launchd agents were retired 2026-08-27).

```sh
ssh xyra-dev-hetzner 'cd /opt/dev/apocalypse-ews && npm run status'
```

If `verdict.healthy` is true, the system has been running the whole time and
there is nothing to do. If not, the `problems` array names each issue and its
fix. Stale history repairs itself within 6 hours via the repair timer, or
force it now:

```sh
ssh xyra-dev-hetzner 'systemctl start apocalypse-ews-repair.service'
```

The hourly watchdog pushes a plain-language note to the private ops ntfy
topic (`EWS_NTFY_OPS_TOPIC` in `/etc/apocalypse-ews.env`) whenever the
verdict goes unhealthy, and a recovery note when it heals — silence means
healthy, not unmonitored.

Continuation work is tracked as beads: `br ready` lists what is unblocked
(see ROADMAP.md for the full arc).

## What runs on xyra-dev-hetzner (migrated 2026-08-27)

Systemd units — canonical sources in `config/systemd/`, installed to
`/etc/systemd/system/`. Config in `/etc/apocalypse-ews.env` (not in git).

| Unit | What | Cadence |
|---|---|---|
| `apocalypse-ews.service` | `server/index.js` Express server on 127.0.0.1:3030 | always on |
| `apocalypse-ews-refresh.timer` | full pipeline pass (ingest ADS-B slot → snapshots → detection → RSS/dispatch/ntfy → feeds) | :05 and :35 |
| `apocalypse-ews-refresh-imports.timer` | same plus aircraft-metadata reimport | daily 00:29 |
| `apocalypse-ews-repair.timer` | `repair_history_gaps.js` — self-heals trailing gaps AND interior holes across all three cohorts, bounded to 30 days | every 6 h |
| `apocalypse-ews-watchdog.timer` | `ops_alert.js` — status verdict → ops ntfy topic (deduped, 6 h re-alert, recovery note) | hourly |

Endpoints on the box (loopback only; reach via `ssh -L 3030:127.0.0.1:3030
xyra-dev-hetzner`):

- Dashboard: <http://127.0.0.1:3030/> (UI), `/dashboard.json`, `/military-dashboard.json`, `/untracked-dashboard.json`
- **RSS feed**: <http://127.0.0.1:3030/rss.xml> — fires on emergency-level changes and alert events
- Ops/event feeds: `data/published/operations.json`, `event-signals.json`

Logs: `journalctl -u apocalypse-ews-refresh` (and the other unit names).

Deploying a change: commit and push to `main`, then

```sh
ssh xyra-dev-hetzner 'cd /opt/dev/apocalypse-ews && sudo -u xyra git pull --ff-only && sudo -u xyra npm ci && systemctl restart apocalypse-ews.service'
# unit-file changes additionally need:
#   cp config/systemd/* /etc/systemd/system/ && systemctl daemon-reload
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
| RSS | **live on the box** | nothing |
| Web dashboard | **live on the box** (loopback; ssh tunnel) | nothing |
| **ntfy public push** | **live from the box** | nothing — topic `apocalypse-ews-alerts-caaea5` on ntfy.sh; subscribers install the ntfy app and subscribe to the topic. Publishes elevated+ only (`scripts/publish_ntfy_alert.js`). Caveat: ntfy.sh topics are public-write; self-host ntfy with auth to close the spoof vector |
| **ntfy ops watchdog** | **live from the box** | `EWS_NTFY_OPS_TOPIC` in `/etc/apocalypse-ews.env`; unhealthy verdicts and recoveries only |
| Owner push (xmsg → iMessage/email/desktop by severity) | retired with the laptop deployment (xmsg is Mac-only; `notify_local_push.js` silently no-ops on the box) | a box-reachable owner channel, if ever wanted |
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

The refresh loop bridges alert events to production only when
`EWS_ALERT_EVENTS_WEBHOOK_URL` is **explicitly** set; it no-ops otherwise
(`missing_EWS_ALERT_EVENTS_WEBHOOK_URL`). It is never derived from
`APP_BASE_URL`/`EWS_PUBLIC_URL` — display URLs once pointed the bridge at
the upstream reference site.

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
| `npm run status` → history stale | box outage or upstream feed break | `systemctl start apocalypse-ews-repair.service` (or wait ≤6 h for the timer); if refresh itself is failing, `journalctl -u apocalypse-ews-refresh` |
| heatmap downloads return 403 | ADSBx CDN rejects requests without a globe `Referer` (enforced ~2026-07/08) | all fetch sites send `scripts/adsbx_http.py` `GLOBE_HEADERS`; if 403 returns with those headers, the fronting changed again — re-probe with browser headers |
| `import_global_cohort` JSON errors | upstream basic-ac-db ships occasional malformed JSONL lines | tolerated (skipped + counted) up to 0.5% of lines; above that the feed itself changed — inspect a fresh download |
| refresh exits 1 with `failedStages` | one alert channel or feed export failed | other stages already ran; the failed channel's cursor holds and retries next pass — fix the named stage |
| SQLITE_BUSY crashes | long writer + missing busy_timeout on a new DB open | every `new Database()` must be followed by `pragma('busy_timeout = 30000')` |
| refresh exits 1 on `export_event_signals_feed` | snapshot vs DB timestamp skew > 35 min | genuine staleness — check ingestion; the 35-min slot tolerance is intentional (untracked cohort rounds `sampled_at`) |
| backfill locks everything | running an unpatched/old backfill | range DELETEs must commit before the download phase (fixed 2026-07-03); never run with default `--days 365` |
| ntfy topic spammed | ntfy.sh topics are public-write | self-host ntfy with write auth; rotate topic |

## Known operational notes

- ADS-B ingest is the free ADSBx globe-history heatmap: 30-min slots, no key,
  but requests need the browser headers in `scripts/adsbx_http.py`.
- `scripts/backfill_history.py` defaults to `--days 365`; always pass
  `--start-date/--end-date` for gap repair.
- All Node DB opens set `busy_timeout = 30000` (2026-07-03 fix) so the server
  and pipeline survive long writer transactions (backfills).
- History gaps stall the takeoff-rate model (needs 336 samples / 7 days); the
  concurrent-anomaly model likewise needs 7 days of continuous samples.
