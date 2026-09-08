// alfred-report/src/index.ts — Board / Report Generation Worker (v2)
// Uses: D1 queries, Agent Memory context, AI Search grounding, Workers AI
// summaries, COP telemetry, R2 report storage.

import { Hono } from "hono";
import { recordCop } from "../../src/cop/cop";

interface ReportEnv {
  DB: D1Database;
  ALFRED_MEMORY: AgentMemoryNamespace;
  ALFRED_DATA: R2Bucket;
  AI: Ai;
  ALFRED_COP: AnalyticsEngineDataset;
  AI_SEARCH: AiSearchNamespace;
}

const app = new Hono<{ Bindings: ReportEnv }>();

// ============================================================
// Internal: Get report for a specific mission
// ============================================================
app.get("/internal/report/:missionId", async (c) => {
  const missionId = c.req.param("missionId");

  const mission = await c.env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first<any>();
  if (!mission) return c.json({ error: "Mission not found" }, 404);

  const events = await c.env.DB.prepare(
    `SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC`
  ).bind(missionId).all();

  const voiceSessions = await c.env.DB.prepare(
    `SELECT * FROM voice_sessions WHERE mission_id = ? ORDER BY created_at ASC`
  ).bind(missionId).all();

  const costs = await c.env.DB.prepare(
    `SELECT * FROM mission_costs WHERE mission_id = ?`
  ).bind(missionId).first();

  const report = {
    mission: {
      id: mission.id, title: mission.title, description: mission.description,
      status: mission.status, priority: mission.priority,
      budget_usd: mission.budget_usd, spent_usd: costs?.total_cost_usd ?? 0,
      created_at: mission.created_at, started_at: mission.started_at, completed_at: mission.completed_at,
      result: mission.result ? JSON.parse(mission.result) : null,
      oral_directives: mission.oral_directives ? JSON.parse(mission.oral_directives) : [],
    },
    costs: costs || null,
    events: events.results,
    voice_sessions: voiceSessions.results.map((vs: any) => ({
      id: vs.id, status: vs.status, tts_provider: vs.tts_provider, stt_provider: vs.stt_provider,
      duration_seconds: vs.duration_seconds, created_at: vs.created_at, ended_at: vs.ended_at,
      transcript: vs.transcript ? JSON.parse(vs.transcript) : null,
    })),
    summary: generateSummary(mission, events.results, voiceSessions.results, costs),
    generated_at: new Date().toISOString(),
  };

  return c.json(report);
});

// ============================================================
// Internal: List reports for a user
// ============================================================
app.get("/internal/reports", async (c) => {
  const userId = c.req.query("user_id") || "";
  let query = `SELECT id, title, status, priority, budget_usd, created_at, completed_at, result FROM missions`;
  const params: string[] = [];
  if (userId) { query += ` WHERE user_id = ?`; params.push(userId); }
  query += ` ORDER BY created_at DESC LIMIT 50`;

  const stmt = c.env.DB.prepare(query);
  const result = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

  const reports = result.results.map((m: any) => ({
    mission_id: m.id, title: m.title, status: m.status, priority: m.priority,
    budget_usd: m.budget_usd, created_at: m.created_at, completed_at: m.completed_at,
    summary: m.result ? `Completed — ${m.result.substring(0, 100)}` : `${m.status}`,
  }));

  return c.json(reports);
});

