#!/bin/bash
# Chunked 365-day history backfill (Phase 1 exit criterion: deep concurrent
# calibration + Davos-week replay coverage). Month-sized chunks so each range
# DELETE + reinsert is a short lock cycle that cannot starve the :05/:35
# refresh timers. Main downloads and keeps the shared heatmap cache; military
# reparses the same files with --skip-download; the chunk's cache is then
# reclaimed (a year of heatmaps is ~200 GB).
#
# Usage (on the box, as xyra):
#   nohup bash scripts/run_yearly_backfill.sh >> data/backfill-365.log 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."

RANGES=(
  "2025-08-29 2025-09-01"
  "2025-09-01 2025-10-01"
  "2025-10-01 2025-11-01"
  "2025-11-01 2025-12-01"
  "2025-12-01 2026-01-01"
  "2026-01-01 2026-02-01"
  "2026-02-01 2026-03-01"
  "2026-03-01 2026-04-01"
  "2026-04-01 2026-05-01"
  "2026-05-01 2026-06-01"
  "2026-06-01 2026-06-24"
)

for range in "${RANGES[@]}"; do
  read -r start end <<<"$range"
  echo "--- chunk $start -> $end main $(date -u +%FT%TZ)"
  python3 scripts/backfill_history.py --db data/ews-main.sqlite \
    --start-date "$start" --end-date "$end" --keep-cache
  echo "--- chunk $start -> $end military $(date -u +%FT%TZ)"
  python3 scripts/backfill_history.py --db data/ews-military.sqlite \
    --start-date "$start" --end-date "$end" --skip-download
  # Reclaim this chunk's heatmap cache (month directories fully covered by
  # the chunk; the 2026-06 partial chunk leaves nothing live behind either,
  # since live cache lives under cache/adsbx_live, not cache/adsbx).
  year="${start%%-*}"
  month_start="${start:5:2}"
  rm -rf "data/cache/adsbx/${year}/${month_start}"
  echo "--- chunk $start -> $end done, cache reclaimed $(date -u +%FT%TZ)"
done

echo "--- yearly backfill complete $(date -u +%FT%TZ)"
