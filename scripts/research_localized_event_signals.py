#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import math
import pathlib
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from detect_excess_activity_origins import (
    DB_PATH,
    ENDPOINT_CLUSTER_MIN_POINTS,
    ENDPOINT_CLUSTER_RADIUS_MILES,
    OUT_REPORT,
    cell_center,
    delta_counts,
    load_metric_items,
    median_baseline_counts,
    scan_window,
    summarize_endpoint_clusters,
    summarize_deltas,
)
from build_masters_flight_trails import GRID_CELL_MILES, MAP_BOUNDS, ROOT_DIR, UTC


OUT_JSON = ROOT_DIR / "localized_event_signal_research.json"
OUT_MD = ROOT_DIR / "localized_event_signal_research.md"

BASELINE_WEEK_OFFSETS = (-12, -10, -8, -6, -4, 4, 6, 8, 10, 12)


@dataclass(frozen=True)
class EventWindow:
    key: str
    event: str
    phase: str
    location_label: str
    lat: float | None
    lon: float | None
    tz: str
    local_start: str
    local_end: str
    source_note: str


EVENT_WINDOWS = [
    EventWindow(
        "masters_2026_departure",
        "Masters Tournament 2026",
        "departure",
        "Augusta, GA",
        33.4735,
        -82.0105,
        "America/New_York",
        "2026-04-12T18:00:00",
        "2026-04-13T02:00:00",
        "Masters final round Apr 12, 2026.",
    ),
    EventWindow(
        "super_bowl_2026_departure",
        "Super Bowl LX",
        "departure",
        "Santa Clara, CA",
        37.4030,
        -121.9700,
        "America/Los_Angeles",
        "2026-02-09T08:00:00",
        "2026-02-09T18:00:00",
        "Game Feb 8, 2026; checks the day-after departure window.",
    ),
    EventWindow(
        "art_basel_2025_departure",
        "Art Basel Miami Beach 2025",
        "departure",
        "Miami Beach, FL",
        25.7907,
        -80.1300,
        "America/New_York",
        "2025-12-07T15:00:00",
        "2025-12-08T01:00:00",
        "Public fair Dec 5-7, 2025; previews started Dec 3.",
    ),
    EventWindow(
        "kentucky_derby_2026_departure",
        "Kentucky Derby 2026",
        "departure",
        "Louisville, KY",
        38.2026,
        -85.7703,
        "America/New_York",
        "2026-05-03T08:00:00",
        "2026-05-03T18:00:00",
        "Derby day May 2, 2026.",
    ),
    EventWindow(
        "f1_miami_2026_departure",
        "Formula One Miami Grand Prix 2026",
        "departure",
        "Miami Gardens, FL",
        25.9578,
        -80.2389,
        "America/New_York",
        "2026-05-03T16:00:00",
        "2026-05-04T02:00:00",
        "Race weekend May 1-3, 2026.",
    ),
    EventWindow(
        "wef_davos_2026_us_departure",
        "World Economic Forum 2026",
        "US departure",
        "Davos, Switzerland",
        None,
        None,
        "America/New_York",
        "2026-01-18T08:00:00",
        "2026-01-18T20:00:00",
        "Annual Meeting Jan 19-23, 2026; CONUS heatmaps can only see U.S. departure regions.",
    ),
    EventWindow(
        "burning_man_2025_departure",
        "Burning Man 2025",
        "departure",
        "Black Rock Desert, NV",
        40.7864,
        -119.2065,
        "America/Los_Angeles",
        "2025-09-01T08:00:00",
        "2025-09-01T20:00:00",
        "Event gates open Aug 24-Sep 1, 2025.",
    ),
    EventWindow(
        "us_open_2025_departure",
        "U.S. Open Golf 2025",
        "departure",
        "Oakmont, PA",
        40.5269,
        -79.8270,
        "America/New_York",
        "2025-06-15T16:00:00",
        "2025-06-16T00:00:00",
        "Championship Jun 12-15, 2025.",
    ),
    EventWindow(
        "daytona_500_2026_departure",
        "Daytona 500 2026",
        "departure",
        "Daytona Beach, FL",
        29.1852,
        -81.0705,
        "America/New_York",
        "2026-02-16T08:00:00",
        "2026-02-16T18:00:00",
        "Race Feb 15, 2026.",
    ),
    EventWindow(
        "coachella_w1_2026_departure",
        "Coachella Weekend 1 2026",
        "departure",
        "Indio, CA",
        33.6803,
        -116.2378,
        "America/Los_Angeles",
        "2026-04-13T08:00:00",
        "2026-04-13T18:00:00",
        "Weekend 1 Apr 10-12, 2026.",
    ),
    EventWindow(
        "coachella_w2_2026_departure",
        "Coachella Weekend 2 2026",
        "departure",
        "Indio, CA",
        33.6803,
        -116.2378,
        "America/Los_Angeles",
        "2026-04-20T08:00:00",
        "2026-04-20T18:00:00",
        "Weekend 2 Apr 17-19, 2026.",
    ),
    EventWindow(
        "ces_2026_departure",
        "CES 2026",
        "departure",
        "Las Vegas, NV",
        36.1319,
        -115.1511,
        "America/Los_Angeles",
        "2026-01-09T14:00:00",
        "2026-01-10T02:00:00",
        "CES Jan 6-9, 2026.",
    ),
    EventWindow(
        "sun_valley_2025_departure",
        "Sun Valley Conference 2025",
        "departure",
        "Sun Valley, ID",
        43.6954,
        -114.3517,
        "America/Boise",
        "2025-07-13T08:00:00",
        "2025-07-13T18:00:00",
        "Allen & Company Sun Valley conference week in July 2025.",
    ),
    EventWindow(
        "cannes_monaco_2025_us_departure",
        "Cannes / Monaco 2025",
        "US departure",
        "Cannes/Monaco, Europe",
        None,
        None,
        "America/New_York",
        "2025-05-23T08:00:00",
        "2025-05-23T18:00:00",
        "Cannes May 13-24 and Monaco GP May 23-25, 2025; CONUS heatmaps can only see U.S. departure regions.",
    ),
]


