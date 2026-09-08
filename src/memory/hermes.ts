// src/memory/hermes.ts — Agent memory via KV namespace

import type { Env, AlfredProfile } from "../types";

export async function getAlfredProfile(env: Env): Promise<AlfredProfile> {
  const data = await env.HERMES.get("profile:alfred");
  if (!data) {
    const defaultProfile: AlfredProfile = {
      name: "Alfred", version: "1.0.0",
      personality: { formality: "professional-but-warm", verbosity: "concise", humor: "dry", proactivity: "high" },
      capabilities: ["oral_operator", "voice_interaction", "mission_management", "report_generation"],
      default_tts: "workers-ai", default_stt: "workers-ai", default_voice_model: "aura-2-en",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await env.HERMES.put("profile:alfred", JSON.stringify(defaultProfile));
    return defaultProfile;
  }
  return JSON.parse(data);
}

export async function updateAlfredProfile(env: Env, updates: Partial<AlfredProfile>): Promise<AlfredProfile> {
  const current = await getAlfredProfile(env);
  const updated: AlfredProfile = { ...current, ...updates, updated_at: new Date().toISOString() };
  await env.HERMES.put("profile:alfred", JSON.stringify(updated));
  return updated;
}

export async function saveSessionContext(env: Env, sessionId: string, context: Record<string, unknown>): Promise<void> {
  await env.HERMES.put(`session:${sessionId}`, JSON.stringify({ ...context, updated_at: new Date().toISOString() }));
}

export async function getSessionContext(env: Env, sessionId: string): Promise<Record<string, unknown> | null> {
  const data = await env.HERMES.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteSessionContext(env: Env, sessionId: string): Promise<void> { await env.HERMES.delete(`session:${sessionId}`); }

export async function saveMemory(env: Env, userId: string, key: string, value: unknown): Promise<void> {
  await env.HERMES.put(`memory:${userId}:${key}`, JSON.stringify({ value, created_at: new Date().toISOString() }));
  const indexKey = `index:${userId}`;
  const indexData = await env.HERMES.get(indexKey);
  const index: string[] = indexData ? JSON.parse(indexData) : [];
  if (!index.includes(key)) { index.push(key); await env.HERMES.put(indexKey, JSON.stringify(index)); }
}

export async function recallMemory(env: Env, userId: string, key: string): Promise<unknown | null> {
  const data = await env.HERMES.get(`memory:${userId}:${key}`);
  return data ? JSON.parse(data) : null;
}

export async function listMemoryKeys(env: Env, userId: string): Promise<string[]> {
  const indexData = await env.HERMES.get(`index:${userId}`);
  return indexData ? JSON.parse(indexData) : [];
}

export async function saveOralState(env: Env, missionId: string, state: Record<string, unknown>): Promise<void> {
  await env.HERMES.put(`state:oral:${missionId}`, JSON.stringify({ ...state, updated_at: new Date().toISOString() }));
}

export async function getOralState(env: Env, missionId: string): Promise<Record<string, unknown> | null> {
  const data = await env.HERMES.get(`state:oral:${missionId}`);
  return data ? JSON.parse(data) : null;
}