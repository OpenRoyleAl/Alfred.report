/// <reference path="../../../src/wasm.d.ts" />
import coreWasm from "../../../src/alfred/wasm/alfred_core.wasm";
import { initCore } from "../../../src/alfred/core.ts";
import { primeSecrets } from "./lib/secrets";
import { BriefingWorkflow } from "./workflows/briefing";
import { MaintenanceWorkflow } from "./workflows/maintenance";
import type { Env as WorkerEnv } from "./workers/curator";
import * as missions from "./lib/missions";
import * as llm from "./lib/llm";
import { BRAND, FIELD_AGENTS, WORKERS, normalizeFieldAgent } from "../../../src/brand";
import type { MissionGateResult } from "./types";
import type { MissionBudget, LlmRole } from "./lib/llm";
import * as a2a from "./lib/a2a";
import * as cfChangelog from "./lib/cf-changelog";
import * as memory from "./lib/memory";
import * as emailIngest from "./lib/email-ingest";

// Do not remove: a missing initCore was a Worker 1101 twice.
initCore(coreWasm);

// ─── Extended Env for Worker entry ─────────────────────────────

export interface Env extends WorkerEnv {
  MISSIONS_AGENT: DurableObjectNamespace;
  BRIEFING_WORKFLOW: Workflow;
  MAINTENANCE_WORKFLOW: Workflow;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  CLOUDFLARE_GATEWAY_ID?: string;
  AUTO_ALLOWED_MODELS?: string;
  AUTO_ALLOWED_PROVIDERS?: string;
  WORKERS_AI_FLOOR?: string;
  ALFRED_OPS_TOKEN?: string;
  A2A_BEARER_TOKEN?: string;
  OWNER_WAKE_URL?: string;
  OWNER_WAKE_AUTH?: string;
  MEMORY?: memory.AgentMemoryNamespace;
  /** "1" = refuse POST /missions (and email-ingest creates) until metering loop closed. */
  HOLD_NEW_MISSIONS?: string;
}

// ─── Worker exports (see cloudflare.config.ts) ──────────────────────────────────────

export { AlfredMissions } from "./orchestrator";
export { AlfredCommand } from "./legacy";
export { BriefingWorkflow } from "./workflows/briefing";
export { MaintenanceWorkflow } from "./workflows/maintenance";
export { Curator, Janitor, Distiller, Farmer, Builder } from "./workers";


function opsUnauthorized(): Response {
  return Response.json({ error: "unauthorized", scheme: "Bearer" }, { status: 401 });
}

/** Ops Bearer ALFRED_OPS_TOKEN — fail closed if secret missing. */
function requireOpsAuth(req: Request, env: Env): Response | null {
  const expected = env.ALFRED_OPS_TOKEN;
  if (!expected) return opsUnauthorized();
  const header = req.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return opsUnauthorized();
  const token = header.slice(prefix.length).trim();
  if (!token || token.length !== expected.length) return opsUnauthorized();
  let ok = 0;
  for (let i = 0; i < token.length; i++) ok |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (ok !== 0) return opsUnauthorized();
  return null;
}

/** HOLD_NEW_MISSIONS=1 blocks new missions until metering loop holds (ops override header). */
function newMissionsHeld(env: Env): boolean {
  const v = (env.HOLD_NEW_MISSIONS || "").trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on";
}

function meteringBootstrapOverride(req: Request): boolean {
  return (req.headers.get("X-Alfred-Override") || "").trim() === "metering-bootstrap";
}

function holdNewMissionsResponse(): Response {
  return Response.json(
    {
      error: "metering_hold",
      message:
        "HOLD_NEW_MISSIONS: close the Missions metering loop first (every mission meters LLM usage; complete refuses unmetered). Override: X-Alfred-Override: metering-bootstrap with ops auth.",
      hold: true,
    },
    { status: 423 }
  );
}


