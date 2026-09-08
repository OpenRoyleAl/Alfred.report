// src/index.ts — Main Worker entry point (v2)
// Routes: static assets, voice WebSocket, TTS/STT, missions, reports, memory,
// COP Map, A2A, MCP (WebMCP), llms.txt, ORAL proxy, health

import { Hono } from "hono";
import type { Env } from "./types";
import { createTTSProvider } from "./voice/tts";
import { createSTTProvider } from "./voice/stt";
import { handleVoiceUpload, getVoiceSample } from "./voice/custom-voice";
import { getMemorySummary, buildMemoryContext } from "./memory/agent-memory";
import { createMission, getMission, listMissions, getUserPreferences } from "./db/queries";
import { handleAgentCard } from "./a2a/agent-card";
import { handleTaskSend, handleTaskGet, handleTaskCancel } from "./a2a/tasks";
import { handleMcp } from "./mcp/server";
import copApp from "./cop/cop";

export { MissionStateDO } from "./do/mission-state";
export { VoiceSessionDO } from "./do/voice-session";

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// Static assets — served by ASSETS binding, fallback to SPA
// ============================================================
app.all("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (
    path.startsWith("/api") || path.startsWith("/ws") ||
    path.startsWith("/a2a") || path === "/mcp" ||
    path === "/.well-known/agent.json" || path === "/llms.txt"
  ) {
    return next();
  }
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status !== 404) return response;
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
});

// ============================================================
// Voice WebSocket — voice.alfred.report/ws/:sessionId
// ============================================================
app.all("/ws/:sessionId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const sessionId = c.req.param("sessionId");
  const userId = c.req.query("user_id") || "anonymous";
  const doId = c.env.VOICE_SESSION.idFromName(sessionId);
  const doStub = c.env.VOICE_SESSION.get(doId);
  await c.env.DB.prepare(
    `INSERT INTO voice_sessions (id, user_id, do_id, status, tts_provider, stt_provider, voice_model, language)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'en')`
  ).bind(sessionId, userId, doId.toString(), c.env.TTS_PROVIDER, c.env.STT_PROVIDER, c.env.VOICE_MODEL).run();
  return doStub.fetch(c.req.raw);
});

// ============================================================
// TTS endpoint — speak.alfred.report/api/tts
// ============================================================
app.post("/api/tts", async (c) => {
  const body = await c.req.json<{ text: string; voice?: string; provider?: string; user_id?: string }>();
  if (!body.text) return c.json({ error: "text is required" }, 400);
  let provider = body.provider || c.env.TTS_PROVIDER;
  if (!body.provider && body.user_id) {
    const prefs = await getUserPreferences(c.env, body.user_id);
    if (prefs?.tts_provider) provider = prefs.tts_provider;
  }
  const tts = createTTSProvider(c.env, provider);
  const audio = await tts.synthesize(body.text, { voice: body.voice || c.env.VOICE_MODEL });
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
});

// ============================================================
// STT endpoint — speak.alfred.report/api/stt
// ============================================================
app.post("/api/stt", async (c) => {
  const formData = await c.req.formData();
  const audioFile = formData.get("audio") as File;
  const provider = (formData.get("provider") as string) || c.env.STT_PROVIDER;
  if (!audioFile) return c.json({ error: "audio file is required" }, 400);
  const stt = createSTTProvider(c.env, provider);
  const transcript = await stt.transcribe(await audioFile.arrayBuffer());
  return c.json({ transcript });
});

// ============================================================
// Voice samples
// ============================================================
app.post("/api/voice-samples/upload", async (c) => {
  const userId = c.req.query("user_id") || "anonymous";
  return handleVoiceUpload(c.req.raw, c.env, userId);
});

app.get("/api/voice-samples/:id", async (c) => {
  return getVoiceSample(c.env, c.req.param("id"));
});

// ============================================================
// Missions
// ============================================================
app.post("/api/missions", async (c) => {
  const body = await c.req.json<{
    user_id: string; title: string; description?: string;
    priority?: number; oral_directives?: string; budget_usd?: number;
  }>();
  if (!body.user_id || !body.title) return c.json({ error: "user_id and title are required" }, 400);
  const mission = await createMission(c.env, body);
  return c.json(mission, 201);
});

