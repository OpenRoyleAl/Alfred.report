-- D1 Schema for Alfred System
-- Database: alfred-db
-- Tables: missions, voice_sessions, mission_events, user_preferences, voice_samples
--
-- Create the database:
--   npx wrangler d1 create alfred-db
--
-- Apply this schema locally:
--   npx wrangler d1 execute alfred-db --local --file=./schemas/schema.sql
--
-- Apply to production:
--   npx wrangler d1 execute alfred-db --remote --file=./schemas/schema.sql

-- ============================================================
-- Missions: ORAL operator tasks and objectives
-- ============================================================
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'completed', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 5
    CHECK (priority >= 1 AND priority <= 10),
  budget_usd REAL CHECK (budget_usd IS NULL OR budget_usd >= 0),
  oral_directives TEXT, -- JSON: ORAL operator instructions
  result TEXT, -- JSON: mission result data
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_missions_user_id ON missions (user_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions (status);
CREATE INDEX IF NOT EXISTS idx_missions_user_status ON missions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_priority ON missions (priority DESC);

-- ============================================================
-- Voice Sessions: real-time voice interactions
-- ============================================================
CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mission_id TEXT, -- FK to missions (nullable — standalone voice sessions)
  do_id TEXT NOT NULL, -- Durable Object instance ID
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'error', 'timeout')),
  tts_provider TEXT NOT NULL DEFAULT 'workers-ai',
  stt_provider TEXT NOT NULL DEFAULT 'workers-ai',
  voice_model TEXT, -- e.g., 'aura-2-en', 'melotts'
  language TEXT DEFAULT 'en',
  transcript TEXT, -- Full transcript JSON
  duration_seconds INTEGER, -- Total session duration
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_id ON voice_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_status ON voice_sessions (status);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_mission_id ON voice_sessions (mission_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_do_id ON voice_sessions (do_id);

-- ============================================================
-- Mission Events: audit trail for mission lifecycle
-- ============================================================
CREATE TABLE IF NOT EXISTS mission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'created', 'started', 'paused', 'resumed', 'completed',
      'failed', 'cancelled', 'directive_added', 'result_updated',
      'voice_session_started', 'voice_session_ended',
      'status_changed', 'priority_changed', 'error'
    )),
  event_data TEXT, -- JSON: event-specific payload
  actor TEXT, -- 'system', 'user', 'oral_operator', 'voice_agent'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mission_events_mission_id ON mission_events (mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_events_type ON mission_events (event_type);
CREATE INDEX IF NOT EXISTS idx_mission_events_created_at ON mission_events (created_at DESC);

-- ============================================================
-- Siri tokens: per-user briefing tokens for Hey Siri, Alfred report
-- ============================================================
CREATE TABLE IF NOT EXISTS siri_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_siri_tokens_user_id ON siri_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_siri_tokens_email ON siri_tokens (email);

-- ============================================================
-- User Preferences: per-user TTS/STT provider selection
-- ============================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  tts_provider TEXT NOT NULL DEFAULT 'workers-ai'
    CHECK (tts_provider IN ('workers-ai', 'mimo', 'openai', 'xai')),
  stt_provider TEXT NOT NULL DEFAULT 'workers-ai'
    CHECK (stt_provider IN ('workers-ai', 'mimo', 'openai', 'xai')),
  voice_model TEXT DEFAULT 'aura-2-en',
  language TEXT DEFAULT 'en',
  voice_sample_key TEXT, -- R2 key for custom voice sample
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Voice Samples: custom voice uploads stored in R2
-- ============================================================
CREATE TABLE IF NOT EXISTS voice_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL, -- R2 object key
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  duration_seconds REAL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES user_preferences (user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_voice_samples_user_id ON voice_samples (user_id);
CREATE INDEX IF NOT EXISTS idx_voice_samples_status ON voice_samples (status);

-- ============================================================
-- Triggers: auto-update updated_at timestamps
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_missions_updated_at
AFTER UPDATE ON missions
FOR EACH ROW
BEGIN
  UPDATE missions SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_preferences_updated_at
AFTER UPDATE ON user_preferences
FOR EACH ROW
BEGIN
  UPDATE user_preferences SET updated_at = datetime('now') WHERE user_id = OLD.user_id;
END;