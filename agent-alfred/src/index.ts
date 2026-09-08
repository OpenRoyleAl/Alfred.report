// agent-alfred/src/index.ts — ORAL Operator Worker (v2)
// Uses: Cloudflare Agent Memory (namespace: alfred), AI Gateway routing,
// Workers AI (LLM default), COP telemetry, Alfred personality.
// Browser Run + AI Search tools via Agents SDK (see agents-sdk.ts).

import { Hono } from "hono";
import { recordCop, estimateCost } from "../../src/cop/cop";
import { ingestMemories, recall, getMemorySummary, buildMemoryContext } from "../../src/memory/agent-memory";

interface AgentEnv {
  AI: Ai;
  DB: D1Database;
  ALFRED_MEMORY: AgentMemoryNamespace;
  ALFRED_DATA: R2Bucket;
  ALFRED_COP: AnalyticsEngineDataset;
  AI_SEARCH: AiSearchNamespace;
  BROWSER: Fetcher;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_URL: string;
  OPENAI_API_KEY: string;
  MIMO_API_KEY: string;
  XAI_API_KEY: string;
  ALFRED_PERSONALITY: string;
}

const app = new Hono<{ Bindings: AgentEnv }>();

// ============================================================
// Internal: Process text input (called by VoiceSessionDO + frontend)
// ============================================================
app.post("/internal/process", async (c) => {
  const { text, sessionId, userId, personality } = await c.req.json<{
    text: string; sessionId: string; userId?: string; personality?: string;
  }>();

  const start = Date.now();
  const uid = userId || "anonymous";

  // 1. Recall relevant memories from Agent Memory
  const memoryContext = await buildMemoryContext(c.env, text, "alfred");

  // 2. Build prompt with Alfred personality
  const systemPrompt = buildSystemPrompt(personality || c.env.ALFRED_PERSONALITY, memoryContext);

  const messages = [
    { role: "system", content: systemPrompt },
    ...(memoryContext ? [{ role: "system", content: `Relevant memories:\n${memoryContext}` }] : []),
    { role: "user", content: text },
  ];

  // 3. Generate response via AI Gateway (Workers AI default)
  const { response, provider, model, tokensIn, tokensOut } = await generateResponse(c.env, messages, uid);

  // 4. COP telemetry
  recordCop(c.env, {
    userId: uid,
    missionId: "oral",
    agent: "oral",
    provider,
    model,
    eventType: "llm",
    tokensIn,
    tokensOut,
    durationMs: Date.now() - start,
  });
  await c.env.DB.prepare(
    `INSERT INTO cost_events (mission_id, user_id, agent, provider, model, event_type, tokens_in, tokens_out, cost_usd, duration_ms)
     VALUES (?, ?, 'oral', ?, ?, 'llm', ?, ?, ?, ?)`
  ).bind("oral", uid, provider, model, tokensIn, tokensOut, estimateCost(model, tokensIn, tokensOut), Date.now() - start).run();

  // 5. Store conversation in Agent Memory (ingest — batched, non-blocking)
  await ingestMemories(c.env, [
    { role: "user", content: text },
    { role: "assistant", content: response },
  ], "alfred").catch(() => {});

  return c.json({ response, sessionId, provider, model });
});

// ============================================================
// Internal: ORAL directive interpretation
// ============================================================
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

// ============================================================
// Internal: User preferences
// ============================================================
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

// ============================================================
// Internal: Agent Memory operations
// ============================================================
app.post("/internal/memory/remember", async (c) => {
  const { content, profile, metadata } = await c.req.json<{ content: string; profile?: string; metadata?: Record<string, string> }>();
  await c.env.ALFRED_MEMORY.remember({ content, profile: profile || "alfred", metadata });
  return c.json({ success: true });
});

app.post("/internal/memory/recall", async (c) => {
  const { query, profile, topK } = await c.req.json<{ query: string; profile?: string; topK?: number }>();
  const results = await recall(c.env, query, profile || "alfred", topK);
  return c.json({ results });
});

app.get("/internal/memory/summary", async (c) => {
  const summary = await getMemorySummary(c.env, "alfred");
  return c.json({ summary });
});

// ============================================================
// Internal: Browser Run web task
// ============================================================
app.post("/internal/browser-task", async (c) => {
  const { url, action, instructions } = await c.req.json<{
    url: string; action: "execute" | "markdown" | "extract" | "links" | "scrape"; instructions?: string;
  }>();

  try {
    // Browser Run quick actions via BROWSER binding
    const response = await c.env.BROWSER.fetch(`https://browser-execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, action, instructions }),
    });
    const data = await response.json();
    return c.json(data);
  } catch (err) {
    return c.json({ error: "Browser task failed", detail: String(err) }, 502);
  }
});

// ============================================================
// Internal: AI Search grounding
// ============================================================
app.post("/internal/search", async (c) => {
  const { query, filter } = await c.req.json<{ query: string; filter?: Record<string, string> }>();
  try {
    const instance = c.env.AI_SEARCH.get("alfred-kb");
    const results = await instance.search({ query, filter });
    return c.json(results);
  } catch (err) {
    return c.json({ error: "AI Search failed", detail: String(err) }, 502);
  }
});

// ============================================================
// Health
// ============================================================
app.get("/internal/health", async (c) => {
  return c.json({
    status: "ok",
    worker: "agent-alfred",
    role: "ORAL operator",
    personality: c.env.ALFRED_PERSONALITY,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// Helpers
// ============================================================

function buildSystemPrompt(personality: string, memoryContext: string): string {
  let prompt = `You are Alfred, a warm British male ORAL (Operator Response and Action Logic) operator. `;
  prompt += `You are authoritative yet approachable. You speak concisely with dry wit. You are highly proactive. `;
  prompt += `You manage missions, interact via voice, and generate reports. `;
  prompt += `Respond naturally as if speaking aloud — keep responses spoken-style and concise.\n`;
  if (memoryContext) prompt += `\nRelevant context from past conversations:\n${memoryContext}\n`;
  return prompt;
}

async function generateResponse(
  env: AgentEnv,
  messages: any[],
  userId: string
): Promise<{ response: string; provider: string; model: string; tokensIn: number; tokensOut: number }> {
  // Determine provider from user preferences
  let provider = "workers-ai";
  try {
    const prefs = await env.DB.prepare(`SELECT tts_provider FROM user_preferences WHERE user_id = ?`).bind(userId).first<{ tts_provider: string }>();
    provider = prefs?.tts_provider || "workers-ai";
  } catch { /* default */ }

  const tokensIn = messages.reduce((sum, m) => sum + Math.ceil((m.content || "").length / 4), 0);
  let response = "";
  let model = "";

  switch (provider) {
    case "openai": {
      model = "gpt-4o";
      const res = await fetch(`${env.AI_GATEWAY_URL}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    case "mimo": {
      model = "mimo-latest";
      const res = await fetch(`${env.AI_GATEWAY_URL}/custom-mimo/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MIMO_API_KEY}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    case "xai": {
      model = "grok-3";
      const res = await fetch(`${env.AI_GATEWAY_URL}/custom-xai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.XAI_API_KEY}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    default: {
      model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      const aiResponse = await env.AI.run(model, { messages, temperature: 0.7 }) as any;
      response = aiResponse.response || "";
      provider = "workers-ai";
    }
  }

  const tokensOut = Math.ceil(response.length / 4);
  return { response, provider, model, tokensIn, tokensOut };
}

export default app;