// ─── Main Entry ────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await primeSecrets(env);
    const url = new URL(req.url);

    // ─── API Routes ────────────────────────────────────────────

    if (url.pathname === "/" || url.pathname === "/chat") {
      if (req.headers.get("upgrade") === "websocket") {
        const id = env.MISSIONS_AGENT.idFromName("default");
        const stub = env.MISSIONS_AGENT.get(id);
        return stub.fetch(req);
      }
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request("https://dummy/assets/index.html", req));
      }
      return Response.json({ service: WORKERS.missions, hint: "use /health or /missions or /llm/ping" });
    }

    if (url.pathname === "/api/inbox" && req.method === "POST") {
      const body = await req.json() as { source: string; content: string; metadata?: Record<string, unknown> };
      const id = env.MISSIONS_AGENT.idFromName("default");
      const stub = env.MISSIONS_AGENT.get(id);
      const resp = await stub.fetch(new Request("https://internal/inbox", {
        method: "POST",
        body: JSON.stringify(body),
      }));
      return resp;
    }

    if (url.pathname === "/api/briefing" && req.method === "POST") {
      const instance = await env.BRIEFING_WORKFLOW.create({
        params: { date: new Date().toISOString().split("T")[0] },
      });
      return Response.json({ workflow_id: instance.id, status: "started" });
    }

    if (url.pathname === "/api/maintenance" && req.method === "POST") {
      const instance = await env.MAINTENANCE_WORKFLOW.create({
        params: { date: new Date().toISOString().split("T")[0] },
      });
      return Response.json({ workflow_id: instance.id, status: "started" });
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const id = env.MISSIONS_AGENT.idFromName("default");
      const stub = env.MISSIONS_AGENT.get(id);
      const resp = await stub.fetch(new Request("https://internal/stats"));
      return resp;
    }

    if (url.pathname.startsWith("/api/workflow/") && req.method === "GET") {
      const workflowId = url.pathname.split("/")[3];
      const type = url.searchParams.get("type") || "briefing";
      const workflow = type === "maintenance" ? env.MAINTENANCE_WORKFLOW : env.BRIEFING_WORKFLOW;
      const instance = await workflow.get(workflowId);
      const status = await instance.status();
      return Response.json({ id: workflowId, status });
    }

    // ─── Health ────────────────────────────────────────────────

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        ok: true,
        service: WORKERS.missions,
        brand: BRAND.platformBrand,
        field_agents: FIELD_AGENTS,
        llm: llm.routingTable(env),
        metering: {
          hold_new_missions: newMissionsHeld(env),
          law: "every mission-scoped LLM path must recordMissionUsage; unmetered complete refused without spend_attestation",
        },
        ts: Date.now(),
      });
    }

    // ─── LLM routes ────────────────────────────────────────────

    if (url.pathname === "/llm/health" && req.method === "GET") {
      const probe = await llm.healthProbe(env);
      return Response.json({
        ...probe,
        routing: llm.routingTable(env),
      });
    }

    if (url.pathname === "/llm/ping" && req.method === "POST") {
      const deniedPing = requireOpsAuth(req, env);
      if (deniedPing) return deniedPing;
      let body: {
        role?: LlmRole;
        mission_id?: string;
        prompt?: string;
      } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        body = {};
      }

      const role: LlmRole =
        body.role === "simple" ||
        body.role === "vision" ||
        body.role === "image" ||
        body.role === "tts" ||
        body.role === "embed" ||
        body.role === "speech"
          ? body.role
          : "smart";
      let budget: MissionBudget | null = null;
      let missionId = body.mission_id;

      if (missionId) {
        const mission = await missions.getMission(env.DB, missionId);
        if (!mission) return Response.json({ error: "mission not found" }, { status: 404 });
        try {
          missions.refuseIfOverBudget(mission);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return Response.json({ error: "budget_exceeded", detail: msg, mission_id: missionId }, { status: 402 });
        }
        budget = (mission.budget as MissionBudget) ?? llm.defaultMissionBudget();
      }

      try {
        const result = await llm.chat(
          env,
          [
            { role: "system", content: "You are the Alfred.report Missions health ping. Reply in one short sentence." },
            { role: "user", content: body.prompt || `Ping role=${role}. Say hello from Alfred.report Missions.` },
          ],
          {
            role,
            max_tokens: 64,
            budget,
            mission_id: missionId,
          }
        );

        if (missionId) {
          await missions.recordMissionUsage(env.DB, missionId, result.usage, 0, result.model);
        }

        return Response.json({
          ok: true,
          role,
          provider: result.provider,
          model: result.model,
          cost_class: result.cost_class,
          usage: result.usage,
          reply: result.content,
          mission_id: missionId ?? null,
        });
      } catch (e) {
        const code = (e as any)?.code;
        const status = code === "BUDGET_EXCEEDED" ? 402 : code === "PROVIDER_BROKEN" ? 503 : 500;
        return Response.json(
          {
            ok: false,
            error: code || "llm_error",
            detail: e instanceof Error ? e.message : String(e),
          },
          { status }
        );
      }
    }


    // ─── A2A peer surface ────────────────────────────────
    if (url.pathname === "/a2a/health" && req.method === "GET") {
      return a2a.a2aHealth(env);
    }

    if (
      (url.pathname === "/a2a/message" || url.pathname === "/a2a/drop") &&
      req.method === "POST"
    ) {
      const denied = a2a.requireA2AAuth(req, env);
      if (denied) return denied;
      let body: a2a.A2ADropBody = {};
      try {
        body = (await req.json()) as a2a.A2ADropBody;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      return a2a.a2aDrop(env, body);
    }

    if (url.pathname === "/a2a/next" && req.method === "GET") {
      const denied = a2a.requireA2AAuth(req, env);
      if (denied) return denied;
      const peer = url.searchParams.get("peer") || undefined;
      return a2a.a2aNext(env, peer);
    }

    if (url.pathname === "/a2a/report" && req.method === "POST") {
      const denied = a2a.requireA2AAuth(req, env);
      if (denied) return denied;
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      return a2a.a2aReport(env, body as any);
    }



    // ─── Ops: Cloudflare Agent Memory (Day2 / §08) ──────────────
    if (url.pathname === "/ops/memory/health" && req.method === "GET") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      const health = await memory.memoryHealth(env);
      return Response.json(health, { status: health.ok ? 200 : 503 });
    }

    if (url.pathname === "/ops/memory/remember" && req.method === "POST") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      let body: { content?: string; sessionId?: string | null } = {};
      try {
        body = (await req.json()) as { content?: string; sessionId?: string | null };
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      if (!body?.content || typeof body.content !== "string") {
        return Response.json({ error: "content required" }, { status: 400 });
      }
      try {
        const stored = await memory.rememberFact(env, body.content, body.sessionId ?? null);
        return Response.json({ ok: true, provider: "cloudflare-agent-memory", memory: stored }, { status: 201 });
      } catch (e) {
        const status = e instanceof memory.MemoryUnavailableError ? 503 : 500;
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status });
      }
    }

    if (url.pathname === "/ops/memory/recall" && req.method === "POST") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      let body: {
        query?: string;
        thinkingLevel?: "low" | "medium" | "high";
        responseLength?: "short" | "medium" | "long";
      } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      if (!body?.query || typeof body.query !== "string") {
        return Response.json({ error: "query required" }, { status: 400 });
      }
      try {
        const result = await memory.recallFacts(env, body.query, {
          thinkingLevel: body.thinkingLevel,
          responseLength: body.responseLength,
        });
        return Response.json({ ok: true, provider: "cloudflare-agent-memory", result });
      } catch (e) {
        const status = e instanceof memory.MemoryUnavailableError ? 503 : 500;
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status });
      }
    }

    if (url.pathname === "/ops/memory/list" && req.method === "GET") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") || "20");
      const sessionId = url.searchParams.get("sessionId") || undefined;
      try {
        const result = await memory.listFacts(env, { limit, sessionId });
        return Response.json({ ok: true, provider: "cloudflare-agent-memory", ...result });
      } catch (e) {
        const status = e instanceof memory.MemoryUnavailableError ? 503 : 500;
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status });
      }
    }


    // ─── Ops: forwarded email → Mission ingest ────────────────────
    if (url.pathname === "/ops/email-ingest" && req.method === "GET") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      const gmailId = (url.searchParams.get("gmail_message_id") || "").trim();
      if (!gmailId) {
        return Response.json({ error: "gmail_message_id required" }, { status: 400 });
      }
      const row = await emailIngest.getIngestByGmailId(env.DB, gmailId);
      if (!row) return Response.json({ ok: true, ingested: false });
      const mission = await missions.getMission(env.DB, row.mission_id);
      return Response.json({ ok: true, ingested: true, row, mission });
    }

    if (url.pathname === "/ops/email-ingest" && req.method === "POST") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      let body: emailIngest.EmailIngestRequest;
      try {
        body = (await req.json()) as emailIngest.EmailIngestRequest;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      try {
        const envWithOverride = {
          ...env,
          METERING_BOOTSTRAP_OVERRIDE: meteringBootstrapOverride(req),
        };
        const result = await emailIngest.ingestEmailMission(envWithOverride, body);
        return Response.json(result, { status: result.deduped ? 200 : 201 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        let status = 500;
        if (/required/i.test(msg)) status = 400;
        if (/metering_hold/i.test(msg)) status = 423;
        return Response.json({ ok: false, error: msg }, { status });
      }
    }

    // ─── Ops: CF changelog watch (manual) ───────────────────────
    if (url.pathname === "/ops/cf-changelog" && req.method === "POST") {
      const denied = requireOpsAuth(req, env);
      if (denied) return denied;
      const result = await cfChangelog.runCfChangelogWatch(env);
      return Response.json(result);
    }

    // ─── Mission Kernel Routes ─────────────────────────────────

    if (url.pathname === "/missions" && req.method === "GET") {
      const deniedList = requireOpsAuth(req, env);
      if (deniedList) return deniedList;
      const stateParam = url.searchParams.get("state");
      const limitParam = url.searchParams.get("limit");
      const allowed = new Set(["drafted", "active", "gated", "complete", "failed", "aborted"]);
      const state = stateParam && allowed.has(stateParam)
        ? (stateParam as "drafted" | "active" | "gated" | "complete" | "failed" | "aborted")
        : undefined;
      const limit = limitParam ? Number(limitParam) : undefined;
      const list = await missions.listMissions(env.DB, {
        state,
        limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
      });
      return Response.json({ missions: list });
    }

    if (url.pathname === "/missions" && req.method === "POST") {
      const deniedM = requireOpsAuth(req, env);
      if (deniedM) return deniedM;
      if (newMissionsHeld(env) && !meteringBootstrapOverride(req)) {
        return holdNewMissionsResponse();
      }
      const body = await req.json() as {
        objective: string;
        budget?: MissionBudget | null;
        acceptance?: string[];
        state?: "drafted" | "active" | "gated" | "complete" | "failed" | "aborted";
        field_agent?: string;
      };
      if (!body?.objective || typeof body.objective !== "string") {
        return Response.json({ error: "objective required" }, { status: 400 });
      }
      const ALLOWED_AGENTS = new Set<string>(FIELD_AGENTS);
      const field_agent =
        typeof body.field_agent === "string" && ALLOWED_AGENTS.has(body.field_agent.trim().toLowerCase())
          ? body.field_agent.trim().toLowerCase()
          : "cursor";
      const mission = await missions.createMission(env.DB, {
        objective: body.objective,
        budget: body.budget ?? llm.defaultMissionBudget({ field_agent }),
        acceptance: body.acceptance ?? [],
        state: body.state,
        field_agent,
      });
      return Response.json(mission, { status: 201 });
    }

    // Mission LLM under budget
    const missionLlmMatch = url.pathname.match(/^\/missions\/([^/]+)\/llm$/);
    if (missionLlmMatch && req.method === "POST") {
      const deniedLlm = requireOpsAuth(req, env);
      if (deniedLlm) return deniedLlm;
      const missionId = decodeURIComponent(missionLlmMatch[1]);
      const mission = await missions.getMission(env.DB, missionId);
      if (!mission) return Response.json({ error: "mission not found" }, { status: 404 });
      try {
        missions.refuseIfOverBudget(mission);
      } catch (e) {
        return Response.json(
          { error: "budget_exceeded", detail: e instanceof Error ? e.message : String(e) },
          { status: 402 }
        );
      }
      const body = await req.json() as { prompt: string; role?: LlmRole };
      if (!body?.prompt) return Response.json({ error: "prompt required" }, { status: 400 });
      try {
        const result = await llm.chat(
          env,
          [{ role: "user", content: body.prompt }],
          {
            role: body.role ?? "smart",
            budget: (mission.budget as MissionBudget) ?? llm.defaultMissionBudget(),
            mission_id: missionId,
          }
        );
        const updated = await missions.recordMissionUsage(env.DB, missionId, result.usage, 0, result.model);
        return Response.json({ ok: true, result, mission: updated });
      } catch (e) {
        const code = (e as any)?.code;
        const status = code === "BUDGET_EXCEEDED" ? 402 : code === "PROVIDER_BROKEN" ? 503 : 500;
        return Response.json({ ok: false, error: code || "llm_error", detail: e instanceof Error ? e.message : String(e) }, { status });
      }
    }

    // POST /missions/:id/act — Needs-you quick picks
    const actMatch = url.pathname.match(/^\/missions\/([^/]+)\/act$/);
    if (actMatch && req.method === "POST") {
      const deniedA = requireOpsAuth(req, env);
      if (deniedA) return deniedA;
      const missionId = decodeURIComponent(actMatch[1]);
      let body: { action?: string; note?: string; actor?: string } = {};
      try { body = (await req.json()) as typeof body; } catch { body = {}; }
      const action = (body.action || "").trim().toLowerCase();
      const actor = body.actor || "owner";
      const note = (body.note || "").trim();
      if (action === "go_max") {
        const updated = await missions.goMaxMission(env.DB, missionId, {
          reason: note || "Go Max Al! quick pick",
          actor,
        });
        if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
        return Response.json({ ok: true, action, mission: updated });
      }
      if (action === "keep_going") {
        const updated = await missions.gateMission(env.DB, missionId, {
          passed: true,
          check: "needs_owner",
          notes: note || "the owner: keep going — Needs-you cleared",
          actor,
          promote: true,
        });
        if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
        return Response.json({ ok: true, action, mission: updated });
      }
      if (action === "note" || action === "voice") {
        const updated = await missions.gateMission(env.DB, missionId, {
          passed: true,
          check: action === "voice" ? "voice_note" : "owner_note",
          notes: note || "(empty note)",
          actor,
          promote: false,
        });
        if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
        return Response.json({ ok: true, action, mission: updated });
      }
      if (action === "done") {
        const existing = await missions.getMission(env.DB, missionId);
        if (!existing) return Response.json({ error: "mission not found" }, { status: 404 });
        if (existing.state === "drafted" || existing.state === "gated") {
          await missions.gateMission(env.DB, missionId, {
            passed: true,
            check: "owner_resume",
            notes: "promote for done",
            actor,
            promote: true,
          });
        }
        const updated = await missions.gateMission(env.DB, missionId, {
          passed: true,
          check: "complete",
          notes: note || "the owner marked done (Needs-you quick)",
          actor,
          primary_worker: "builder",
          independent_gate: true,
          complete: true,
          promote: true,
          report: note || "Done via Needs-you quick pick",
          spend_attestation: {
            class: "zero_compute",
            reason: "the owner closed from Needs-you board (no extra compute)",
          },
        });
        return Response.json({ ok: true, action, mission: updated });
      }
      return Response.json({ error: "action must be go_max|keep_going|done|note|voice" }, { status: 400 });
    }

    // POST /missions/:id/go-max — KISS: park→Cursor + temp full-power burst
    const goMaxMatch = url.pathname.match(/^\/missions\/([^/]+)\/go-max$/);
    if (goMaxMatch && req.method === "POST") {
      const deniedG = requireOpsAuth(req, env);
      if (deniedG) return deniedG;
      const missionId = decodeURIComponent(goMaxMatch[1]);
      let body: { reason?: string; actor?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        body = {};
      }
      const updated = await missions.goMaxMission(env.DB, missionId, {
        reason: body.reason,
        actor: body.actor || "owner",
      });
      if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
      return Response.json({ ok: true, go_max: true, mission: updated });
    }

    // POST /missions/:id/usage - record tokens/neurons/usd from runners / field agents
    const missionUsageMatch = url.pathname.match(/^\/missions\/([^/]+)\/usage$/);
    if (missionUsageMatch && req.method === "POST") {
      const deniedU = requireOpsAuth(req, env);
      if (deniedU) return deniedU;
      const missionId = decodeURIComponent(missionUsageMatch[1]);
      let body: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        neurons_est?: number;
        spend_usd?: number;
        model?: string;
      } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const prompt_tokens = Number(body.prompt_tokens ?? 0) || 0;
      const completion_tokens = Number(body.completion_tokens ?? 0) || 0;
      let total_tokens = Number(body.total_tokens ?? 0) || 0;
      if (total_tokens <= 0) total_tokens = prompt_tokens + completion_tokens;
      const neurons_est = Number(body.neurons_est ?? 0) || 0;
      const spend_usd = Number(body.spend_usd ?? 0) || 0;
      if (total_tokens <= 0 && neurons_est <= 0 && spend_usd <= 0) {
        return Response.json(
          { error: "usage_required", message: "provide total_tokens, neurons_est, or spend_usd > 0" },
          { status: 400 }
        );
      }
      const updated = await missions.recordMissionUsage(
        env.DB,
        missionId,
        { prompt_tokens, completion_tokens, total_tokens, neurons_est },
        spend_usd,
        body.model
      );
      if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
      return Response.json({ ok: true, mission: updated });
    }

    // POST /missions/:id/budget - set/attest budget fields (backfill + ops)
    const missionBudgetMatch = url.pathname.match(/^\/missions\/([^/]+)\/budget$/);
    if (missionBudgetMatch && req.method === "POST") {
      const deniedB = requireOpsAuth(req, env);
      if (deniedB) return deniedB;
      const missionId = decodeURIComponent(missionBudgetMatch[1]);
      let body: {
        budget?: MissionBudget;
        legacy_attest?: boolean;
        spend_note?: string;
      } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      if (body.legacy_attest) {
        const updated = await missions.applyLegacyAttestation(
          env.DB,
          missionId,
          body.spend_note || "pre-metering; historical inference not attributed"
        );
        if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
        return Response.json({ ok: true, mission: updated });
      }
      if (!body.budget || typeof body.budget !== "object") {
        return Response.json({ error: "budget object or legacy_attest required" }, { status: 400 });
      }
      const updated = await missions.updateMissionBudget(env.DB, missionId, body.budget);
      if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
      return Response.json({ ok: true, mission: updated });
    }

    const missionMatch = url.pathname.match(/^\/missions\/([^/]+)(\/gate)?$/);

    if (missionMatch) {
      const missionId = decodeURIComponent(missionMatch[1]);
      const isGate = Boolean(missionMatch[2]);

      if (isGate && req.method === "POST") {
        const deniedG = requireOpsAuth(req, env);
        if (deniedG) return deniedG;
        const body = await req.json() as MissionGateResult;
        if (typeof body?.passed !== "boolean" || !body?.check) {
          return Response.json({ error: "passed (boolean) and check (string) required" }, { status: 400 });
        }
        try {
          const updated = await missions.gateMission(env.DB, missionId, body);
          if (!updated) return Response.json({ error: "mission not found" }, { status: 404 });
          await a2a.maybeWakeAfterGate(env, updated, body);
          return Response.json(updated);
        } catch (e) {
          if (e instanceof missions.MeteringGateError) {
            return Response.json(
              { error: e.code, message: e.message, metering: true },
              { status: e.status }
            );
          }
          throw e;
        }
      }

      if (!isGate && req.method === "GET") {
        const deniedGet = requireOpsAuth(req, env);
        if (deniedGet) return deniedGet;
        const mission = await missions.getMission(env.DB, missionId);
        if (!mission) return Response.json({ error: "mission not found" }, { status: 404 });
        return Response.json(mission);
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await primeSecrets(env);
    const cron = event.cron;
    const date = new Date().toISOString().split("T")[0];

    if (cron === "0 8 * * *") {
      await env.BRIEFING_WORKFLOW.create({ params: { date } });
    }

    if (cron === "0 2 * * *") {
      await env.MAINTENANCE_WORKFLOW.create({ params: { date } });
    }

    // CF changelog/blog watch — every 6h at :15
    if (cron === "15 */6 * * *") {
      ctx.waitUntil(cfChangelog.runCfChangelogWatch(env).then(() => undefined));
    }
  },
} satisfies ExportedHandler<Env>;
