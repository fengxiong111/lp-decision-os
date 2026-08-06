-- LP Alpha Terminal architecture runtime metadata.
-- Immutable migration: do not edit after application.
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_projection_snapshots (
  projection_version INTEGER PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  rankings_json TEXT NOT NULL,
  source_health_json TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS market_projection_snapshots_created_at
  ON market_projection_snapshots (created_at);

CREATE TABLE IF NOT EXISTS switch_signals (
  signal_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  from_pool TEXT,
  to_pool TEXT,
  state TEXT NOT NULL,
  score REAL,
  reason_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  confirmed_at TEXT,
  invalidated_at TEXT,
  last_seen_at TEXT NOT NULL,
  projection_version INTEGER NOT NULL
);

