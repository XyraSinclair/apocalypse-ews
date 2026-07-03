# Roadmap — from "runs on my laptop" to premier public signal

## 0. The contract (the whole system in one sentence)

> **One Hetzner box ingests public ADS-B data every 30 minutes, scores how
> out-of-distribution elite air traffic is against a seasonal baseline, and —
> rarely, calibratedly — pushes an alert to everyone subscribed, while proving
> its own liveness continuously.**

Everything below either serves that sentence or gets cut. Corollaries:

- One machine, one SQLite file per cohort, one systemd timer chain. No workers,
  no D1, no queues, no split-brain between `server/` and `functions/`.
- The signal is only as valuable as its **calibration**: a doom signal that
  cries wolf dies; one that stays silent through a real anomaly never mattered.
  Trust = empirical alert frequency matches the advertised frequency.
- Subscribers must be able to distinguish "no alert" from "system dead" without
  thinking about it. Liveness is part of the product.

## 1. Properties the system must satisfy

### Signal integrity (S)
- **S1 — Data-quality gating.** A feed outage, coverage drop, or ADSBx format
  change must read as "data problem," never "elites fleeing." Every slot gets a
  denominator check (global aircraft seen, cohort match rate, slot availability)
  before any anomaly math runs. Most false alarms in systems like this are feed
  artifacts; L0 gating is the highest-leverage false-alarm control.
- **S2 — Seasonal honesty.** Business-jet activity has huge diurnal, weekly,
  and calendar structure (Davos, Sun Valley, the Masters, holidays). Baselines
  must condition on (day-of-week × slot-of-day) at minimum. *Current defect:
  the takeoff-rate model pools all 48 daily slots over 28 days into one
  mean/σ — night slots dilute the baseline and every morning wave looks hot.*
- **S3 — Robustness.** Median/MAD (or winsorized moments), not raw mean/σ —
  one prior anomaly must not poison the baseline that judges the next one.
- **S4 — Anytime validity.** We test every 30 minutes forever; naive p-values
  guarantee false alarms. Sustained-shift detection (CUSUM/Page-Hinkley) plus
  conformal or e-process scoring keeps the false-alarm budget explicit.
- **S5 — Tail calibration.** Top severities expressed as return periods via
  extreme-value fit (POT/GPD) on historical scores: "this level recurs about
  once every N years" is the profound, honest framing of an exodus signal.
- **S6 — Corroboration for the top rung.** Level-5 requires k-of-n independent
  evidence: business jets + military + non-ICAO dark traffic; geographic
  departure clustering (capitals, financial centers); destination anomaly
  (one-way legs to remote strips). One cohort alone caps at level 4.
- **S7 — Evidence attached.** Every alert carries its numbers: score, return
  period, contributing aircraft, baseline sparkline, permalink. No vibes.

### Delivery reliability (D)
- **D1 — Exactly-once per subscriber per event** (event_key uniqueness +
  fanout cursor/leases — already built, keep tested).
- **D2 — Channel independence.** RSS, ntfy, Telegram, email, web push fail
  independently; one provider outage never blocks the others.
- **D3 — Synthetic end-to-end canary.** Weekly injected test event must reach
  a canary subscriber on every channel within SLA, else the operator is paged.
  A rarely-firing alert system that isn't continuously self-tested is dead
  code with a subscriber list.
- **D4 — Dead-man switches everywhere.** Every timer pings healthchecks.io
  (or self-hosted equivalent); silence pages the operator. Public status page
  + `last_slot_ingested` timestamp on the site.
- **D5 — Graceful degradation.** Missing provider config = channel disabled +
  visible in status, never a crashed pipeline (already largely true).

### Subscriber lifecycle (L)
- **L1 — Double opt-in** on email/SMS; one-click unsubscribe; List-Unsubscribe
  header; instant honor of STOP.
- **L2 — Auto-hygiene.** Bounces/complaints prune automatically. No manual
  list gardening, ever.
- **L3 — Privacy.** Contacts encrypted at rest (already: NOTIFICATION_ENCRYPTION_KEY),
  deletable on request, never shared. Data minimization: email or phone, nothing else.
- **L4 — Abuse resistance.** Rate-limited signup, no signup bombing (verify
  before store), CAPTCHA only if attacked (keep friction minimal until then).

### Operations (O)
- **O1 — One-box simplicity.** Hetzner CPX11/CX22 (~€5/mo), Debian or NixOS,
  systemd timers, Caddy TLS, SQLite + Litestream/restic offsite backup.
- **O2 — 30-minute rebuild.** Documented, tested restore-from-scratch: fresh
  box → running system in ≤30 min (script it: `bootstrap.sh`).
- **O3 — <30 min/month maintenance.** Unattended upgrades, auto-restart,
  meta-monitoring. No component that needs babysitting survives review.
- **O4 — Feed independence.** ADSBx free heatmaps could vanish. Ingest behind
  an interface with a second source ready (adsb.lol / airplanes.live /
  OpenSky). Alert on feed divergence, don't scramble later.

### Public-facing honesty (P)
- **P1 — The copy never claims prophecy.** "Business-jet activity is at a
  level seen roughly once per N years" — an anomaly report, not a doom oracle.
  Methodology page public. Base rates in every alert.
- **P2 — Calibration published.** Backtest results, historical alert log, and
  false-alarm record on the site. Trust through receipts.
- **P3 — Legal floor.** Informational service, no warranty; CAN-SPAM/GDPR
  basics (unsubscribe, deletion, minimal data). Free tier keeps this simple.

