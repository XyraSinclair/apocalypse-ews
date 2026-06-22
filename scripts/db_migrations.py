def table_columns(connection, table_name):
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    if not row:
        return set()

    columns = set()
    for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall():
        columns.add(row["name"] if hasattr(row, "keys") else row[1])

    return columns


def migrate_schema(connection):
    rolling_columns = table_columns(connection, "rolling_metrics")
    if rolling_columns:
        if {"sampled_at", "concurrent_count"}.issubset(rolling_columns):
            connection.execute(
                """
                INSERT OR IGNORE INTO concurrent_metrics (sampled_at, concurrent_count, created_at)
                SELECT sampled_at, concurrent_count, created_at
                FROM rolling_metrics
                """
            )
        connection.execute("DROP TABLE rolling_metrics")

    daily_columns = table_columns(connection, "daily_metrics")
    if "peak_rolling_24h_count" in daily_columns:
        connection.execute("ALTER TABLE daily_metrics RENAME TO daily_metrics_legacy_rolling")
        connection.execute(
            """
            CREATE TABLE daily_metrics (
              day TEXT PRIMARY KEY,
              unique_airborne_count INTEGER NOT NULL,
              peak_concurrent_count INTEGER NOT NULL,
              sample_count INTEGER NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            INSERT OR REPLACE INTO daily_metrics (
              day,
              unique_airborne_count,
              peak_concurrent_count,
              sample_count,
              created_at
            )
            SELECT
              day,
              unique_airborne_count,
              peak_concurrent_count,
              sample_count,
              created_at
            FROM daily_metrics_legacy_rolling
            """
        )
        connection.execute("DROP TABLE daily_metrics_legacy_rolling")

    connection.execute("DROP INDEX IF EXISTS idx_recent_history_activity_last_observed_at")
    connection.execute("DROP TABLE IF EXISTS recent_history_activity")
