-- ─── Alfred.report Missions knowledge graph schema ───────────────────
-- D1 migration: 001_init.sql
-- Run: npm run db:migrate:remote
-- ──────────────────────────────────────────────────────────────

-- Records: the core knowledge graph nodes (13 types)
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'matter', 'task', 'note', 'person', 'org', 'place',
    'asset', 'chore', 'instinct', 'decision', 'briefing',
    'daybook', 'commitment'
  )),
  title TEXT NOT NULL,
  content TEXT,
  content_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted', 'completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

-- Edges: typed relationships between records
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES records(id) ON DELETE CASCADE
);

-- Observations: audit trail of signals from workers
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  signal TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'curator', 'janitor', 'distiller', 'farmer', 'builder', 'orchestrator'
  )),
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE SET NULL
);

-- Inbox: raw incoming items awaiting processing by Curator
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  metadata TEXT,
  received_at INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

-- ─── Indexes ──────────────────────────────────────────────────
-- Critical for D1 performance: every filtered column needs an index

CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);
CREATE INDEX IF NOT EXISTS idx_records_type_status ON records(type, status);
CREATE INDEX IF NOT EXISTS idx_records_title ON records(title);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

CREATE INDEX IF NOT EXISTS idx_obs_record ON observations(record_id);
CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at);

CREATE INDEX IF NOT EXISTS idx_inbox_processed ON inbox(processed);
CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(received_at);
