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
| `apocalypse-ews-backup.timer` | `backup_databases.js` — `VACUUM INTO data/backups/<day>/` for all three DBs, integrity-checked, 14 days kept; staleness feeds the status verdict (and therefore the watchdog). Restore = stop service, copy the day's file over `data/*.sqlite`, start | daily 02:10 |
| `cloudflared.service` | Cloudflare tunnel `apocalypse-ews` (id `d27a04ac-5b8a-4d84-a4c9-ccf61978694d`) — serves <https://warning.watch> from loopback:3030 and <https://ntfy.warning.watch> from loopback:2586 with no open inbound ports. Installed via `cloudflared service install <token>`; ingress config lives in the CF dashboard/API (`config_src: cloudflare`), not on disk | always on |
| `ntfy.service` | self-hosted ntfy 2.27.0 (`/etc/ntfy/server.yml`): loopback:2586, `auth-default-access: read-only`, user `publisher` has rw on both topics, `upstream-base-url: ntfy.sh` for iOS instant delivery. Auth DB `/var/lib/ntfy/user.db`. Box-side publishers use `EWS_NTFY_SERVER=http://127.0.0.1:2586` (loopback survives a tunnel outage; subscribers reconnect and receive cached messages) | always on |
| `apocalypse-ews-canary.timer` | `canary_delivery.js` — synthetic end-to-end proof through the **public** path: site health, RSS, and an ops-topic ntfy publish polled back as a subscriber would. Deliberately the opposite path from the watchdog (loopback), so each pages when the other's path dies. Failure leaves the unit `failed`, which the status verdict flags | weekly Mon 17:00 UTC |

**Public site: <https://warning.watch>** (apoc.watch and earlywarning.watch
301-redirect there). All three domains are on Xyra's Porkbun account with
nameservers at Cloudflare (zones on the Xyrasinclair@gmail.com account);
`EWS_PUBLIC_URL=https://warning.watch` in `/etc/apocalypse-ews.env` makes
confirmation and management links absolute.

Endpoints (public via the tunnel, or loopback via `ssh -L 3030:127.0.0.1:3030
xyra-dev-hetzner`):

- Dashboard: <https://warning.watch/> (UI), `/dashboard.json`, `/military-dashboard.json`, `/untracked-dashboard.json`
- **RSS feed**: <https://warning.watch/rss.xml> — fires on emergency-level changes and alert events
- Ops/event feeds: `data/published/operations.json`, `event-signals.json`

Logs: `journalctl -u apocalypse-ews-refresh` (and the other unit names).

Deploying a change: commit and push to `main`, then

```sh
ssh xyra-dev-hetzner 'cd /opt/dev/apocalypse-ews && sudo -u xyra git pull --ff-only && sudo -u xyra npm ci && systemctl restart apocalypse-ews.service'
# unit-file changes additionally need:
#   cp config/systemd/* /etc/systemd/system/ && systemctl daemon-reload
```

## Signal semantics

- `emergencyLevel` 1–5 from concurrent-airborne deviation vs. a weekday×slot
  seasonal baseline (7-day/336-sample minimum warm-up, US-holiday calendar
  model, alarm threshold self-calibrated to the second-highest historical
  daily peak); level ≥ `EWS_ANOMALY_ALERT_LEVEL` (default 5) generates an
  alert event.
- Takeoff-rate anomaly (`takeoff-rate-seasonal-robust`): live-process window
  count vs a (weekday/weekend × slot-of-day) median/MAD baseline over
  `EWS_TAKEOFF_RATE_LOOKBACK_DAYS` (28), z ≥ 3.5 → elevated, ≥ 4.5 high,
  ≥ 6 critical. **Both numerator and baseline count only
  `source='adsbx_heatmap'` events** — trace-backfilled events (`adsbx_history`,
  ~45× denser, written by repair with sub-slot timestamps) are a different
  counting process and are excluded, so a repair pass touching the current
  window cannot manufacture a false critical.
- `sustained_shift` (CUSUM): S ← max(0, S + σ-shift − k) per slot over the
  concurrent signal; crossing `EWS_CUSUM_THRESHOLD` (8) fires high, crossing
  `EWS_CUSUM_CRITICAL` (12) fires critical; re-arms after S falls below half
  the threshold. Catches slow exoduses that never spike the instantaneous
  gauge. State in `meta` key `cusum_state:<cohort>`.
