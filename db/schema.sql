PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_meta (key, value, updated_at)
VALUES ('schema_version', '2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

CREATE TABLE IF NOT EXISTS json_documents (
  document_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_status (
  section TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whales (
  address TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  discovered_at TEXT,
  promoted_at TEXT,
  paper_trades INTEGER NOT NULL DEFAULT 0,
  live_trades INTEGER NOT NULL DEFAULT 0,
  estimated_volume_usd REAL,
  qualifying_trade_count INTEGER,
  distinct_token_count INTEGER,
  last_scouted_at TEXT,
  last_scouted_token TEXT,
  last_scouted_reason TEXT,
  seed_trader_rank INTEGER,
  seed_token_volume_usd REAL,
  seed_token_trade_count INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whales_mode ON whales (mode);

CREATE TABLE IF NOT EXISTS whale_trade_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whale_address TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  closed_at TEXT NOT NULL,
  mint TEXT,
  pnl_pct REAL NOT NULL,
  hold_minutes REAL NOT NULL DEFAULT 0,
  exit_reason TEXT NOT NULL,
  panic_exit INTEGER NOT NULL DEFAULT 0,
  had_positive_excursion INTEGER NOT NULL DEFAULT 0,
  round_trip_cost_bps REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whale_trade_metrics_lookup
  ON whale_trade_metrics (whale_address, mode, closed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS whale_trade_discards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whale_address TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  discarded_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  mint TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whale_trade_discards_lookup
  ON whale_trade_discards (whale_address, mode, discarded_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS whale_performance_snapshots (
  whale_address TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  history_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (whale_address, mode)
);

CREATE INDEX IF NOT EXISTS idx_whale_performance_snapshots_mode
  ON whale_performance_snapshots (mode, updated_at DESC, whale_address ASC);

CREATE TABLE IF NOT EXISTS scout_rejected_candidates (
  wallet_address TEXT PRIMARY KEY,
  mint_address TEXT,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  expires_at TEXT,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whale_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whale_address TEXT,
  mint TEXT,
  activity_type TEXT,
  detected_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whale_activity_lookup
  ON whale_activity (whale_address, detected_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS trade_plans (
  plan_id TEXT PRIMARY KEY,
  token_address TEXT NOT NULL,
  dex_id TEXT,
  pool_address TEXT,
  execution_mode TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_plans_created_at ON trade_plans (created_at DESC);

CREATE TABLE IF NOT EXISTS plan_approvals (
  plan_id TEXT PRIMARY KEY,
  approved INTEGER NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  message TEXT,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_positions (
  position_key TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  whale_address TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'paper')),
  status TEXT NOT NULL,
  opened_at TEXT,
  position_sol REAL,
  remaining_position_fraction REAL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_positions_mode_status
  ON tracked_positions (mode, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS trade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  mode TEXT,
  closed_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_history_closed_at ON trade_history (closed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS watchlist_tokens (
  mint TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);