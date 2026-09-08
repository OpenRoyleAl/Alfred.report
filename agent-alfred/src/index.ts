// agent-alfred — ORAL operator: Agents SDK Agent + Hono internals

import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { recordCop, recordCostEvent } from "../../src/cop/cop";
import { ingestMemories, recall, getMemorySummary, buildMemoryContext } from "../../src/memory/agent-memory";
import { runBrowserTask, type BrowserAction } from "./browser";
import { createAISearchTool, createPaymentsTool } from "./tools";
import { buildSystemPrompt, generateResponse, type AgentEnv } from "./llm";
import { OralOperatorAgent } from "./oral-agent";

export { OralOperatorAgent };

const app = new Hono<{ Bindings: AgentEnv }>();

export class Orchestrator extends DurableObject<AgentEnv> {
  async fetch(): Promise<Response> {
    return Response.json(
      { error: "Legacy Orchestrator endpoint retired" },
      { status: 410 },
    );
  }
}

app.post("/internal/process", async (c) => {
  const { text, sessionId, userId, personality, missionId } = await c.req.json<{
    text: string; sessionId: string; userId?: string; personality?: string; missionId?: string;
  }>();

  const start = Date.now();
  const uid = userId || "anonymous";
  const memoryContext = await buildMemoryContext(c.env as any, text, "alfred");
  const systemPrompt = buildSystemPrompt(personality || c.env.ALFRED_PERSONALITY, memoryContext ? `Relevant memories:\n${memoryContext}` : "");
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];
  const { response, provider, model, tokensIn, tokensOut } = await generateResponse(c.env, messages, uid);

  recordCop(c.env as any, {
    userId: uid,
    missionId: missionId || "oral",
    agent: "oral",
    provider,
    model,
    eventType: "llm",
    tokensIn,
    tokensOut,
    durationMs: Date.now() - start,
  });
  await recordCostEvent(c.env as any, {
    missionId: missionId || null,
    userId: uid,
    agent: "oral",
    provider,
    model,
    eventType: "llm",
    tokensIn,
    tokensOut,
    durationMs: Date.now() - start,
  });

  await ingestMemories(c.env as any, [
    { role: "user", content: text },
    { role: "assistant", content: response },
  ], "alfred").catch(() => {});

  return c.json({ response, sessionId, provider, model });
});

