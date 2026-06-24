#!/usr/bin/env python3

import datetime as dt
import pathlib
import sys
import tempfile
import types

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from track_non_icao_hex import build_takeoff_rows
from update_latest_heatmap import SOURCE, ingest_slot, open_db


def assert_condition(condition, message):
    if not condition:
        raise AssertionError(message)


def telemetry(hex_value, altitude="1200", lat=38.0, lon=-77.0, ground_speed=140.0):
    return types.SimpleNamespace(hex=hex_value, alt=altitude, lat=lat, lon=lon, gs=ground_speed)


def latest_slice(sampled_at, rows):
    return types.SimpleNamespace(timestamp=sampled_at, telemetry=rows)


def insert_live_snapshot(connection, hex_value, observed_at, is_airborne):
    connection.execute(
        """
        INSERT INTO live_snapshot (
          hex, registration, label, observed_at, lat, lon, altitude_ft, ground_speed_kt, track, is_airborne, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hex_value,
            hex_value.upper(),
            hex_value.upper(),
            observed_at,
            38.0,
            -77.0,
            None if not is_airborne else 1200,
            0 if not is_airborne else 140,
            None,
            1 if is_airborne else 0,
            SOURCE,
        ),
    )


def count_takeoffs(connection):
    return connection.execute("SELECT COUNT(*) AS count FROM takeoff_events").fetchone()["count"]


def assert_tracked_takeoff_requires_previous_ground_state():
    with tempfile.TemporaryDirectory(prefix="apocalypse-ews-takeoff-ingest-") as temp_dir:
        db_path = pathlib.Path(temp_dir) / "ews.sqlite"
        connection = open_db(db_path)
        try:
            tracked_by_hex = {
                "aaaaaa": {"registration": "NAAAAA", "label": "NAAAAA"},
                "bbbbbb": {"registration": "NBBBBB", "label": "NBBBBB"},
            }
            connection.execute(
                "INSERT INTO tracked_aircraft (hex, registration, label, source) VALUES (?, ?, ?, ?)",
                ("aaaaaa", "NAAAAA", "NAAAAA", "smoke"),
            )
            connection.execute(
                "INSERT INTO tracked_aircraft (hex, registration, label, source) VALUES (?, ?, ?, ?)",
                ("bbbbbb", "NBBBBB", "NBBBBB", "smoke"),
            )
            insert_live_snapshot(connection, "bbbbbb", "2026-06-23T11:30:00+00:00", False)
            ingest_slot(
                connection,
                tracked_by_hex,
                latest_slice(dt.datetime(2026, 6, 23, 12, 0, tzinfo=dt.timezone.utc), [telemetry("aaaaaa")]),
                replace_live_snapshot=True,
            )
            assert_condition(
                count_takeoffs(connection) == 0,
                "First-seen airborne tracked aircraft was incorrectly recorded as a takeoff.",
            )

            connection.execute("DELETE FROM live_snapshot")
            insert_live_snapshot(connection, "aaaaaa", "2026-06-23T12:00:00+00:00", False)
            ingest_slot(
                connection,
                tracked_by_hex,
                latest_slice(dt.datetime(2026, 6, 23, 12, 30, tzinfo=dt.timezone.utc), [telemetry("aaaaaa")]),
                replace_live_snapshot=True,
            )
            row = connection.execute(
                "SELECT hex, previous_observed_at FROM takeoff_events ORDER BY id DESC LIMIT 1"
            ).fetchone()
            assert_condition(row["hex"] == "aaaaaa", "Ground-to-air transition did not create a tracked takeoff event.")
            assert_condition(
                row["previous_observed_at"] == "2026-06-23T12:00:00+00:00",
                "Tracked takeoff did not preserve the previous ground observation timestamp.",
            )
        finally:
            connection.close()


def non_icao_row(hex_value):
    return {
        "hex": hex_value,
        "registration": None,
        "label": hex_value.upper(),
        "source": SOURCE,
        "observed_at": "2026-06-23T12:00:00+00:00",
        "lat": 38.0,
        "lon": -77.0,
        "altitude_ft": 1200,
        "ground_speed_kt": 140,
        "track": None,
    }


def assert_non_icao_takeoff_requires_previous_ground_state():
    first_seen_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"bbbbbb": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 0}},
    )
    assert_condition(first_seen_rows == [], "First-seen airborne non-ICAO row was incorrectly recorded as a takeoff.")

    takeoff_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"aaaaaa": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 0}},
    )
    assert_condition(len(takeoff_rows) == 1, "Ground-to-air non-ICAO transition did not create a takeoff.")
    assert_condition(
        takeoff_rows[0]["previous_observed_at"] == "2026-06-23T11:30:00+00:00",
        "Non-ICAO takeoff did not preserve the previous ground observation timestamp.",
    )

    airborne_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"aaaaaa": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 1}},
    )
    assert_condition(airborne_rows == [], "Already-airborne non-ICAO row was incorrectly recorded as a takeoff.")


def main():
    assert_tracked_takeoff_requires_previous_ground_state()
    assert_non_icao_takeoff_requires_previous_ground_state()
    print('{"ok":true,"checks":["tracked_takeoff_requires_previous_ground_state","non_icao_takeoff_requires_previous_ground_state"]}')


if __name__ == "__main__":
    main()
