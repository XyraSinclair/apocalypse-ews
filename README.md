# Apocalypse EWS

An early-warning system that watches for one specific anomaly: **an unusual
number of business jets taking off at once** — the "elites are fleeing"
signal — plus military and untracked-aircraft cohorts as corroboration.

It is a measurement instrument, not an oracle. Every alert reports how far
current activity deviates from a seasonal baseline, with the evidence
attached. Calm output is the normal output.

## How it works

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
npm install
cp .env.example .env          # defaults work for local use
npm run refresh:all           # ingest latest slot, detect, export feeds
npm start                     # dashboard + RSS at http://127.0.0.1:3030/
```

Python 3 with `numpy` and `Pillow` is needed for ingestion
(`pip install -r requirements.txt`). Baselines need ~7 days of history before
anomaly models arm; `scripts/backfill_history.py --start-date … --end-date …`
fills history from public archives. Polling every two minutes does **not**
make those 30-minute archives a real-time feed. Genuine two-minute observations
require an authorized live global source and separately validated calibration.

## Subscribing (for a running deployment)

| Channel | How |
|---|---|
| ntfy push | install the [ntfy](https://ntfy.sh) app, subscribe to the deployment's topic |
| RSS | `<deployment>/rss.xml` in any feed reader |
| Telegram | join the deployment's channel |
| Email / SMS / web push | via the deployment's signup page (optional paid stack) |

## Operations

See [OPERATIONS.md](OPERATIONS.md) for the runbook and
[ROADMAP.md](ROADMAP.md) for the path to a fully calibrated public signal
(seasonal robust baselines, anytime-valid sequential testing, extreme-value
return periods, k-of-n corroboration).

## Provenance

This is an independent recreation, with a self-hostable backend, inspired by
[Kyle McDonald's Apocalypse Early Warning System](https://ews.kylemcdonald.net/).
It is not affiliated with or endorsed by the original. Aircraft data comes from
ADS-B Exchange's public interfaces.

## License

MIT — see [LICENSE](LICENSE).
