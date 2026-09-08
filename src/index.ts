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
import copApp, { recordCop, recordCostEvent } from "./cop/cop";
import { googleCallback, googleStart } from "./auth/google";
import { getSession, hasAccessServiceToken, clearSessionCookie } from "./auth/session";
import { briefingUrl, findSiriToken, issueSiriToken, shortcutsImportUrl } from "./siri/tokens";
import { buildAlfredReportShortcut } from "./siri/shortcut";

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
    path.startsWith("/agents") || path.startsWith("/voice") ||
    path === "/.well-known/agent.json" || path === "/llms.txt" ||
    path === "/robots.txt" || path === "/shortcut.download" ||
    path.startsWith("/auth") || path.startsWith("/siri")
  ) {
    return next();
  }
  if (path === "/board" || path === "/board/") {
    return c.env.ASSETS.fetch(new Request(new URL("/board.html", c.req.url)));
  }
  if (path === "/for-agents" || path === "/for-agents/") {
    return c.env.ASSETS.fetch(new Request(new URL("/for-agents.html", c.req.url)));
  }
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status !== 404) return response;
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
});

app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path === "/api/me") return next();
  if (hasAccessServiceToken(c)) return next();
  if (await getSession(c.env, c)) return next();
  return c.json({ error: "unauthorized" }, 401);
});

// ============================================================
// Voice WebSocket — voice.alfred.report/ws/:sessionId
// ============================================================
app.all("/ws/:sessionId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const sessionId = c.req.param("sessionId");
  const userId = c.req.query("user_id") || "anonymous";
  const missionId = c.req.query("mission_id") || null;
  const doId = c.env.VOICE_SESSION.idFromName(sessionId);
  const doStub = c.env.VOICE_SESSION.get(doId);
  await c.env.DB.prepare(
    `INSERT INTO voice_sessions (id, user_id, mission_id, do_id, status, tts_provider, stt_provider, voice_model, language)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 'en')`
  ).bind(sessionId, userId, missionId, doId.toString(), c.env.TTS_PROVIDER, c.env.STT_PROVIDER, c.env.VOICE_MODEL).run();
  return doStub.fetch(c.req.raw);
});

// ============================================================
// TTS endpoint — speak.alfred.report/api/tts
// ============================================================
app.post("/api/tts", async (c) => {
  const start = Date.now();
  const body = await c.req.json<{ text: string; voice?: string; provider?: string; user_id?: string; mission_id?: string }>();
  if (!body.text) return c.json({ error: "text is required" }, 400);
  let provider = body.provider || c.env.TTS_PROVIDER;
  if (!body.provider && body.user_id) {
    const prefs = await getUserPreferences(c.env, body.user_id);
    if (prefs?.tts_provider) provider = prefs.tts_provider;
  }
  const tts = createTTSProvider(c.env, provider);
  const audio = await tts.synthesize(body.text, { voice: body.voice || c.env.VOICE_MODEL });
  const model = provider === "workers-ai"
    ? ((body.voice || c.env.VOICE_MODEL).startsWith("aura-2") ? "@cf/deepgram/aura-2-en" : "@cf/deepgram/aura-1")
    : provider === "mimo" ? "mimo-v2.5-tts" : body.voice || "tts-1";
  recordCop(c.env, {
    userId: body.user_id || "anonymous",
    missionId: "voice",
    agent: "voice",
    provider,
    model,
    eventType: "tts",
    tokensOut: Math.ceil(body.text.length / 4),
    durationMs: Date.now() - start,
  });
  await recordCostEvent(c.env, {
    missionId: body.mission_id || null,
    userId: body.user_id || "anonymous",
    agent: "voice",
    provider,
    model,
    eventType: "tts",
    tokensOut: Math.ceil(body.text.length / 4),
    durationMs: Date.now() - start,
  });
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
});

