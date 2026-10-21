-- ─── Mission Kernel Schema ───────────────────────────────────
-- D1 migration: 002_missions.sql
-- Applied by: npm --prefix apps/missions run db:migrate (cf d1 migrations apply)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'drafted', 'active', 'gated', 'complete', 'failed', 'aborted'
  )) DEFAULT 'drafted',
  budget TEXT,
  acceptance TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
CREATE INDEX IF NOT EXISTS idx_missions_updated ON missions(updated_at);