def parse_local(value, timezone_name):
    return dt.datetime.fromisoformat(value).replace(tzinfo=ZoneInfo(timezone_name))


def load_metric_residuals():
    items = load_metric_items()
    from detect_excess_activity_origins import annotate_metric_baseline

    annotate_metric_baseline(items)
    return items


def residual_score_for_window(items, local_start, local_end):
    start_utc = local_start.astimezone(UTC)
    end_utc = local_end.astimezone(UTC)
    window_items = [item for item in items if start_utc <= item["utc"] < end_utc]
    if not window_items:
        return None
    return {
        "sample_count": len(window_items),
        "residual_sum": sum(item["residual"] for item in window_items),
        "positive_residual_sum": sum(max(0, item["residual"]) for item in window_items),
        "absolute_residual_sum": sum(abs(item["residual"]) for item in window_items),
        "peak_residual": max(item["residual"] for item in window_items),
    }


def choose_baselines(event_window, metric_items, count):
    local_start = parse_local(event_window.local_start, event_window.tz)
    local_end = parse_local(event_window.local_end, event_window.tz)
    duration = local_end - local_start
    rows = []
    for weeks in BASELINE_WEEK_OFFSETS:
        candidate_start = local_start + dt.timedelta(days=weeks * 7)
        candidate_end = candidate_start + duration
        score = residual_score_for_window(metric_items, candidate_start, candidate_end)
        if not score:
            continue
        rows.append(
            {
                "local_start": candidate_start,
                "local_end": candidate_end,
                "week_offset": weeks,
                "score": score,
            }
        )
    rows.sort(key=lambda row: (abs(row["score"]["residual_sum"]), row["score"]["absolute_residual_sum"]))
    return rows[:count]


def haversine_miles(lat1, lon1, lat2, lon2):
    radius_miles = 3958.7613
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return radius_miles * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_cluster_distance(event_window, summary):
    if event_window.lat is None or event_window.lon is None:
        return None
    clusters = summary["compact_neighborhoods"]
    if not clusters:
        return None
    distances = []
    for cluster in clusters:
        center = cluster["center"]
        distances.append(haversine_miles(event_window.lat, event_window.lon, center["lat"], center["lon"]))
    return min(distances)


def cluster_distance(event_window, cluster):
    if event_window.lat is None or event_window.lon is None or cluster is None:
        return None
    center = cluster["center"]
    return haversine_miles(event_window.lat, event_window.lon, center["lat"], center["lon"])