// ============================================================
// Internal: AI-powered report summary (with COP telemetry)
// ============================================================
app.post("/internal/report/:missionId/ai-summary", async (c) => {
  const missionId = c.req.param("missionId");
  const start = Date.now();

  const mission = await c.env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first<any>();
  if (!mission) return c.json({ error: "Mission not found" }, 404);

  const events = await c.env.DB.prepare(
    `SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC`
  ).bind(missionId).all();

  const voiceSessions = await c.env.DB.prepare(
    `SELECT * FROM voice_sessions WHERE mission_id = ?`
  ).bind(missionId).all();

  const eventSummary = events.results
    .map((e: any) => `[${e.created_at}] ${e.event_type} by ${e.actor || "system"}${e.event_data ? `: ${e.event_data}` : ""}`)
    .join("\n");

  const transcriptSummary = voiceSessions.results
    .map((vs: any) => {
      if (!vs.transcript) return "";
      const transcript = JSON.parse(vs.transcript);
      return transcript.map((t: any) => `${t.speaker}: ${t.text}`).join("\n");
    })
    .filter(Boolean)
    .join("\n---\n");

  const prompt = `Generate a concise executive summary report for the following mission:

Mission: ${mission.title}
Description: ${mission.description || "N/A"}
Status: ${mission.status}
Priority: ${mission.priority}

Event Log:
${eventSummary || "No events recorded"}

Voice Transcripts:
${transcriptSummary || "No voice sessions"}

Provide:
1. Executive Summary (2-3 sentences)
2. Key Outcomes
3. Timeline Highlights
4. Recommendations`;

  const aiResponse = await c.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    { messages: [{ role: "user", content: prompt }], temperature: 0.3 }
  ) as any;

  const summary = aiResponse.response || "Failed to generate summary";
  const tokensIn = Math.ceil(prompt.length / 4);
  const tokensOut = Math.ceil(summary.length / 4);

  // COP telemetry
  recordCop(c.env, {
    userId: mission.user_id, missionId, agent: "report",
    provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    eventType: "llm", tokensIn, tokensOut, durationMs: Date.now() - start,
  });
  await c.env.DB.prepare(
    `INSERT INTO cost_events (mission_id, user_id, agent, provider, model, event_type, tokens_in, tokens_out, cost_usd, duration_ms)
     VALUES (?, ?, 'report', 'workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'llm', ?, ?, ?, ?)`
  ).bind(missionId, mission.user_id, tokensIn, tokensOut, (tokensIn / 1e6) * 0.15 + (tokensOut / 1e6) * 0.60, Date.now() - start).run();

  // Store AI summary in R2
  const reportKey = `reports/${missionId}/${Date.now()}-ai-summary.json`;
  await c.env.ALFRED_DATA.put(reportKey, JSON.stringify({ missionId, summary, generated_at: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json({ missionId, summary, r2_key: reportKey });
});

// ============================================================
// Internal: Export full mission data to R2
// ============================================================
app.post("/internal/report/:missionId/export", async (c) => {
  const missionId = c.req.param("missionId");
  const mission = await c.env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first<any>();
  if (!mission) return c.json({ error: "Mission not found" }, 404);

  const events = await c.env.DB.prepare(
    `SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC`
  ).bind(missionId).all();

  const voiceSessions = await c.env.DB.prepare(
    `SELECT * FROM voice_sessions WHERE mission_id = ?`
  ).bind(missionId).all();

  const costs = await c.env.DB.prepare(
    `SELECT * FROM cost_events WHERE mission_id = ? ORDER BY created_at ASC`
  ).bind(missionId).all();

  const exportData = {
    export_version: "2.0",
    exported_at: new Date().toISOString(),
    mission, events: events.results, voice_sessions: voiceSessions.results, costs: costs.results,
  };

  const exportKey = `exports/${missionId}/${Date.now()}-full-export.json`;
  await c.env.ALFRED_DATA.put(exportKey, JSON.stringify(exportData, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json({ missionId, export_key: exportKey, size: JSON.stringify(exportData).length });
});

// ============================================================
// Internal: AI Search grounded report
// ============================================================
app.get("/internal/grounded/:missionId", async (c) => {
  const missionId = c.req.param("missionId");
  const mission = await c.env.DB.prepare(`SELECT * FROM missions WHERE id = ?`).bind(missionId).first<any>();
  if (!mission) return c.json({ error: "Mission not found" }, 404);

  try {
    const instance = c.env.AI_SEARCH.get("alfred-kb");
    const searchResults = await instance.search({ query: mission.title });
    return c.json({ missionId, search_results: searchResults });
  } catch (err) {
    return c.json({ error: "AI Search failed", detail: String(err) }, 502);
  }
});

// ============================================================
// Health
// ============================================================
app.get("/internal/health", async (c) => {
  return c.json({ status: "ok", worker: "alfred-report", role: "Board / Report Generation", timestamp: new Date().toISOString() });
});

// ============================================================
// Helper: quick summary without AI
// ============================================================
function generateSummary(mission: any, events: any[], voiceSessions: any[], costs: any): string {
  const parts: string[] = [];
  parts.push(`Mission "${mission.title}" is currently ${mission.status}.`);
  if (mission.priority >= 8) parts.push(`This was a high-priority mission (priority ${mission.priority}).`);
  if (events.length > 0) {
    const eventTypes = events.map((e: any) => e.event_type);
    parts.push(`Recorded ${events.length} events: ${eventTypes.join(", ")}.`);
  }
  if (voiceSessions.length > 0) {
    const totalDuration = voiceSessions.reduce((sum: number, vs: any) => sum + (vs.duration_seconds || 0), 0);
    parts.push(`${voiceSessions.length} voice session(s) totaling ${totalDuration}s.`);
  }
  if (costs) parts.push(`Total cost: $${costs.total_cost_usd.toFixed(4)} across ${costs.ai_calls} AI calls.`);
  if (mission.result) parts.push(`Mission completed with results recorded.`);
  return parts.join(" ");
}

export default app;