## 2. The statistical layer, concretely

Layered detector, each layer gating the next:

```
L0 data-quality gate      slot coverage, cohort match-rate, feed freshness
L1 seasonal baseline      per (dow × slot) robust location/scale (median/MAD),
                          trailing 8-12 weeks, trend-adjusted
L2 sequential scoring     residual → conformal p / e-value; CUSUM for sustained
                          shift (an exodus is sustained, not one hot slot)
L3 tail calibration       POT/GPD on years of scores → return periods;
                          severity ladder = target frequencies:
                          watch ~weekly · elevated ~monthly · high ~quarterly ·
                          critical ~yearly · emergency = beyond observed record
L4 corroboration          k-of-n across cohorts + geography + destination
                          entropy before the top severities
```

**Backtest is the acceptance test for all of it.** The 365-day backfill
(`backfill_history.py`, run it on the Hetzner box, not the laptop) replays a
year through the detector; the empirical alert-frequency table must match the
ladder above, and known mass-flight calendar events (Davos, Super Bowl, the
Masters — we already build Masters flight maps) must NOT breach `high`.
Wire as a CI job: `npm run backtest` → frequency table → fails if drifted.

## 3. Channel strategy (simpler than Twilio — mostly: skip SMS at launch)

The honest answer on SMS: the vendor isn't the complexity — **SMS itself is**
(A2P 10DLC registration, carrier filtering, per-message cost, STOP compliance).
Telnyx is already wired if we ever want it. Launch without it.

| Channel | Cost | Maintenance | Verdict |
|---|---|---|---|
| RSS | 0 | none | live already; keep |
| **ntfy.sh** | 0 (or self-host on the same box) | ~none | **flagship push**: subscribers install ntfy app, subscribe to topic; no accounts, no vendor contract |
| Telegram channel | 0 | ~none | one BotFather token; huge reach |
| Email (Postmark or SES) | ~free at our volume | low | double opt-in list; Postmark is dramatically simpler than SendGrid |
| Web push (VAPID) | 0 | low | keys already generated |
| SMS (Telnyx) | $ + compliance | **high** | deferred; paid tier later if demanded |
| Stripe paid tier | — | medium | **cut from launch.** Free removes Stripe webhooks, renewal reminders, customer portal — a third of the notification codebase |

## 4. Architecture end-state (the Hetzner consolidation)

Today there are two parallel implementations: the Express server + scripts
(local) and the Cloudflare Pages functions + D1 + maintenance worker
(production-intended). Premier state keeps **one**: the Express/scripts stack,
moved to the box. The CF stack (functions/, workers/, wrangler) gets retired
or frozen — deleting a parallel implementation is the single biggest
maintenance-cost reduction available.

```
Hetzner box (~€5/mo)
├── systemd timer: refresh (10 min)  → ingest → detect → fanout → feeds
├── systemd timer: backfill-repair (daily, self-healing gaps)
├── systemd timer: canary (weekly synthetic event, all channels)
├── systemd service: express server (site, RSS, signup, status)
├── Caddy (TLS, rate limiting)
├── Litestream → object storage (continuous SQLite replication)
└── healthchecks.io pings from every timer
```

DNS on the existing domain or a new one; Cloudflare proxy in front optional
(free tier) for DDoS comfort.

## 5. Phases with exit criteria

**Phase 0 — local operational.** ✅ 2026-07-03. Signal computes on live data,
10-min loop + always-on server under launchd, RSS + owner push live, smoke
suite green, baselines healing.

**Phase 1 — statistical hardening.** Seasonal (dow × slot) robust baselines;
L0 data-quality gate; CUSUM sustained-shift layer; 365-day backfill on server
hardware; backtest harness with frequency table + calendar-event non-alarms;
severity ladder recalibrated to target frequencies.
*Exit: backtest CI green; a simulated 3× exodus fires critical within 60 min;
Davos-week replay stays ≤ high.*

**Phase 2 — the box.** Hetzner provisioned by `bootstrap.sh`; systemd chain;
Litestream backups; healthchecks on every timer; restore drill done twice;
laptop demoted to dev machine.
*Exit: laptop off for 72h, system green; rebuild-from-scratch ≤ 30 min.*

**Phase 3 — subscription surfaces.** ntfy topic + Telegram channel + Postmark
double-opt-in email + web push; status page with last-ingest timestamp and
historical alert log; weekly synthetic canary paging on failure; methodology
page.
*Exit: canary delivered on all channels 4 weeks running; signup → verify →
unsubscribe loop tested by a stranger.*

**Phase 4 — share it.** Soft launch to trusted circle → public. Publish
calibration receipts. Iterate on the copy until it is impossible to read an
alert as a prophecy rather than a measurement.
*Exit: strangers subscribed; zero uncalibrated alerts; ≤30 min/month observed
maintenance for a full month.*

**Deliberately cut (revisit only on demand):** Stripe/paid tier, SMS, the
Cloudflare Pages/D1 stack, multi-region redundancy, user accounts, per-user
thresholds.

## 6. Standing risks

| Risk | Mitigation |
|---|---|
| ADSBx free endpoint closes | O4 second-source interface; alert on divergence |
| False alarm goes viral | P1 copy discipline; return-period framing; corroboration gate on top severities |
| Silent death (worst failure for an EWS) | D3 canary + D4 dead-man switches + public status |
| Baseline poisoned by slow drift | robust stats + trend term + quarterly backtest re-run |
| Solo-operator bus factor | O2 scripted rebuild; everything in git; OPERATIONS.md current |
