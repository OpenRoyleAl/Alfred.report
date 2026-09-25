-- Alfred.Report Schema v2 — From agent-alfred spec
-- Tables: signal, observation, routing_decision, audit, link

-- Signal: inbound salience from streams
CREATE TABLE IF NOT EXISTS signal (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  stream_event_id TEXT,
  entity_ref TEXT,
  matter_ref TEXT,
  headline TEXT NOT NULL,
  body TEXT,
  salience REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Observation: behavioral signals from routing decisions
CREATE TABLE IF NOT EXISTS observation (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision_ref TEXT,
  instinct_ref TEXT,
  summary TEXT NOT NULL,
  detail TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Routing decision: how signals were routed
CREATE TABLE IF NOT EXISTS routing_decision (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  signal_id TEXT,
  tier TEXT NOT NULL,
  chosen_path TEXT NOT NULL,
  agent TEXT,
  instinct_ref TEXT,
  discretion REAL,
  reason TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit: every action taken
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  action_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT,
  target_path TEXT,
  target_kind TEXT,
  subject_ref TEXT,
  summary TEXT NOT NULL,
  changes_json TEXT,
  mode TEXT NOT NULL DEFAULT 'live',
  confidence REAL,
  undo_json TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link: cross-record graph edges
CREATE TABLE IF NOT EXISTS link (
  id TEXT PRIMARY KEY,
  src_ref TEXT NOT NULL,
  dst_ref TEXT NOT NULL,
  rel TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signal_ts ON signal(ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_status_ts ON signal(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_tenant ON signal(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signal_kind ON signal(kind);
CREATE INDEX IF NOT EXISTS idx_observation_ts ON observation(ts DESC);
CREATE INDEX IF NOT EXISTS idx_observation_tenant ON observation(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observation_subject ON observation(subject);
CREATE INDEX IF NOT EXISTS idx_routing_decision_ts ON routing_decision(ts DESC);
CREATE INDEX IF NOT EXISTS idx_routing_decision_tenant ON routing_decision(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor);
CREATE INDEX IF NOT EXISTS idx_link_src ON link(src_ref);
CREATE INDEX IF NOT EXISTS idx_link_dst ON link(dst_ref);
CREATE INDEX IF NOT EXISTS idx_link_tenant ON link(tenant_id);
