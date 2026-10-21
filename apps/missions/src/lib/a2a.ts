/**
 * Alfred.report A2A surface - peer drop / claim on Missions.
 * Auth: Bearer A2A_BEARER_TOKEN. Wake the owner via the OWNER_WAKE_URL webhook (OWNER_WAKE_AUTH bearer).
 */

import { BRAND, FIELD_AGENTS, WORKERS, normalizeFieldAgent } from "../../../../src/brand";
import type { D1Database } from "@cloudflare/workers-types";
import * as missions from "./missions";
import type { Mission, MissionGateResult } from "../types";
import type { MissionBudget } from "./llm";
import { defaultMissionBudget } from "./llm";
import { generateId } from "./db";

export interface A2AEnv {
  DB: D1Database;
  A2A_BEARER_TOKEN?: string;
  OWNER_WAKE_URL?: string;
  OWNER_WAKE_AUTH?: string;
}

export function a2aUnauthorized(): Response {
  return Response.json({ error: "unauthorized", scheme: "Bearer" }, { status: 401 });
}

/** Constant-time-ish bearer check. Missing secret → fail closed (401). */
export function requireA2AAuth(req: Request, env: A2AEnv): Response | null {
  const expected = env.A2A_BEARER_TOKEN;
  if (!expected) return a2aUnauthorized();
  const header = req.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return a2aUnauthorized();
  const token = header.slice(prefix.length).trim();
  if (!token || token.length !== expected.length) return a2aUnauthorized();
  let ok = 0;
  for (let i = 0; i < token.length; i++) ok |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (ok !== 0) return a2aUnauthorized();
  return null;
}

export function a2aHealth(env: A2AEnv): Response {
  return Response.json({
    ok: true,
    service: WORKERS.missions,
    surface: "a2a",
    brand: BRAND.platformBrand,
    auth: "Bearer",
    routes: ["/a2a/health", "/a2a/message", "/a2a/drop", "/a2a/next", "/a2a/report"],
    wake_configured: Boolean(env.OWNER_WAKE_URL && env.OWNER_WAKE_AUTH),
    ts: Date.now(),
  });
}

export interface A2ADropBody {
  objective?: string;
  message?: string;
  text?: string;
  kind?: "mission" | "message";
  acceptance?: string[];
  budget?: MissionBudget | null;
  from?: string;
  peer?: string;
  wake_owner?: boolean;
  needs_owner?: boolean;
  state?: "drafted" | "active";
  metadata?: Record<string, unknown>;
  field_agent?: string;
}

/** Peer drop → mission (default) or inbox queue. */
export async function a2aDrop(env: A2AEnv, body: A2ADropBody): Promise<Response> {
  const text =
    (typeof body.objective === "string" && body.objective.trim()) ||
    (typeof body.message === "string" && body.message.trim()) ||
    (typeof body.text === "string" && body.text.trim()) ||
    "";
  if (!text) {
    return Response.json({ error: "objective|message|text required" }, { status: 400 });
  }

  const kind = body.kind === "message" ? "message" : "mission";
  const peer = body.from || body.peer || "peer";

  if (kind === "message") {
    const id = generateId("a2a");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO inbox (id, source, raw_content, metadata, received_at, processed)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
      .bind(
        id,
        `a2a:${peer}`,
        text,
        JSON.stringify({ ...(body.metadata || {}), peer, via: "a2a/drop" }),
        now
      )
      .run();

    if (body.wake_owner || body.needs_owner) {
      await ownerWake(env, {
        reason: "a2a_message_needs_owner",
        inbox_id: id,
        peer,
        preview: text.slice(0, 240),
      });
    }

    return Response.json(
      { ok: true, kind: "message", inbox_id: id, peer, wake: Boolean(body.wake_owner || body.needs_owner) },
      { status: 201 }
    );
  }

  const field_agent =
    (typeof body.field_agent === "string" && body.field_agent.trim()) ||
    ((FIELD_AGENTS as readonly string[]).includes(normalizeFieldAgent(peer))
      ? normalizeFieldAgent(peer)
      : "cursor");
  const mission = await missions.createMission(env.DB, {
    objective: text,
    budget: body.budget ?? defaultMissionBudget({ field_agent }),
    acceptance: body.acceptance ?? [],
    state: body.state === "active" ? "active" : "drafted",
    field_agent,
  });

  // Tag peer on first evidence; keep drafted unless explicit body.state===active
  const keepDrafted = body.state !== "active";
  const gated = await missions.gateMission(env.DB, mission.id, {
    passed: true,
    check: "a2a_drop_accepted",
    notes: `from=${peer}`,
    actor: `a2a:${peer}`,
    promote: keepDrafted ? false : true,
  });
  const outState = gated?.state ?? (keepDrafted ? "drafted" : "active");

  if (body.wake_owner || body.needs_owner) {
    await ownerWake(env, {
      reason: "a2a_mission_needs_owner",
      mission_id: mission.id,
      peer,
      objective: text.slice(0, 240),
    });
  }

  return Response.json(
    {
      ok: true,
      kind: "mission",
      mission_id: mission.id,
      state: outState,
      peer,
      wake: Boolean(body.wake_owner || body.needs_owner),
    },
    { status: 201 }
  );
}