def top_cluster(summary):
    clusters = summary["compact_neighborhoods"]
    return clusters[0] if clusters else None


def top_endpoint_cluster(summary):
    clusters = summary.get("clusters", [])
    return clusters[0] if clusters else None


def top_cluster_share(summary):
    cluster = top_cluster(summary)
    if not cluster or summary["positive_total"] <= 0:
        return 0
    return cluster["total_delta"] / summary["positive_total"]


def top_endpoint_cluster_share(summary):
    cluster = top_endpoint_cluster(summary)
    if not cluster or summary["positive_total"] <= 0:
        return 0
    return cluster["total_delta"] / summary["positive_total"]


def strongest_signal_cluster(endpoint_summary, cell_summary):
    return top_endpoint_cluster(endpoint_summary) or top_cluster(cell_summary)


def strongest_signal_share(endpoint_summary, cell_summary):
    endpoint_share = top_endpoint_cluster_share(endpoint_summary)
    return endpoint_share if endpoint_share > 0 else top_cluster_share(cell_summary)


def event_match_score(event_window, summary):
    distance = cluster_distance(event_window, summary)
    if distance is None:
        return None
    # Full credit inside ~100 mi, then decay to zero by ~350 mi.
    return max(0, min(1, (350 - distance) / 250))


def classify_event_signal(
    event_window,
    presence_summary,
    takeoff_summary,
    landing_summary,
    takeoff_endpoint_summary,
    landing_endpoint_summary,
):
    if event_window.phase == "arrival":
        primary = landing_summary
        primary_endpoint = landing_endpoint_summary
        secondary = takeoff_summary
        secondary_endpoint = takeoff_endpoint_summary
    elif "departure" in event_window.phase:
        primary = takeoff_summary
        primary_endpoint = takeoff_endpoint_summary
        secondary = landing_summary
        secondary_endpoint = landing_endpoint_summary
    else:
        primary = max([presence_summary, takeoff_summary, landing_summary], key=lambda item: top_cluster_share(item))
        primary_endpoint = {"clusters": [], "positive_total": 0}
        secondary = presence_summary
        secondary_endpoint = {"clusters": [], "positive_total": 0}

    top = strongest_signal_cluster(primary_endpoint, primary)
    primary_share = strongest_signal_share(primary_endpoint, primary)
    primary_match = event_match_score(event_window, top)
    primary_method = "endpoint cluster" if top_endpoint_cluster(primary_endpoint) else "cell neighborhood"
    if primary_match is None:
        if primary_share >= 0.25:
            label = "localized U.S. gateway signal"
        elif primary_share >= 0.14:
            label = "regional U.S. gateway signal"
        else:
            label = "diffuse / no localized gateway"
    elif primary_match >= 0.75 and primary_share >= 0.18:
        label = "strong match near event"
    elif primary_match >= 0.45 and primary_share >= 0.14:
        label = "regional match near event"
    elif primary_share >= 0.20:
        label = "localized mismatch"
    else:
        label = "weak or diffuse"

    return {
        "label": label,
        "primary_cluster_share": primary_share,
        "primary_endpoint_cluster_share": top_endpoint_cluster_share(primary_endpoint),
        "primary_cell_cluster_share": top_cluster_share(primary),
        "primary_match_score": primary_match,
        "primary_cluster": top,
        "primary_cluster_method": primary_method,
        "secondary_cluster_share": strongest_signal_share(secondary_endpoint, secondary),
    }


