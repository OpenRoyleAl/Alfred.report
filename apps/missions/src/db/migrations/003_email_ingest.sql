-- ─── alfred@ email → Mission ingest dedupe ───────────────────
-- D1 migration: 003_email_ingest.sql
-- Applied by: npm --prefix apps/missions run db:migrate (cf d1 migrations apply)

CREATE TABLE IF NOT EXISTS email_ingest (
  gmail_message_id TEXT PRIMARY KEY,
  thread_id TEXT,
  mission_id TEXT NOT NULL,
  subject TEXT,
  ingested_at INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE INDEX IF NOT EXISTS idx_email_ingest_thread ON email_ingest(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_ingest_mission ON email_ingest(mission_id);
CREATE INDEX IF NOT EXISTS idx_email_ingest_at ON email_ingest(ingested_at);