// ============================================================
// STT endpoint — speak.alfred.report/api/stt
// ============================================================
app.post("/api/stt", async (c) => {
  const start = Date.now();
  const formData = await c.req.formData();
  const audioFile = formData.get("audio") as File;
  const provider = (formData.get("provider") as string) || c.env.STT_PROVIDER;
  const userId = (formData.get("user_id") as string) || "anonymous";
  const missionId = (formData.get("mission_id") as string) || null;
  if (!audioFile) return c.json({ error: "audio file is required" }, 400);
  const stt = createSTTProvider(c.env, provider);
  const transcript = await stt.transcribe(await audioFile.arrayBuffer());
  recordCop(c.env, {
    userId,
    missionId: "voice",
    agent: "voice",
    provider,
    model: provider === "deepgram" ? "@cf/deepgram/nova-3" : "@cf/openai/whisper-large-v3-turbo",
    eventType: "stt",
    tokensOut: Math.ceil(transcript.length / 4),
    durationMs: Date.now() - start,
  });
  await recordCostEvent(c.env, {
    missionId,
    userId,
    agent: "voice",
    provider,
    model: provider === "deepgram" ? "@cf/deepgram/nova-3" : "@cf/openai/whisper-large-v3-turbo",
    eventType: "stt",
    tokensOut: Math.ceil(transcript.length / 4),
    durationMs: Date.now() - start,
  });
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
  let body: { user_id?: string; title?: string; description?: string; priority?: number; oral_directives?: string; budget_usd?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body.user_id || !body.title) return c.json({ error: "user_id and title are required" }, 400);
  const mission = await createMission(c.env, body as { user_id: string; title: string; description?: string; priority?: number; oral_directives?: string; budget_usd?: number });
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

async function missionDo(env: Env, id: string, action: string, body?: unknown): Promise<Response> {
  const doId = env.MISSION_STATE.idFromName(id);
  const doStub = env.MISSION_STATE.get(doId);
  return doStub.fetch(new Request(`https://do/${action}?missionId=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }));
}

app.patch("/api/missions/:id/status", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; result?: unknown; evidence?: unknown[] }>();
  const { status } = body;
  const action = status === "active" ? "start" : status === "paused" ? "pause" : status === "completed" ? "complete" : null;
  if (!action) return c.json({ error: "Invalid status transition" }, 400);
  try {
    return await missionDo(c.env, id, action, body);
  } catch (error) {
    console.error("Mission transition failed", error);
    return c.json({ error: "Mission transition failed" }, 500);
  }
});

app.post("/api/missions/:id/execute", async (c) => {
  const id = c.req.param("id");
  const mission = await getMission(c.env, id);
  if (!mission) return c.json({ error: "Not found" }, 404);
  const startRes = await missionDo(c.env, id, "start");
  if (!startRes.ok && startRes.status !== 409) return startRes;

  const urlMatch = `${mission.description || ""} ${mission.title}`.match(/https?:\/\/[^\s]+/i);
  let scrape: unknown = null;
  if (urlMatch) {
    const browserRes = await c.env.AGENT_ALFRED.fetch("https://agent-alfred/internal/browser-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlMatch[0], action: "markdown" }),
    });
    scrape = await browserRes.json();
    await missionDo(c.env, id, "evidence", {
      evidence: { type: "browser_markdown", url: urlMatch[0], scrape },
    });
  } else {
    await missionDo(c.env, id, "evidence", {
      evidence: { type: "execution", note: "Mission executed without scrape target" },
    });
  }

  const completeRes = await missionDo(c.env, id, "complete", {
    result: { executed: true, scrape: scrape ? { ok: true, url: urlMatch?.[0] } : null },
  });
  const completeText = await completeRes.text();
  let completed: unknown;
  try {
    completed = JSON.parse(completeText);
  } catch {
    completed = { error: "complete failed", status: completeRes.status, body: completeText.slice(0, 500) };
  }
  return c.json({ missionId: id, start: startRes.status, completed }, completeRes.ok ? 200 : 502);
});

app.post("/api/missions/:id/gate", async (c) => {
  return missionDo(c.env, c.req.param("id"), "gate");
});

app.post("/api/missions/:id/evidence", async (c) => {
  const body = await c.req.json<{ evidence: unknown }>();
  return missionDo(c.env, c.req.param("id"), "evidence", body);
});

app.get("/api/missions/:id/status", async (c) => {
  return missionDo(c.env, c.req.param("id"), "status");
});

app.get("/api/missions/:id/debrief", async (c) => {
  const id = c.req.param("id");
  const event = await c.env.DB.prepare(
    `SELECT event_data, created_at FROM mission_events
     WHERE mission_id = ? AND actor = 'alfred' AND event_data LIKE '%"debrief":true%'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(id).first<{ event_data: string; created_at: string }>();
  if (!event) return c.json({ error: "No debrief" }, 404);
  const stored = await c.env.ALFRED_DATA.get(`debriefs/${id}.txt`);
  return c.json({
    missionId: id,
    created_at: event.created_at,
    ...(event.event_data ? JSON.parse(event.event_data) : {}),
    body: stored ? await stored.text() : null,
  });
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
  const profile = c.req.query("profile") || "alfred";
  const summary = await getMemorySummary(c.env, profile);
  return c.json({ summary });
});

app.post("/api/memory/recall", async (c) => {
  const { query, profile } = await c.req.json<{ query: string; profile?: string }>();
  const context = await buildMemoryContext(c.env, query, profile || "alfred");
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

app.all("/agents/*", async (c) => {
  return c.env.AGENT_ALFRED.fetch(c.req.raw);
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
# OpenRoyleAl — Alfred, the oral operator

> Wake word: Alfred, report!

Alfred is the OpenRoyleAl operator. Humans speak. Agents call. Runtime: Cloudflare Workers.

# Product
https://alfred.report/
https://alfred.report/board
https://alfred.report/voice/hello

# Humans
Say or click "Alfred, report!" for voice.
Sign in to add Siri: Hey Siri, Alfred report.
Board: missions, COP Map, voice, reports.

# Agents
A2A card: https://alfred.report/.well-known/agent.json
MCP: https://mcp.alfred.report/mcp
Agents SDK: https://alfred.report/agents/oral-operator-agent/default
Briefing: https://voice.alfred.report/voice/briefing?token=

# Capabilities
Mission execution with evidence gates.
Workers AI voice (Aura-2 TTS, Whisper/Flux STT).
Browser scrape, AI Search, Agent Memory.
ORAL: Operator Response and Action Logic.

# Auth
Google sign-in for the human board.
Service tokens / MCP for write APIs.
llms.txt, agent card, /voice/hello, and this file are public.
`));

app.get("/robots.txt", (c) => c.text(`# Bot Preference Sync — alfred.report
User-agent: *
Allow: /
Allow: /llms.txt
Allow: /for-agents
Allow: /.well-known/agent.json
Allow: /voice/hello

# Search engines
User-agent: Googlebot
Allow: /
User-agent: Bingbot
Allow: /

# AI crawlers: Pay Per Crawl on alfred.report (closed beta).
User-agent: GPTBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: CCBot
Allow: /
`));

function tokensEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i];
  return out === 0;
}

async function authorizeBriefing(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }; env: Env }): Promise<boolean> {
  const clientId = c.req.header("CF-Access-Client-Id");
  const clientSecret = c.req.header("CF-Access-Client-Secret");
  if (clientId && clientSecret) return true;
  if (c.req.header("Cookie")?.includes("CF_Authorization=")) return true;
  const presented = c.req.query("token") || "";
  if (!presented) return false;
  try {
    const row = await c.env.DB.prepare(`SELECT token FROM siri_tokens WHERE token = ?`).bind(presented).first<{ token: string }>();
    if (row?.token && tokensEqual(presented, row.token)) {
      await c.env.DB.prepare(`UPDATE siri_tokens SET last_used_at = datetime('now') WHERE token = ?`).bind(presented).run().catch(() => {});
      return true;
    }
  } catch {}
  try {
    const expected = await c.env.SIRI_BRIEFING_TOKEN.get();
    return tokensEqual(presented, expected);
  } catch {
    return false;
  }
}

async function toArrayBuffer(value: unknown): Promise<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (value instanceof Blob) return value.arrayBuffer();
  if (value && typeof (value as ReadableStream).getReader === "function") {
    return new Response(value as ReadableStream).arrayBuffer();
  }
  return new TextEncoder().encode(String(value)).buffer as ArrayBuffer;
}

app.get("/auth/google", (c) => googleStart(c.env, c.req.url));
app.get("/auth/google/callback", (c) => googleCallback(c.env, c.req.raw));
app.get("/auth/logout", (c) => {
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
});

app.get("/api/me", async (c) => {
  const session = await getSession(c.env, c);
  if (!session) return c.json({ authenticated: false }, 401);
  const issued = await issueSiriToken(c.env, session.email);
  return c.json({
    authenticated: true,
    email: session.email,
    user_id: session.userId,
    token: issued.token,
    briefing_url: briefingUrl(issued.token),
    shortcuts_url: shortcutsImportUrl(issued.token),
    shortcut_name: "Alfred report",
    method: "GET",
  });
});

app.get("/siri/alfred-report.shortcut", async (c) => {
  const token = c.req.query("token") || "";
  const row = await findSiriToken(c.env, token);
  if (!row) return c.text("Not found", 404);
  const body = buildAlfredReportShortcut(token);
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-apple-shortcut",
      "Content-Disposition": 'attachment; filename="Alfred report.shortcut"',
      "Cache-Control": "no-store",
    },
  });
});

app.get("/shortcut.download", async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/Alfred-Briefing.shortcut", c.req.url)));
  if (!asset.ok) return c.text("Shortcut not found", 404);
  return new Response(asset.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="Alfred-Briefing.shortcut"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

app.get("/voice/hello", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/voice/hello?v=3", c.req.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const text = "Alfred, reporting. This is Alfred.report, from OpenRoyleAl. Say Alfred, report — and I will.";
  const audio = await toArrayBuffer(await c.env.AI.run("@cf/deepgram/aura-2-en", { text }));
  const response = new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": 'inline; filename="alfred-report.mp3"',
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

app.get("/voice/briefing", async (c) => {
  const authorized = await authorizeBriefing(c);
  if (!authorized) return c.json({ error: "unauthorized" }, 401);

  const start = Date.now();
  const userId = c.req.query("user_id") || "hans";
  const missions = await listMissions(c.env, undefined);
  const active = missions.filter((m) => m.status === "active" || m.status === "pending");
  const completedToday = missions.filter((m) => m.status === "completed").slice(0, 3);
  const cost = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM cost_events WHERE created_at >= date('now')`
  ).first<{ cost: number }>();
  const lines = [
    "Good evening. This is Alfred with your operational briefing.",
    `There are ${active.length} open missions.`,
    active.slice(0, 5).map((m) => `${m.title}, status ${m.status}.`).join(" "),
    completedToday.length ? `Recently completed: ${completedToday.map((m) => m.title).join(", ")}.` : "No completed missions on the board.",
    `Spend today is ${(cost?.cost ?? 0).toFixed(4)} dollars.`,
    "End of briefing.",
  ].filter(Boolean).join(" ");

  const audio = await toArrayBuffer(await c.env.AI.run("@cf/deepgram/aura-2-en", { text: lines }));
  recordCop(c.env, {
    userId,
    missionId: "briefing",
    agent: "voice",
    provider: "workers-ai",
    model: "@cf/deepgram/aura-2-en",
    eventType: "tts",
    tokensOut: Math.ceil(lines.length / 4),
    durationMs: Date.now() - start,
  });
  await recordCostEvent(c.env, {
    missionId: null,
    userId,
    agent: "voice",
    provider: "workers-ai",
    model: "@cf/deepgram/aura-2-en",
    eventType: "tts",
    tokensOut: Math.ceil(lines.length / 4),
    durationMs: Date.now() - start,
  });
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="alfred-briefing.mp3"',
    },
  });
});

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