app.post("/internal/directive", async (c) => {
  const { missionId, directive } = await c.req.json<{ missionId: string; directive: string }>();
  const mission = await c.env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first<any>();
  if (!mission) return c.json({ error: "Mission not found" }, 404);

  const directives = mission.oral_directives ? JSON.parse(mission.oral_directives) : [];
  const messages = [
    {
      role: "system",
      content: `You are Alfred, an ORAL operator. Interpret the directive in mission context. Return JSON with "action" (update_status | add_directive | set_result | query_info) and "payload".`,
    },
    {
      role: "user",
      content: `Mission: ${mission.title}\nStatus: ${mission.status}\nDirective: ${directive}`,
    },
  ];
  const { response: interpretation } = await generateResponse(c.env, messages, mission.user_id);
  directives.push({ directive, interpretation, timestamp: new Date().toISOString() });
  await c.env.DB.prepare(`UPDATE missions SET oral_directives = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(JSON.stringify(directives), missionId).run();
  await c.env.DB.prepare(
    `INSERT INTO mission_events (mission_id, event_type, actor, event_data) VALUES (?, 'directive_added', 'oral_operator', ?)`
  ).bind(missionId, JSON.stringify({ directive, interpretation })).run();
  return c.json({ missionId, directive, interpretation, directives });
});

app.get("/internal/preferences", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  const prefs = await c.env.DB.prepare(`SELECT * FROM user_preferences WHERE user_id = ?`).bind(userId).first();
  return c.json(prefs || { user_id: userId, tts_provider: "workers-ai", stt_provider: "workers-ai", voice_model: "aura-2-en", language: "en" });
});

app.post("/internal/preferences", async (c) => {
  const body = await c.req.json<{ user_id: string; tts_provider?: string; stt_provider?: string; voice_model?: string; language?: string }>();
  if (!body.user_id) return c.json({ error: "user_id required" }, 400);
  const existing = await c.env.DB.prepare(`SELECT user_id FROM user_preferences WHERE user_id = ?`).bind(body.user_id).first();
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE user_preferences SET tts_provider = COALESCE(?, tts_provider), stt_provider = COALESCE(?, stt_provider),
       voice_model = COALESCE(?, voice_model), language = COALESCE(?, language), updated_at = datetime('now') WHERE user_id = ?`
    ).bind(body.tts_provider || null, body.stt_provider || null, body.voice_model || null, body.language || null, body.user_id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO user_preferences (user_id, tts_provider, stt_provider, voice_model, language, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(body.user_id, body.tts_provider || "workers-ai", body.stt_provider || "workers-ai", body.voice_model || "aura-2-en", body.language || "en").run();
  }
  return c.json(await c.env.DB.prepare(`SELECT * FROM user_preferences WHERE user_id = ?`).bind(body.user_id).first());
});

app.post("/internal/memory/remember", async (c) => {
  const { content, profile, metadata } = await c.req.json<{ content: string; profile?: string; metadata?: Record<string, string> }>();
  const memory = await c.env.ALFRED_MEMORY.getProfile(profile || "alfred");
  await memory.remember({
    content: metadata ? `${content}\n\nMetadata: ${JSON.stringify(metadata)}` : content,
  });
  return c.json({ success: true });
});

app.post("/internal/memory/recall", async (c) => {
  const { query, profile, topK } = await c.req.json<{ query: string; profile?: string; topK?: number }>();
  const results = await recall(c.env as any, query, profile || "alfred", topK);
  return c.json({ results });
});

app.get("/internal/memory/summary", async (c) => {
  const summary = await getMemorySummary(c.env as any, "alfred");
  return c.json({ summary });
});

app.post("/internal/browser-task", async (c) => {
  const { url, action, instructions } = await c.req.json<{
    url: string; action?: BrowserAction; instructions?: string;
  }>();
  try {
    const data = await runBrowserTask(c.env.BROWSER as any, {
      url,
      action: action || "markdown",
      instructions,
    });
    recordCop(c.env as any, {
      userId: "system",
      missionId: "browser",
      agent: "oral",
      provider: "browser-run",
      model: action || "markdown",
      eventType: "tool",
    });
    await recordCostEvent(c.env as any, {
      missionId: null,
      userId: "system",
      agent: "oral",
      provider: "browser-run",
      model: action || "markdown",
      eventType: "tool",
    });
    return c.json({ ok: true, action: action || "markdown", url, data });
  } catch (err) {
    return c.json({ error: "Browser task failed", detail: String(err) }, 502);
  }
});

app.post("/internal/search", async (c) => {
  const { query, filter } = await c.req.json<{ query: string; filter?: Record<string, string> }>();
  try {
    const search = createAISearchTool(c.env.AI_SEARCH);
    const results = await search.execute(query, filter);
    return c.json({ results });
  } catch (err) {
    return c.json({ error: "AI Search failed", detail: String(err) }, 502);
  }
});

app.post("/internal/payments/authorize", async (c) => {
  const body = await c.req.json<{ missionId?: string; amountUsd: number; purpose: string; url?: string }>();
  const payments = createPaymentsTool(c.env);
  const result = await payments.execute(body);
  return c.json(result, result.authorized ? 200 : 402);
});

app.get("/internal/health", async (c) => {
  return c.json({
    status: "ok",
    worker: "agent-alfred",
    role: "ORAL operator",
    personality: c.env.ALFRED_PERSONALITY,
    agent: "OralOperatorAgent",
    wallet: `${c.env.WALLET_HANDLE || "alfred"}.cloudflare.pay`,
    timestamp: new Date().toISOString(),
  });
});

export default {
  async fetch(request: Request, env: AgentEnv, ctx: ExecutionContext) {
    const agentResponse = await routeAgentRequest(request, env as any);
    if (agentResponse) return agentResponse;
    return app.fetch(request, env, ctx);
  },
};
