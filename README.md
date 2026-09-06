# Apocalypse EWS

A continuous public-source watch with persistent evidence, incident threads,
and bounded machine investigations. The watch combines existing aggregate
aviation observations with official advisories, airspace status, civil warnings,
public reporting, and environmental measurements.

The watch reports what changed and what remains unverified. It does not estimate
the probability of nuclear use, infer intent from aircraft activity, or treat
quiet sources as evidence of safety. Machine assessments remain operator-only;
existing aviation notification channels keep their existing policy.

## How it works

```
21 enabled source definitions → immutable observations and source health
                                      │ semantic changes
                                      ▼
                               persistent incident threads
                                      │ bounded investigations
                                      ▼
                         specialist + skeptic → synthesis
                                      │
                                      ▼
                      private operator review + next questions
```

The public watch at `/` shows source facts, open threads, coverage gaps, and
handover state. `/aviation` retains the existing instrument:

```
ADS-B Exchange public heatmaps (30-min source slots, checked every 2 min)
        │  ingest
        ▼
SQLite per cohort (business jets ~31k airframes · military · non-ICAO)
        │  detect
        ▼
concurrent-airborne anomaly (levels 1–5) + takeoff-batch rate z-score
        │  fan out
        ▼
RSS · ntfy push · Telegram · web dashboard · email/SMS/web-push (optional stack)
```

- **Detection is evidence-bound**: no baseline → no statistical alert. Missing
  or stale data means the instrument is unavailable, never that the world is safe.
- **Keyed, cursored fanout**: repeated samples do not create new statistical
  evidence. External delivery can remain uncertain after a lost acknowledgment.
- The full pipeline is one command (`npm run refresh:all`), designed to run
  from any scheduler (systemd timer, launchd, cron) on one cheap box.

## Quickstart

```sh
npm ci
cp .env.example .env          # defaults work for local use
npm run refresh:all           # ingest latest slot, detect, export feeds
npm run watch:run -- --collect-only  # collect enabled public sources without inference
npm run build && npm start    # watch, aviation, and RSS at http://127.0.0.1:3030/
```

Python 3 with `numpy` and `Pillow` is needed for ingestion
(`pip install -r requirements.txt`). Baselines need ~7 days of history before
anomaly models arm; `scripts/backfill_history.py --start-date … --end-date …`
fills history from public archives. Polling every two minutes does **not**
make those 30-minute archives a real-time feed. Genuine two-minute observations
require an authorized live global source and separately validated calibration.

Node 22 or newer is required for the watch's built-in WebSocket client.
Automatic investigations use an existing funded `SCRY_API_KEY`; keep it in a
private environment file and set `EWS_WATCH_ENV_PATH` when running locally.
The supported model is `google/gemini-2.5-flash-lite`, with a $0.10 provider-usage
allowance per UTC day. Reports enter bounded batch screening before full,
three-role investigation; official notices bypass that admission stage.
Missing inference credentials do not stop source collection. Production uses
the separate `/etc/apocalypse-ews-watch.env`, read only by the watch service.

The registry contains 39 definitions, including ten country-specific travel
advisories: 21 enabled and 18 explicitly inactive or access-gated. These are
not 39 independent instruments or all 64 candidate observables in the planning
register. Predictive validation, broader source enrollment, and new warning
delivery channels remain outside the implemented watch.

## Subscribing (for a running deployment)

| Channel | How |
|---|---|
| ntfy push | install the [ntfy](https://ntfy.sh) app, subscribe to the deployment's topic |
| RSS | `<deployment>/rss.xml` in any feed reader |
| Telegram | join the deployment's channel |
| Email / SMS / web push | via the deployment's signup page (optional paid stack) |

## Operations

See [OPERATIONS.md](OPERATIONS.md) for deployment, resource bounds, access, and
recovery. [NUCLEAR-WARNING-STRATEGY.md](NUCLEAR-WARNING-STRATEGY.md) and
[DIGITAL-SIGNAL-REGISTER.md](DIGITAL-SIGNAL-REGISTER.md) retain the wider design
and candidate-source register. [ROADMAP.md](ROADMAP.md) records the aviation
instrument's calibration work, not validated nuclear-warning capability.

## Provenance

This is an independent recreation, with a self-hostable backend, inspired by
[Kyle McDonald's Apocalypse Early Warning System](https://ews.kylemcdonald.net/).
It is not affiliated with or endorsed by the original. Aircraft data comes from
ADS-B Exchange's public interfaces.

## License

MIT — see [LICENSE](LICENSE).