- L0 data-quality gate: the live ingester records the global feed total per
  slot in `ingest_slots`; if the current slot carries under
  `EWS_DATA_QUALITY_MIN_RATIO` (0.6) × the 14-day same-slot median, all
  statistical events are suppressed and a `data_quality` event is emitted
  instead — an infrastructure failure must not read as an exodus.
- Detection is calm-by-default: no baseline → no alert (fail-quiet, not
  fail-noisy); degraded feed → suppressed + surfaced, never scored.
- `npm run backtest -- --db data/ews-main.sqlite --cohort global_business_jet
  --inject-exodus` replays history through the production code paths:
  frequency tables for every layer plus the 3×-exodus injection acceptance
  test (must reach level 5 within 60 minutes).

## Subscription channels

| Channel | Status | Needs |
|---|---|---|
| RSS | **live on the box** | nothing |
| Web dashboard | **live publicly at <https://warning.watch>** (Cloudflare tunnel; box keeps zero open inbound ports) | nothing |
| **ntfy public push** | **live, self-hosted with write auth** — subscribe to `https://ntfy.warning.watch/apocalypse-ews-alerts` in the ntfy app. Anonymous read, writes require the publisher token (`EWS_NTFY_TOKEN`), so the old ntfy.sh public-write spoof vector is closed. Publishes elevated+ only (`scripts/publish_ntfy_alert.js`) | nothing |
| **ntfy ops watchdog** | **live, self-hosted** — subscribe to `https://ntfy.warning.watch/apocalypse-ews-ops`; unhealthy verdicts and recoveries only | nothing |
| Owner push (xmsg → iMessage/email/desktop by severity) | retired with the laptop deployment (xmsg is Mac-only; `notify_local_push.js` silently no-ops on the box) | a box-reachable owner channel, if ever wanted |
| Telegram channel | token wired (@XyraClawdBot, reused from xyra_claw — sends don't conflict with its polling) | one 45-second phone step: create channel, add bot as admin, set `TELEGRAM_CHANNEL` in `.env` |
| Email (SendGrid) | code ready, **double opt-in enforced** (signup sends a confirm link; only confirmed addresses are ever alerted; without `SENDGRID_API_KEY` the confirm path is logged to the journal instead) | production deploy (below) |
| SMS (Telnyx) | code ready, **double opt-in enforced** (same as email; without `TELNYX_API_KEY` the confirm path is logged) | production deploy (below) |
| Browser push (VAPID) | keys generated in `.env` | production deploy (below) |
| Paid signup (Stripe) | code ready | production deploy (below) |

## Activating email/SMS delivery

Everything generable is already configured on the box (VAPID keypair,
`INTERNAL_ALERT_TOKEN`, `NOTIFICATION_HASH_SECRET`,
`NOTIFICATION_ENCRYPTION_KEY`, `EWS_PUBLIC_URL=https://warning.watch`).
The irreducible credentials — add to `/etc/apocalypse-ews.env` when the
provider accounts exist, then `systemctl restart apocalypse-ews.service`:

1. `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` (email; `SENDGRID_WEBHOOK_PUBLIC_KEY`
   for delivery-status callbacks)
2. `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_NUMBER` (SMS — deferred per
   ROADMAP §3; A2P compliance is the cost, not the vendor)

On activation, run `sendPendingConfirmations` for subscribers who registered
while delivery was dark, so their double-opt-in confirmations actually go out.

The refresh loop bridges alert events to an external webhook only when
`EWS_ALERT_EVENTS_WEBHOOK_URL` is **explicitly** set; it no-ops otherwise
(`missing_EWS_ALERT_EVENTS_WEBHOOK_URL`). It is never derived from
`APP_BASE_URL`/`EWS_PUBLIC_URL` — display URLs once pointed the bridge at
the upstream reference site.

## Codebase map (for cold-start agents)

- **`server/` + `scripts/` is the implementation** — the Express server,
  ingestion, detection, and all channel publishers. This is what runs.
- The former `functions/` + `workers/` Cloudflare Pages/D1 parallel
  implementation was **retired 2026-08-28** per ROADMAP §4 (recoverable from
  git history if ever needed). There is exactly one implementation now.
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