/** Peers claim next drafted mission. Prefer budget.field_agent match, else FIFO. */
export async function a2aNext(env: A2AEnv, peer?: string): Promise<Response> {
  const p = (peer || "").trim().toLowerCase();
  let row: { id: string } | null = null;
  if (p) {
    row =
      (await env.DB.prepare(
        `SELECT id FROM missions
         WHERE state = 'drafted'
           AND json_extract(budget, '$.field_agent') = ?
         ORDER BY created_at ASC LIMIT 1`
      )
        .bind(p)
        .first<{ id: string }>()) || null;
  }
  if (!row) {
    row =
      (await env.DB.prepare(
        `SELECT id FROM missions WHERE state = 'drafted' ORDER BY created_at ASC LIMIT 1`
      ).first<{ id: string }>()) || null;
  }

  if (!row) {
    return Response.json({ ok: true, mission: null, claimed: false, peer: p || null });
  }

  const updated = await missions.gateMission(env.DB, row.id, {
    passed: true,
    check: "a2a_claimed",
    notes: p ? `claimed_by=${p}` : "claimed",
    actor: p ? `a2a:${p}` : "a2a:next",
  });

  return Response.json({
    ok: true,
    claimed: true,
    peer: p || null,
    mission: updated,
  });
}

/** Field peer posts progress / close-out directly (no the owner relay). */
export async function a2aReport(
  env: A2AEnv,
  body: {
    mission_id?: string;
    peer?: string;
    notes?: string;
    report?: string;
    complete?: boolean;
    failed?: boolean;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      neurons_est?: number;
      spend_usd?: number;
      model?: string;
    };
  }
): Promise<Response> {
  const id = (body.mission_id || "").trim();
  if (!id) return Response.json({ error: "mission_id required" }, { status: 400 });
  const peer = (body.peer || "peer").trim().toLowerCase();
  const mission = await missions.getMission(env.DB, id);
  if (!mission) return Response.json({ error: "mission not found" }, { status: 404 });

  if (body.usage) {
    const u = body.usage;
    const prompt = Number(u.prompt_tokens || 0) || 0;
    const completion = Number(u.completion_tokens || 0) || 0;
    const total = Number(u.total_tokens || 0) || prompt + completion;
    await missions.recordMissionUsage(
      env.DB,
      id,
      {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
        neurons_est: Number(u.neurons_est || 0) || 0,
      },
      Number(u.spend_usd || 0) || 0,
      u.model || `a2a:${peer}`
    );
  }

  const notes = (body.notes || body.report || "field progress").slice(0, 4000);
  const passed = !body.failed;

  if (!body.complete) {
    const updated = await missions.gateMission(env.DB, id, {
      passed,
      check: passed ? "a2a_field_progress" : "a2a_field_failed",
      notes,
      actor: `a2a:${peer}`,
      promote: false,
    });
    return Response.json({ ok: true, peer, mission: updated });
  }

  const updated = await missions.gateMission(env.DB, id, {
    passed,
    check: passed ? "complete" : "a2a_field_failed",
    notes,
    actor: `a2a:${peer}`,
    primary_worker: "builder",
    independent_gate: true,
    complete: passed,
    promote: true,
    report: body.report || notes,
    fail: !passed,
  });

  return Response.json({ ok: true, peer, mission: updated });
}

export interface OwnerWakePayload {
  reason: string;
  mission_id?: string;
  inbox_id?: string;
  peer?: string;
  objective?: string;
  preview?: string;
  state?: string;
  report?: string | null;
}

/**
 * POST an owner wake to OWNER_WAKE_URL (any webhook the owner chooses).
 * Stub-safe: if secrets missing, return {skipped:true} — never throw to peers.
 */
export async function ownerWake(
  env: A2AEnv,
  payload: OwnerWakePayload
): Promise<{ ok: boolean; skipped?: boolean; status?: number; detail?: string }> {
  const url = env.OWNER_WAKE_URL;
  const auth = env.OWNER_WAKE_AUTH;
  if (!url || !auth) {
    return { ok: false, skipped: true, detail: "OWNER_WAKE_URL/OWNER_WAKE_AUTH not set" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth}`,
      },
      body: JSON.stringify({
        source: WORKERS.missions,
        brand: BRAND.platformBrand,
        event: "owner_wake",
        ...payload,
        ts: Date.now(),
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** After mission gate → wake when complete or explicit needs_owner. */
export async function maybeWakeAfterGate(
  env: A2AEnv,
  mission: Mission,
  gate: MissionGateResult
): Promise<void> {
  const needsOwner = Boolean(
    gate.complete ||
      mission.state === "complete" ||
      (gate as { needs_owner?: boolean }).needs_owner ||
      gate.check === "needs_owner"
  );
  if (!needsOwner && mission.state !== "complete") return;

  await ownerWake(env, {
    reason: mission.state === "complete" || gate.complete ? "mission_complete" : "needs_owner",
    mission_id: mission.id,
    state: mission.state,
    objective: mission.objective.slice(0, 240),
    report: mission.report,
  });
}
