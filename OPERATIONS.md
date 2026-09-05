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

The two-minute watchdog pushes a plain-language note to the private ops ntfy
topic (`EWS_NTFY_OPS_TOPIC` in `/etc/apocalypse-ews.env`) whenever the
verdict goes unhealthy, and a recovery note when it heals. Its own timer and
delivery path must also remain healthy; silence alone proves neither.

Continuation work is tracked as beads: `br ready` lists what is unblocked
(see ROADMAP.md for the full arc).

## What runs on xyra-dev-hetzner (migrated 2026-08-27)

Systemd units — canonical sources in `config/systemd/` (incl.
`cloudflared.service`; ntfy config in `config/ntfy-server.yml`), installed to
`/etc/systemd/system/`. Config in `/etc/apocalypse-ews.env` (not in git).
**Fresh-box rebuild: `deploy/bootstrap.sh`** (run as root on Ubuntu 24.04;
idempotent; installs packages/units from the canonical sources and prints
TODOs for the two secrets it cannot invent — the env file and the tunnel
token).

| Unit | What | Cadence |
|---|---|---|
| `apocalypse-ews.service` | `server/index.js` Express server on 127.0.0.1:3030 | always on |
| `apocalypse-ews-refresh.timer` | incremental pass (check archive → ingest new slot → snapshots/detection once per sample → retry delivery → feeds) | every 2 min, single active pass |
| `apocalypse-ews-refresh-imports.timer` | same plus aircraft-metadata reimport | daily 00:29 |
| `apocalypse-ews-repair.timer` | `repair_history_gaps.js` — self-heals trailing gaps AND interior holes across all three cohorts, bounded to 30 days | every 6 h |
| `apocalypse-ews-watchdog.timer` | `ops_alert.js` — status verdict → ops ntfy topic (deduped, 6 h re-alert, recovery note) | every 2 min |
| `apocalypse-ews-backup.timer` | `backup_databases.js` — `VACUUM INTO data/backups/<day>/` for all three DBs, integrity-checked, 14 days kept; staleness feeds the status verdict (and therefore the watchdog). Restore = stop service, copy the day's file over `data/*.sqlite`, start. Off-box: manual sha256-verified copies land at `xyra-sanctuary:/srv/sanctuary/backups/apocalypse-ews/<day>/` (first: 2026-08-30; automation pending a box→sanctuary credential) | daily 02:10 |
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
ssh xyra-dev-hetzner 'cd /opt/dev/apocalypse-ews && sudo -u xyra git pull --ff-only && sudo -u xyra npm ci && sudo -u xyra npm run build && systemctl restart apocalypse-ews.service'
# unit-file changes additionally need:
#   cp config/systemd/* /etc/systemd/system/ && systemctl daemon-reload
```

## Assurance contract

This is a consequential public instrument, not a certified emergency-warning
system. Aircraft activity alone cannot establish that an attack is imminent or
that conditions are safe. No alert is not evidence of safety. Official emergency
instructions take precedence. Claims of "NASA-grade", certification, guaranteed
delivery, or a two-minute observation latency require evidence we do not yet have.

The standards below are engineering references, not a claim of conformance.
Apply their relevant controls to the existing code and release process; do not
add abstractions or paperwork that do not control an identified failure.

| Reference | Applicable obligation | Concrete evidence required here |
|---|---|---|
| [NASA NPR 7150.2D](https://nodis3.gsfc.nasa.gov/displayDir.cfm?t=NPR&c=7150&s=2D), §§3–5 | Requirements traceability, lifecycle planning, configuration control, peer review, defect management | Each changed requirement maps to source, an exercised scenario, a reviewed commit, and deployed revision; unresolved limits stay explicit |
| [NASA-STD-8739.8B](https://standards.nasa.gov/standard/NASA/NASA-STD-87398), §4 and Appendix A | Hazard analysis, software assurance, independent verification | Review missed alarms, false alarms, stale-as-calm output, partial cohorts, failed delivery, and recovery separately; an independent reviewer examines the release |
| IEEE 1012-2017, referenced by NASA-STD-8739.8B §2.2 | Verification and validation across normal, abnormal, and boundary conditions | Existing production-path replay plus direct ingestion, failure/recovery, and browser exercises; passing compilation is insufficient |
| [NIST SP 800-218 SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | Protect source, produce reviewed releases, manage dependencies and vulnerabilities | Locked installs, no unreviewed dependency upgrades, secret-free source and logs, small reversible commits |
| [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/) | Input validation, resource limits, access control, safe error handling | Feedback uses the existing validated intake; bounded text/media/request time; failures remain visible; possession tokens never enter feedback context |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Keyboard access, visible focus, understandable status, non-color-only meaning | Feedback opens/closes with keyboard and restores focus; narrow-screen rendering works; stale/unknown state is explicit text |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | HTTP method, failure, retry, and cache semantics | No automatic retries of an uncertain feedback POST; no success on a failed response; dynamic measurements are not served as fresh through a cache |

### Hazard controls and release floor

| Hazard | Required control | Remaining limitation |
|---|---|---|
| Late warning | Measure source observation age separately from poll age; bound polling, processing, and browser refresh independently | A 30-minute archive cannot supply two-minute observations, regardless of timer frequency |
| Dead instrument appears calm | Unknown/stale source timestamps invalidate current-status reassurance; one fresh cohort must not mask an older selected cohort | A recent sample is not proof of source completeness or absence of an emergency |
| Feed change manufactures an anomaly | Preserve supplier, cohort, sampling-window, and counting-process provenance; warm/calibrate a new feed separately | A smaller live feed cannot be compared directly with the current global archive baseline |
| Repeated polling manufactures an alarm | Deduplicate by source sample, not poll time; advance sequential state only on a new observation | External delivery is not a distributed exactly-once transaction |
| Slow/hung refresh consumes the schedule | Single active writer, bounded subprocess/network work, explicit timeout failure, no queued tick backlog | A missed deadline is degraded service, not a successful refresh |
| Partial pipeline hides failure | Publish complete files atomically; retain last known data; report failed stages; independent delivery channels remain independent | A retained old snapshot must still age into stale state |
| Lost or duplicated feedback | Existing durable Scry intake, acknowledgment only after stored success, preserve draft on errors, no blind POST retry | A lost acknowledgment is an uncertain outcome; intake is not an emergency dispatch channel |
| Unsafe release or recovery | Build the locked revision; exercise affected behavior before activation; record previous revision; preserve databases; fast-forward the deployed checkout | Backups alone do not prove restoration or eliminate single-host/provider failures |

For each release, record the scenario and observed outcome below the relevant
change entry. At minimum, a cadence change exercises no-new-data, new-data,
duplicate sample, overlapping invocation, and failure/recovery paths. A feedback
change exercises validation, backend failure, draft retention, keyboard use,
and narrow screens without posting synthetic correspondence to the live queue.
Existing replay checks defend alarm sensitivity and specificity; cadence work
does not authorize retuning their thresholds.

The release reviewer must distinguish controls actually exercised from controls
established only by inspection. Formal safety classification, independent
organizational assurance, measured availability/error budgets, restore drills,
source diversity, and validated attack-warning performance remain open
assurance work; this checklist does not certify them.

## Signal semantics

- `emergencyLevel` 1–5 from concurrent-airborne deviation vs. a weekday×slot
  seasonal baseline (7-day/336-sample minimum warm-up, US-holiday calendar
  model, alarm threshold self-calibrated to the second-highest historical
  daily peak); level ≥ `EWS_ANOMALY_ALERT_LEVEL` (default 5) generates an
  alert event. Slot baselines are **median + scaled-MAD**, not mean/stdDev:
  each weekly slot group holds one sample per week, and mean/variance stats
  let the live exodus being scored (present in its own baseline group) drag
  the mean and explode the sigma — a 3× injection scored σ2.4 under
  mean/stdDev vs σ27.9 under median/MAD.
- Takeoff-rate anomaly (`takeoff-rate-seasonal-robust`): live-process window
  count vs a (weekday/weekend × slot-of-day) median/MAD baseline over
  `EWS_TAKEOFF_RATE_LOOKBACK_DAYS` (28), z ≥ 3.5 → elevated, ≥ 4.5 high,
  ≥ 6 critical. **Both numerator and baseline count only
  `source='adsbx_heatmap'` events** — trace-backfilled events (`adsbx_history`,
  ~45× denser, written by repair with sub-slot timestamps) are a different
  counting process and are excluded, so a repair pass touching the current
  window cannot manufacture a false critical.
- `sustained_shift` (CUSUM): S ← max(0, S + σ-shift − k) per slot over the
  concurrent signal with k = `EWS_CUSUM_K` (1.5); crossing
  `EWS_CUSUM_THRESHOLD` (12) fires high, crossing `EWS_CUSUM_CRITICAL` (20)
  fires critical; re-arms after S falls below half the threshold. Catches
  slow exoduses that never spike the instantaneous gauge. Tuned 2026-08-28
  on 66 days of box data: fires high on exactly the two hottest real
  sustained days, never critical on history (peak S 16.1); a 3× exodus
  accumulates S≈13 in the first hour. State in `meta` key
  `cusum_state:<cohort>`. **First-year calendar gate:** inside a US-holiday
  window the calendar model has not yet learned (zero prior-year samples),
  CUSUM freezes — the year-one replay showed Thanksgiving/Christmas travel
  waves burning ~9 false criticals as genuine week-scale sustained shifts.
  The instantaneous and takeoff channels stay armed through the window,
  and the gate self-expires once a prior year's holiday samples teach the
  calendar ratio.
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
  test (must reach HIGH within 60 minutes and CRITICAL within 120, by
  either channel). Add `--assert` to enforce the instrument bounds below
  (non-zero exit on violation) — this is what the nightly selftest timer
  runs.

## Instrument bounds

Every alarm limit has a written basis and a place where it is enforced —
continuously, not once at commissioning. Sensitivity bounds (does a real
emergency fire?) and specificity bounds (does quiet data stay quiet?) are
asserted together so a change that buys one by selling the other fails
loudly.

| Bound | Value | Basis | Enforced by |
|---|---|---|---|
| Data age (any row) | ≤ 75 min | 30-min source cadence; retained as the source-outage bound, not a polling target | `status.js` → watchdog (2-min cadence) |
| Live-ingestion age | ≤ 75 min | same cadence; distinct from row age because repair heals rows without the live instrument running | `status.js` → watchdog |
| Live slots, trailing 24 h | ≥ 42/48 | live path should hit every slot; 6 misses/day means it is skipping | `status.js` → watchdog |
| Slot completeness, 30 d | ≥ 98 % | every expected slot is live, backfilled, or accounted missing | `status.js` → watchdog |
| 3× exodus → HIGH | ≤ 60 min | the reason the system exists; replayed nightly by injection | `backtest --assert` (selftest timer, 03:40 UTC) |
| 3× exodus → CRITICAL | ≤ 120 min | one 3× slot reads ~9–10σ while the self-calibrated alarm line sits at ~11σ (2nd-hottest real day — Dec 27 holiday wave hit 11.1σ with no apocalypse); sustain is what separates an exodus from a holiday wave, and CUSUM accumulates it past critical inside two hours (recalibrated 2026-08-30 on the full 365-day history) | `backtest --assert` |
| Takeoff false criticals | 0 in replay | critical is a paging severity; history contains no exodus | `backtest --assert` |
| Takeoff fires (all tiers) | ≤ 0.2/day | watch-tier noise budget | `backtest --assert` |
| CUSUM crossings | ≤ 1.5/30 d (critical ≤ 0.5/30 d) | sustained-shift pages must stay rare on real history | `backtest --assert` |
| Concurrent level-5 days | ≤ 1/30 d (level ≥ 4 ≤ 2/30 d) | threshold self-calibrates to 2nd-highest daily peak ⇒ ~1 alarm/yr as history deepens | `backtest --assert` |
| Detector warm | ≥ 336 scoreable slots | below a week of live baseline the takeoff channel cannot score | `backtest --assert` |

**Latency is a chain, not a timer setting.** Source observation → archive
publication (30-minute archive windows plus upstream release lag) → next poll
(target ≤2 min) → ingestion/scoring/delivery (measured per run) → subscriber or
browser refresh (browser target ≤1 min). An unavailable upstream archive has no
bounded release time; this is not a guaranteed two-minute warning system.
Sequential alarm bounds remain measured in source samples, not poll attempts.
The 75-minute source-age bound plus a healthy two-minute watchdog gives a
nominal ≤77-minute stale-source detection bound, excluding notification delivery.
Poll failures have a separate shorter bound in `status.js`.

### Live-source prerequisite

Genuine two-minute observations require an authorized **global** live snapshot,
including the non-ICAO namespace and a same-snapshot coverage denominator.
Changing suppliers or sampling semantics requires a separate provenance lane,
baseline warm-up, and calibration; never splice live counts into archive history.
No new feed subscription or access request was authorized by the cadence change.

| Candidate | Documented capability | Gate or incompatibility |
|---|---|---|
| [ADSBx live](https://www.adsbexchange.com/community/developer-hub/) / [API schema](https://gateway.adsbexchange.com/api/aircraft/v2/docs/openapi.json) | Global `/all` endpoint, readsb/ADSBx fields | Paid key and [publication/use permission](https://www.adsbexchange.com/acceptable-use-policy/); two-minute polling is 21,600 calls per 30 days |
| [adsb.fi open data](https://github.com/adsbfi/opendata/blob/main/README.md) | Global snapshot refreshed twice per minute | Feeder-IP authorization and personal/non-commercial terms; different coverage |
| [ADSB.lol full feed](https://www.adsb.lol/docs/feeders-only/re-api/) | Whole-network unfiltered data | Feeder-IP authorization; [public API](https://api.adsb.lol/docs) has no documented global `/all` and dynamic limits |
| [OpenSky REST](https://openskynetwork.github.io/opensky-api/rest.html) | Global state vectors | Anonymous 400 credits/day at 4/global query permits only 100/day, not 720; ICAO24 model is not the non-ICAO counting process; [operational-use agreement](https://opensky-network.org/about/terms-of-use) required |
| [ADSBHub](https://www.adsbhub.org/howtogetdata.php) | Contributing-station global SBS feed | Station/IP authorization; non-ICAO compatibility unestablished |

### Public feedback

The persistent Feedback form on the React pages uses Scry's existing anonymous
intake directly: `https://api.scry.io/v1/feedback` and `/v1/feedback/audio`,
tagged `channel=warning-watch`. It shares the existing operator queue rather
than creating another unmonitored store. Direct browser submission preserves
per-client abuse limits; a reverse proxy would collapse visitors onto one quota.
Text, voice, and images are bounded, and only a stored-success response clears
the draft. Uncertain delivery keeps the draft and warns that retry may duplicate.
Page context excludes query strings, fragments, and referrers. This channel is
not monitored in real time and is not an emergency dispatch service.