def analyze_event_window(event_window, metric_items, baseline_count):
    local_start = parse_local(event_window.local_start, event_window.tz)
    local_end = parse_local(event_window.local_end, event_window.tz)
    print(f"Analyzing {event_window.key}: {local_start.isoformat()} to {local_end.isoformat()}", flush=True)
    current_score = residual_score_for_window(metric_items, local_start, local_end)
    current = scan_window(local_start, local_end, TRACKED_KEYS)
    baseline_rows = choose_baselines(event_window, metric_items, baseline_count)
    baseline_windows = []
    for row in baseline_rows:
        print(
            f"  baseline {row['local_start'].date()} offset {row['week_offset']:+d}w",
            flush=True,
        )
        baseline_windows.append(scan_window(row["local_start"], row["local_end"], TRACKED_KEYS))

    baseline_presence = median_baseline_counts(baseline_windows, "presence_counts")
    baseline_takeoffs = median_baseline_counts(baseline_windows, "takeoff_counts")
    baseline_landings = median_baseline_counts(baseline_windows, "landing_counts")

    presence_summary = summarize_deltas(delta_counts(current["presence_counts"], baseline_presence))
    takeoff_summary = summarize_deltas(delta_counts(current["takeoff_counts"], baseline_takeoffs))
    landing_summary = summarize_deltas(delta_counts(current["landing_counts"], baseline_landings))
    takeoff_endpoint_summary = summarize_endpoint_clusters(current, baseline_windows, "takeoff_points")
    landing_endpoint_summary = summarize_endpoint_clusters(current, baseline_windows, "landing_points")
    classification = classify_event_signal(
        event_window,
        presence_summary,
        takeoff_summary,
        landing_summary,
        takeoff_endpoint_summary,
        landing_endpoint_summary,
    )

    return {
        "key": event_window.key,
        "event": event_window.event,
        "phase": event_window.phase,
        "location_label": event_window.location_label,
        "event_location": {"lat": event_window.lat, "lon": event_window.lon},
        "timezone": event_window.tz,
        "local_start": local_start.isoformat(),
        "local_end": local_end.isoformat(),
        "source_note": event_window.source_note,
        "current_global_residual": current_score,
        "current_observed_aircraft": current["observed_aircraft"],
        "current_takeoff_events": current["takeoff_events"],
        "current_landing_events": current["landing_events"],
        "downloaded_files": current["downloaded_files"] + sum(window["downloaded_files"] for window in baseline_windows),
        "baselines": [
            {
                "local_start": row["local_start"].isoformat(),
                "local_end": row["local_end"].isoformat(),
                "week_offset": row["week_offset"],
                "global_residual": row["score"],
            }
            for row in baseline_rows
        ],
        "presence_summary": presence_summary,
        "takeoff_summary": takeoff_summary,
        "landing_summary": landing_summary,
        "takeoff_endpoint_summary": takeoff_endpoint_summary,
        "landing_endpoint_summary": landing_endpoint_summary,
        "classification": classification,
        "distances_miles": {
            "presence_top": cluster_distance(event_window, top_cluster(presence_summary)),
            "takeoff_top": cluster_distance(event_window, top_cluster(takeoff_summary)),
            "landing_top": cluster_distance(event_window, top_cluster(landing_summary)),
            "takeoff_endpoint_top": cluster_distance(event_window, top_endpoint_cluster(takeoff_endpoint_summary)),
            "landing_endpoint_top": cluster_distance(event_window, top_endpoint_cluster(landing_endpoint_summary)),
            "presence_nearest": nearest_cluster_distance(event_window, presence_summary),
            "takeoff_nearest": nearest_cluster_distance(event_window, takeoff_summary),
            "landing_nearest": nearest_cluster_distance(event_window, landing_summary),
        },
    }


def format_cluster(cluster):
    if not cluster:
        return "n/a"
    center = cluster["center"]
    return f"{center['lat']:.2f}, {center['lon']:.2f} ({cluster['total_delta']:+.0f})"


