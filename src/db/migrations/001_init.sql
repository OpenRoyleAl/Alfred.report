-- Alfred.Report Knowledge Graph Schema

-- Core records table (13 canonical types)
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  content_r2_key TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- Graph edges (relationships between records)
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES records(id),
  FOREIGN KEY (target_id) REFERENCES records(id)
);

-- Observations (audit trail)
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  signal TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE SET NULL
);

-- Briefings
CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  summary TEXT NOT NULL,
  priorities TEXT,
  alerts TEXT,
  metrics TEXT,
  created_at INTEGER NOT NULL
);

-- Inbox (incoming signals queue)
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
CREATE INDEX IF NOT EXISTS idx_observations_record ON observations(record_id);
CREATE INDEX IF NOT EXISTS idx_observations_source ON observations(source);
CREATE INDEX IF NOT EXISTS idx_briefings_date ON briefings(date);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