### Known assurance failure at the cadence change

The existing nightly replay ending 2026-09-04 18:45 Pacific failed its takeoff
noise bound: seven fires exceeded the configured 0.2/day allowance. The other
eight reported bounds passed, including injected HIGH at 30 minutes and CRITICAL
at 90 minutes. This predates the cadence change; thresholds were not loosened
and the failed service state was not cleared. Faster polling and successful
feedback verification do not resolve this detector-calibration finding.

The non-ICAO takeoff baseline has a second inherited limitation: concurrent
metrics use the within-slot peak timestamp, while live provenance and takeoffs
use the final slice. Its exact-timestamp joins can therefore exclude otherwise
valid slots. The cadence change preserves established peak-count semantics;
switching to final-slice counts would silently change the calibrated measurement.
A slot-aligned detector/backtest correction and replay are separate assurance
work. Historical non-ICAO scans no longer create new false live marks; existing
historical provenance was not rewritten by this release.

### Cadence release verification

Direct execution on an isolated copy of real data: one new archive ingested and
scored for all three cohorts in 4.04 seconds; an unchanged poll completed in
1.41 seconds without changing dashboard mtimes, takeoff counts, CUSUM state, or
observation clocks. Poll success advanced separately. A forced network refusal
exited nonzero without treating cached data as a successful poll; recovery cleared
the failure only after a successful pass. A competing invocation skipped while
the OS lock was held. Default and latest-only decoding returned identical latest
telemetry for a real 180-slice archive (5.82 seconds versus 0.042 seconds locally).
These are local measurements, not production latency guarantees.

The first production pass exposed a scale-dependent detector timeout: SQLite
selected the covering `(cohort, hex, observed_at, source)` uniqueness index and
scanned the cohort for every baseline slot. Live detection and replay now require
the existing `(cohort, observed_at)` index for that lookup, without changing
counting or calibration. Against 2,337,426 production takeoffs, the bounded query
returned 1,362 slots in 0.008 seconds and exactly matched an independent grouped
count. The actual Node baseline function took 12.4/6.1/1.4 milliseconds across
business/military/non-ICAO databases. The last still had zero eligible samples
because of the inherited timestamp-alignment limitation above. The deadline
remains 90 seconds per child; it was not raised to conceal the query failure.

The locked frontend build and existing ingestion/alert-pipeline checks passed.
Browser interception exercised stored-success, rejection, malformed success,
duplicate submission, draft retention, image payloads, private-context exclusion,
keyboard focus, and a 390-pixel viewport without posting to the live feedback
queue. Browser scenarios also exercised stale/future timestamps, unready
baselines, mixed source slots, missing cohorts, and independent cohort recovery.
The reference standards above remain a control map, not a certification claim.

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
