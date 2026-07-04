# Operations — Apocalypse EWS

The signal: sustained anomalies in the number of business jets simultaneously
airborne (the "elite exodus" cohort, 31k+ tracked airframes), plus batch-takeoff
rate anomalies (z-score over a 28-day baseline), across three cohorts:
`global_business_jet`, `global_military_aircraft`, `non_icao_untracked`.

## What runs on this machine (installed 2026-07-03)

Two launchd agents (in `~/Library/LaunchAgents/`):

| Agent | What | Cadence |
|---|---|---|
| `com.xyra.apocalypse-ews.refresh` | `node scripts/refresh_all_snapshots.js` → full pipeline pass (ingest ADS-B slot → snapshots → detection → RSS/Telegram/dispatch/bridge → feeds) | every 10 min (lock-guarded in-script; skips if no new 30-min slot) |
| `com.xyra.apocalypse-ews.server` | `server/index.js` Express server | always on (KeepAlive) |

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

## Known operational notes

- ADS-B ingest is the free ADSBx globe-history heatmap: 30-min slots, no key.
- `scripts/backfill_history.py` defaults to `--days 365`; always pass
  `--start-date/--end-date` for gap repair.
- All Node DB opens set `busy_timeout = 30000` (2026-07-03 fix) so the server
  and pipeline survive long writer transactions (backfills).
- History gaps stall the takeoff-rate model (needs 336 samples / 7 days); the
  concurrent-anomaly model likewise needs 7 days of continuous samples.
