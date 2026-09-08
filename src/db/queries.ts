// src/db/queries.ts — D1 database query helpers

import type { Env, Mission, MissionEvent, UserPreferences } from "../types";

export async function createMission(env: Env, data: { user_id: string; title: string; description?: string; priority?: number; oral_directives?: string }): Promise<Mission> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO missions (id, user_id, title, description, status, priority, oral_directives, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).bind(id, data.user_id, data.title, data.description || null, data.priority || 5, data.oral_directives || null, now, now).run();
  await logMissionEvent(env, id, "created", "user", { title: data.title });
  const mission = await getMission(env, id);
  return mission!;
}

export async function getMission(env: Env, id: string): Promise<Mission | null> {
  const result = await env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(id).first<Mission>();
  return result || null;
}

export async function listMissions(env: Env, userId?: string, status?: string): Promise<Mission[]> {
  let query = "SELECT * FROM missions WHERE 1=1";
  const params: string[] = [];
  if (userId) { query += " AND user_id = ?"; params.push(userId); }
  if (status) { query += " AND status = ?"; params.push(status); }
  query += " ORDER BY created_at DESC";
  const stmt = env.DB.prepare(query);
  const result = params.length > 0 ? await stmt.bind(...params).all<Mission>() : await stmt.all<Mission>();
  return result.results;
}

export async function updateMissionStatus(env: Env, id: string, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE missions SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, id).run();
}

export async function updateMissionResult(env: Env, id: string, result: unknown): Promise<void> {
  await env.DB.prepare(`UPDATE missions SET result = ?, updated_at = datetime('now') WHERE id = ?`).bind(JSON.stringify(result), id).run();
}

export async function logMissionEvent(env: Env, missionId: string, eventType: string, actor: string, data?: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(`INSERT INTO mission_events (mission_id, event_type, actor, event_data) VALUES (?, ?, ?, ?)`).bind(missionId, eventType, actor, data ? JSON.stringify(data) : null).run();
}

export async function getMissionEvents(env: Env, missionId: string): Promise<MissionEvent[]> {
  const result = await env.DB.prepare(`SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at DESC`).bind(missionId).all<MissionEvent>();
  return result.results;
}

export async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  const result = await env.DB.prepare(`SELECT * FROM user_preferences WHERE user_id = ?`).bind(userId).first<UserPreferences>();
  return result || null;
}

export async function setUserPreferences(env: Env, userId: string, prefs: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(env, userId);
  if (!current) {
    await env.DB.prepare(`INSERT INTO user_preferences (user_id, tts_provider, stt_provider, voice_model, language, voice_sample_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).bind(userId, prefs.tts_provider || "workers-ai", prefs.stt_provider || "workers-ai", prefs.voice_model || "aura-2-en", prefs.language || "en", prefs.voice_sample_key || null).run();
  } else {
    await env.DB.prepare(`UPDATE user_preferences SET tts_provider = COALESCE(?, tts_provider), stt_provider = COALESCE(?, stt_provider), voice_model = COALESCE(?, voice_model), language = COALESCE(?, language), voice_sample_key = COALESCE(?, voice_sample_key), updated_at = datetime('now') WHERE user_id = ?`).bind(prefs.tts_provider || null, prefs.stt_provider || null, prefs.voice_model || null, prefs.language || null, prefs.voice_sample_key || null, userId).run();
  }
  return (await getUserPreferences(env, userId))!;
}

export async function createVoiceSession(env: Env, data: { id: string; user_id: string; do_id: string; mission_id?: string; tts_provider?: string; stt_provider?: string; voice_model?: string; language?: string }): Promise<void> {
  await env.DB.prepare(`INSERT INTO voice_sessions (id, user_id, mission_id, do_id, status, tts_provider, stt_provider, voice_model, language) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`).bind(data.id, data.user_id, data.mission_id || null, data.do_id, data.tts_provider || "workers-ai", data.stt_provider || "workers-ai", data.voice_model || "aura-2-en", data.language || "en").run();
}

export async function endVoiceSession(env: Env, doId: string, transcript?: unknown): Promise<void> {
  await env.DB.prepare(`UPDATE voice_sessions SET status = 'ended', ended_at = ?, transcript = ? WHERE do_id = ?`).bind(new Date().toISOString(), transcript ? JSON.stringify(transcript) : null, doId).run();
}

export async function getVoiceSessionByDO(env: Env, doId: string): Promise<Record<string, unknown> | null> {
  const result = await env.DB.prepare(`SELECT * FROM voice_sessions WHERE do_id = ?`).bind(doId).first();
  return result || null;
}