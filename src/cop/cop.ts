// src/cop/cop.ts — COP Map API endpoints + telemetry writer
import { Hono } from "hono";
import type { Env } from "../types";

export const copApp = new Hono<{ Bindings: Env }>();

// --- Model pricing table ($ per 1M tokens) ---
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.15, out: 0.60 },
  "@cf/zai-org/glm-5.3": { in: 0.15, out: 0.60 },
  "@cf/zai-org/glm-5.3-flash": { in: 0.05, out: 0.20 },
  "@cf/deepgram/aura-1": { in: 0, out: 0.03 },
  "@cf/deepgram/aura-2-en": { in: 0, out: 0.03 },
  "@cf/openai/whisper-large-v3-turbo": { in: 0, out: 0.02 },
  "gpt-4o": { in: 2.50, out: 10.00 },
  "grok-3": { in: 3.00, out: 15.00 },
  "mimo-v2.5-pro": { in: 1.00, out: 4.00 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICES[model] || { in: 0.15, out: 0.60 };
  return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}

// --- Write a telemetry point to Analytics Engine (non-blocking) ---
export function recordCop(
  env: Env,
  data: {
    userId: string;
    missionId: string;
    agent: string;
    provider: string;
    model: string;
    eventType: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    durationMs?: number;
  }
): void {
  const cost = data.costUsd ?? estimateCost(data.model, data.tokensIn ?? 0, data.tokensOut ?? 0);
  env.ALFRED_COP.writeDataPoint({
    blobs: [data.userId, data.missionId, data.agent, data.provider, data.model, data.eventType],
    doubles: [data.tokensIn ?? 0, data.tokensOut ?? 0, cost, data.durationMs ?? 0],
    indexes: [data.missionId],
  });
}

// --- Also persist to D1 cost_events (for rollups + audit) ---
export async function recordCostEvent(
  env: Env,
  data: {
    missionId?: string | null;
    userId: string;
    agent: string;
    provider: string;
    model: string;
    eventType: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
  }
): Promise<void> {
  const cost = estimateCost(data.model, data.tokensIn ?? 0, data.tokensOut ?? 0);
  await env.DB.prepare(
    `INSERT INTO cost_events (mission_id, user_id, agent, provider, model, event_type, tokens_in, tokens_out, cost_usd, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    data.missionId ?? null, data.userId, data.agent, data.provider, data.model, data.eventType,
    data.tokensIn ?? 0, data.tokensOut ?? 0, cost, data.durationMs ?? 0
  ).run();
}

// ============================================================
// COP API
// ============================================================

copApp.get("/overview", async (c) => {
  const [activeMissions, activeVoice] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM missions WHERE status IN ('active','paused')`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_sessions WHERE status = 'active'`).first<{ n: number }>(),
  ]);
  const todayCost = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM cost_events WHERE created_at >= date('now')`
  ).first<{ cost: number }>();
  return c.json({
    active_missions: activeMissions?.n ?? 0,
    active_voice_sessions: activeVoice?.n ?? 0,
    cost_today_usd: todayCost?.cost ?? 0,
    timestamp: new Date().toISOString(),
  });
});

copApp.get("/missions", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT mission_id, user_id, total_cost_usd, total_tokens_in, total_tokens_out, ai_calls, tts_calls, stt_calls, tool_calls, updated_at
     FROM mission_costs ORDER BY total_cost_usd DESC LIMIT 50`
  ).all();
  return c.json(results.results);
});

copApp.get("/agents", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT agent, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost_usd) AS cost_usd
     FROM cost_events WHERE created_at >= datetime('now', '-1 day') GROUP BY agent ORDER BY cost_usd DESC`
  ).all();
  return c.json(results.results);
});

copApp.get("/voice", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS total_seconds,
            COUNT(DISTINCT tts_provider) AS tts_providers, COUNT(DISTINCT stt_provider) AS stt_providers
     FROM voice_sessions GROUP BY status`
  ).all();
  return c.json(results.results);
});

copApp.get("/gateway", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT provider, model, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd
     FROM cost_events WHERE created_at >= datetime('now', '-1 day') GROUP BY provider, model ORDER BY cost_usd DESC`
  ).all();
  return c.json(results.results);
});

copApp.get("/memory", async (c) => {
  let kvKeys = 0;
  try {
    const list = await c.env.ALFRED_COMMAND.list({ limit: 1000 });
    kvKeys = list.list_complete ? list.keys.length : list.keys.length + 1000;
  } catch {}
  const rows = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM missions) + (SELECT COUNT(*) FROM voice_sessions) +
            (SELECT COUNT(*) FROM mission_events) + (SELECT COUNT(*) FROM cost_events) AS n`
  ).first<{ n: number }>();
  await c.env.DB.prepare(
    `INSERT INTO memory_snapshots (kv_key_count, vectorize_count, d1_row_count) VALUES (?, ?, ?)`
  ).bind(kvKeys, 0, rows?.n ?? 0).run();
  return c.json({ kv_keys: kvKeys, vectorize_count: 0, d1_rows: rows?.n ?? 0, captured_at: new Date().toISOString() });
});

copApp.get("/burn-rate", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT agent, mission_id, SUM(tokens_in + tokens_out) AS tokens,
            (julianday('now') - julianday(MIN(created_at))) * 1440 AS minutes_elapsed
     FROM cost_events WHERE created_at >= datetime('now', '-1 hour') GROUP BY agent, mission_id`
  ).all();
  const burn = results.results.map((r: any) => ({
    agent: r.agent, mission_id: r.mission_id, tokens: r.tokens,
    burn_per_min: r.minutes_elapsed > 0 ? r.tokens / r.minutes_elapsed : r.tokens,
  }));
  return c.json(burn);
});

export default copApp;