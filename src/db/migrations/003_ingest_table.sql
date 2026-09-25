-- Ingest table — raw inbound stream events (like alfred-black's ingest.db)
-- 7-day TTL, dead-letter support, failure tracking

CREATE TABLE IF NOT EXISTS ingest_event (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  stream TEXT NOT NULL,
  channel TEXT,
  kind TEXT,
  source_type TEXT,
  external_id TEXT,
  sender TEXT,
  subject TEXT,
  body TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead_lettered_at TEXT,
  dead_letter_reason TEXT,
  signal_extracted_at TEXT,
  processed_at TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_event_ts ON ingest_event(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_event_status ON ingest_event(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_event_tenant ON ingest_event(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ingest_event_stream ON ingest_event(stream, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_event_pending ON ingest_event(status, tenant_id, ts DESC) WHERE status = 'pending';
