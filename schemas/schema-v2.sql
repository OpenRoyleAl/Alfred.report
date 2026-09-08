-- D1 Schema v2 — Alfred System + COP Map additions
-- Run after schema.sql (v1) — adds cost tracking tables

-- ============================================================
-- Cost rollup per mission (queried by COP Map)
-- ============================================================
CREATE TABLE IF NOT EXISTS mission_costs (
  mission_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_tokens_in INTEGER NOT NULL DEFAULT 0,
  total_tokens_out INTEGER NOT NULL DEFAULT 0,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  tts_calls INTEGER NOT NULL DEFAULT 0,
  stt_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mission_costs_user ON mission_costs (user_id);
CREATE INDEX IF NOT EXISTS idx_mission_costs_cost ON mission_costs (total_cost_usd DESC);

-- ============================================================
-- Per-call cost ledger (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT,
  user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cost_events_mission ON cost_events (mission_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_user ON cost_events (user_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_created ON cost_events (created_at DESC);

-- ============================================================
-- Memory usage snapshots (COP Map)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kv_key_count INTEGER NOT NULL DEFAULT 0,
  vectorize_count INTEGER NOT NULL DEFAULT 0,
  d1_row_count INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Trigger: keep mission_costs in sync when cost_events inserted
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_cost_events_rollup
AFTER INSERT ON cost_events
FOR EACH ROW
WHEN NEW.mission_id IS NOT NULL
BEGIN
  INSERT INTO mission_costs (mission_id, user_id, total_cost_usd, total_tokens_in, total_tokens_out, ai_calls, tts_calls, stt_calls, tool_calls, updated_at)
  VALUES (NEW.mission_id, NEW.user_id, NEW.cost_usd, NEW.tokens_in, NEW.tokens_out,
    CASE WHEN NEW.event_type IN ('llm','embedding') THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type = 'tts' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type = 'stt' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type = 'tool' THEN 1 ELSE 0 END,
    datetime('now'))
  ON CONFLICT(mission_id) DO UPDATE SET
    total_cost_usd = mission_costs.total_cost_usd + NEW.cost_usd,
    total_tokens_in = mission_costs.total_tokens_in + NEW.tokens_in,
    total_tokens_out = mission_costs.total_tokens_out + NEW.tokens_out,
    ai_calls = mission_costs.ai_calls + (CASE WHEN NEW.event_type IN ('llm','embedding') THEN 1 ELSE 0 END),
    tts_calls = mission_costs.tts_calls + (CASE WHEN NEW.event_type = 'tts' THEN 1 ELSE 0 END),
    stt_calls = mission_costs.stt_calls + (CASE WHEN NEW.event_type = 'stt' THEN 1 ELSE 0 END),
    tool_calls = mission_costs.tool_calls + (CASE WHEN NEW.event_type = 'tool' THEN 1 ELSE 0 END),
    updated_at = datetime('now');
END;