def write_outputs(results, baseline_count):
    payload = {
        "generated_at": dt.datetime.now(UTC).isoformat(),
        "database": str(DB_PATH.relative_to(ROOT_DIR)),
        "cell_size_miles": GRID_CELL_MILES,
        "endpoint_cluster_radius_miles": ENDPOINT_CLUSTER_RADIUS_MILES,
        "endpoint_cluster_min_points": ENDPOINT_CLUSTER_MIN_POINTS,
        "map_bounds": MAP_BOUNDS,
        "baseline_count": baseline_count,
        "baseline_week_offsets": BASELINE_WEEK_OFFSETS,
        "results": results,
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2), "utf8")

    lines = [
        "# Localized Event Signal Research",
        "",
        "This is a targeted validation pass for the endpoint-first detector. The event date/location is used only to choose the test window and report distance-to-event; cluster ranking itself is location-agnostic.",
        "",
        f"Takeoff and landing anchors are clustered directly from inferred endpoint coordinates with a {ENDPOINT_CLUSTER_RADIUS_MILES:.0f}-mile radius. The old ~{GRID_CELL_MILES:.0f}-mile cell summaries are retained as diagnostics.",
        "",
        "| Event | Phase | Window | Label | Primary Cluster | Method | Distance | Global Peak Residual |",
        "|---|---|---|---|---|---|---:|---:|",
    ]
    for result in results:
        primary = result["classification"]["primary_cluster"]
        distance = None
        if result["phase"] == "arrival":
            distance = result["distances_miles"]["landing_endpoint_top"] or result["distances_miles"]["landing_top"]
        elif "departure" in result["phase"]:
            distance = result["distances_miles"]["takeoff_endpoint_top"] or result["distances_miles"]["takeoff_top"]
        distance_label = "n/a" if distance is None else f"{distance:.0f} mi"
        peak = result["current_global_residual"]["peak_residual"] if result["current_global_residual"] else 0
        window = f"{result['local_start'][:16]} to {result['local_end'][11:16]} {result['timezone']}"
        lines.append(
            f"| {result['event']} | {result['phase']} | {window} | "
            f"{result['classification']['label']} | {format_cluster(primary)} | "
            f"{result['classification']['primary_cluster_method']} | "
            f"{distance_label} | {peak:.0f} |"
        )

    lines.extend(["", "## Details", ""])
    for result in results:
        lines.append(f"### {result['event']} - {result['phase']}")
        lines.append("")
        lines.append(result["source_note"])
        lines.append(
            f"Current window observed {result['current_observed_aircraft']} aircraft, "
            f"inferred {result['current_takeoff_events']} takeoffs and {result['current_landing_events']} landings."
        )
        lines.append(
            "Baselines: "
            + ", ".join(row["local_start"][:10] for row in result["baselines"])
            + "."
        )
        for label, key in (("Takeoff endpoint", "takeoff_endpoint_summary"), ("Landing endpoint", "landing_endpoint_summary")):
            cluster = top_endpoint_cluster(result[key])
            share = top_endpoint_cluster_share(result[key])
            if not cluster:
                lines.append(f"- {label}: no positive endpoint cluster.")
                continue
            distance = result["distances_miles"][f"{label.split()[0].lower()}_endpoint_top"]
            distance_text = "" if distance is None else f", {distance:.0f} mi from event"
            lines.append(
                f"- {label}: {format_cluster(cluster)}, share {share:.2f}{distance_text}; "
                f"current {cluster['current_count']} vs baseline median {cluster['baseline_median_count']:.1f}."
            )
        for label, key in (("Presence cell", "presence_summary"), ("Takeoff cell", "takeoff_summary"), ("Landing cell", "landing_summary")):
            cluster = top_cluster(result[key])
            share = top_cluster_share(result[key])
            if not cluster:
                lines.append(f"- {label}: no compact positive cluster.")
                continue
            distance = result["distances_miles"][f"{label.split()[0].lower()}_top"]
            distance_text = "" if distance is None else f", {distance:.0f} mi from event"
            lines.append(
                f"- {label}: {format_cluster(cluster)}, share {share:.2f}{distance_text}."
            )
        lines.append("")

    OUT_MD.write_text("\n".join(lines), "utf8")


def parse_args():
    parser = argparse.ArgumentParser(description="Targeted research pass for localized event signals.")
    parser.add_argument("--baseline-count", type=int, default=2)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", nargs="*", default=None, help="Event window keys to run.")
    return parser.parse_args()


TRACKED_KEYS = None


def main():
    global TRACKED_KEYS
    args = parse_args()
    TRACKED_KEYS = __import__("build_masters_flight_trails").tracked_aircraft_keys()
    metric_items = load_metric_residuals()
    windows = EVENT_WINDOWS
    if args.only:
        wanted = set(args.only)
        windows = [window for window in windows if window.key in wanted]
    if args.limit is not None:
        windows = windows[: args.limit]

    results = []
    for event_window in windows:
        result = analyze_event_window(event_window, metric_items, args.baseline_count)
        results.append(result)
        write_outputs(results, args.baseline_count)
    write_outputs(results, args.baseline_count)
    print(f"Wrote {OUT_JSON.relative_to(ROOT_DIR)}", flush=True)
    print(f"Wrote {OUT_MD.relative_to(ROOT_DIR)}", flush=True)


if __name__ == "__main__":
    main()