app.get("/api/missions/:id", async (c) => {
  const mission = await getMission(c.env, c.req.param("id"));
  if (!mission) return c.json({ error: "Not found" }, 404);
  return c.json(mission);
});

app.get("/api/missions", async (c) => {
  const missions = await listMissions(c.env, c.req.query("user_id"), c.req.query("status"));
  return c.json(missions);
});

app.patch("/api/missions/:id/status", async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: string }>();
  const doId = c.env.MISSION_STATE.idFromName(id);
  const doStub = c.env.MISSION_STATE.get(doId);
  const action = status === "active" ? "start" : status === "paused" ? "pause" : status === "completed" ? "complete" : null;
  if (!action) return c.json({ error: "Invalid status transition" }, 400);
  return doStub.fetch(new Request(`https://do/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await c.req.json()),
  }));
});

app.get("/api/missions/:id/events", async (c) => {
  const results = await c.env.DB.prepare(
    `SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at DESC`
  ).bind(c.req.param("id")).all();
  return c.json(results.results);
});

// ============================================================
// Reports — delegated to alfred-report
// ============================================================
app.get("/api/reports/:missionId", async (c) => {
  return c.env.ALFRED_REPORT.fetch(`https://alfred-report/internal/report/${c.req.param("missionId")}`, { headers: c.req.raw.headers });
});

app.get("/api/reports", async (c) => {
  const userId = c.req.query("user_id") || "";
  return c.env.ALFRED_REPORT.fetch(`https://alfred-report/internal/reports?user_id=${userId}`, { headers: c.req.raw.headers });
});

// ============================================================
// Agent Memory (Cloudflare Agent Memory — namespace: alfred)
// ============================================================
app.get("/api/memory/summary", async (c) => {
  const profile = c.req.query("profile") || "default";
  const summary = await getMemorySummary(c.env, profile);
  return c.json({ summary });
});

app.post("/api/memory/recall", async (c) => {
  const { query, profile } = await c.req.json<{ query: string; profile?: string }>();
  const context = await buildMemoryContext(c.env, query, profile || "default");
  return c.json({ context });
});

// ============================================================
// COP Map — /api/cop/*
// ============================================================
app.route("/api/cop", copApp);

// ============================================================
// ORAL operator proxy — /api/oral/*
// ============================================================
app.all("/api/oral/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace("/api/oral", "");
  return c.env.AGENT_ALFRED.fetch(`https://agent-alfred/internal${path}`, {
    method: c.req.method, headers: c.req.raw.headers,
    body: c.req.method !== "GET" ? c.req.raw.body : undefined,
  });
});

// ============================================================
// A2A — agent-to-agent protocol
// ============================================================
app.get("/.well-known/agent.json", (c) => handleAgentCard(c.env));
app.post("/a2a/tasks/send", (c) => handleTaskSend(c.req.raw, c.env));
app.get("/a2a/tasks/get", (c) => handleTaskGet(c.req.raw, c.env));
app.post("/a2a/tasks/cancel", (c) => handleTaskCancel(c.req.raw, c.env));

// ============================================================
// MCP / WebMCP — mcp.alfred.report/mcp
// ============================================================
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

// llms.txt for agent discovery
app.get("/llms.txt", (c) => c.text(`# alfred.report
# AI agent-readable site index

# About
Alfred is an ORAL (Operator Response and Action Logic) operator running on Cloudflare Workers.
Capabilities: mission execution, voice interaction, report generation.

# MCP Endpoint
https://mcp.alfred.report/mcp

# A2A Agent Card
https://alfred.report/.well-known/agent.json

# API
https://command-os-review.icebergmedia.co.uk/api/health
https://speak.alfred.report/api/tts
https://voice.alfred.report/ws

# Authentication
Cloudflare Access service token required for write endpoints.
Read endpoints (health, agent card, llms.txt) are public.
`));

// ============================================================
// Health check
// ============================================================
app.get("/api/health", async (c) => {
  return c.json({
    status: "ok",
    environment: c.env.ENVIRONMENT,
    tts_provider: c.env.TTS_PROVIDER,
    stt_provider: c.env.STT_PROVIDER,
    voice_model: c.env.VOICE_MODEL,
    personality: c.env.ALFRED_PERSONALITY,
    timestamp: new Date().toISOString(),
  });
});

export default app;