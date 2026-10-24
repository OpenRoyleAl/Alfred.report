/**
 * Web-side client for the durable mission engine in the Missions Worker (apps/missions
 * src/durable.ts), over the MISSIONS service binding with the ops bearer. The tenant always
 * comes from the verified caller, never from the request body.
 */
import { secretGet } from "./secret";
import type { Env } from "./env";

const ORIGIN = "https://missions.internal";

export interface DurableMission {
  id: string;
  tenant: string;
  objective: string;
  kind: string;
  source: string;
  status: string;
  answer: string | null;
  error: string | null;
  request_id: string;
  run_at: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  wakes: number;
  evidence?: string | null;
  verdict?: string | null;
  review?: Record<string, unknown> | null;
  interrupted?: number;
  tasks?: Array<Record<string, unknown>>;
}

export interface DurableCreateIn {
  objective: string;
  requestId?: string | null;
  /** Hashed into an auto requestId when the client sent none (voice/Siri retries). */
  fallback?: string[];
  source: "web" | "mcp" | "voice" | "siri" | "oral" | "debug";
  delaySeconds?: number | null;
  runAt?: number | null;
  debugStepDelayMs?: number;
  requireEvidence?: boolean;
  /** Owner debug only (the Alfred DO drops it for non-owners). */
  debugSearch?: "force-exa" | null;
  /** Verified caller is the default king (owner-only tools). Set by the Alfred DO, never by a client. */
  owner?: boolean;
}

async function call<T>(env: Env, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  if (!env.MISSIONS) throw new Error("MISSIONS binding missing");
  const url = new URL(ORIGIN + path);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const token = await secretGet(env.ALFRED_OPS_TOKEN as never);
  const r = await env.MISSIONS.fetch(
    new Request(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  );
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`durable ${path}: ${r.status} ${data?.error ?? ""}`.trim());
  return data;
}


export function durableCreate(env: Env, tenant: string, a: DurableCreateIn) {
  return call<{ missionId: string; requestId: string; duplicate: boolean; status: string; runAt: number }>(env, "/durable/missions", {
    method: "POST",
    body: { tenant, ...a },
  });
}

export async function durableGet(env: Env, tenant: string, id: string): Promise<DurableMission | null> {
  try {
    return await call<DurableMission>(env, `/durable/missions/${encodeURIComponent(id)}`, { query: { tenant } });
  } catch (err) {
    if (String((err as Error).message).includes(" 404")) return null;
    throw err;
  }
}

export async function durableList(env: Env, tenant: string, limit = 20): Promise<DurableMission[]> {
  return (await call<{ missions: DurableMission[] }>(env, "/durable/missions", { query: { tenant, limit: String(limit) } })).missions;
}

export function durableConsolidate(env: Env, tenant: string) {
  return call<{ week: string; status: string; id?: string; count?: number; content?: string; version?: string }>(env, "/durable/consolidate", { method: "POST", body: { tenant, force: true } });
}
export function durableMemoryHealth(env: Env, tenant: string) {
  return call<{ confidence: Array<Record<string, unknown>>; weekly: Record<string, string> }>(env, "/durable/memory-health", { query: { tenant } });
}

export function durableHistory(env: Env, tenant: string, query: string, requestId?: string | null) {
  return call<DurableMission & { used: string[] }>(env, "/durable/history", { method: "POST", body: { tenant, query, requestId: requestId ?? null } });
}

/** Front door: one durable mission run inline (web chat, ORAL, MCP ask). */
export function durableAsk(env: Env, tenant: string, a: DurableCreateIn) {
  return call<DurableMission>(env, "/durable/ask", { method: "POST", body: { tenant, ...a } });
}

/** One-time move of retired Pi missions into the durable engine (idempotent by id). */
export function durableImportLegacy(env: Env, tenant: string, missions: unknown[], lessons: unknown[]) {
  return call<{ imported: number; skipped: number; lessons: number }>(env, "/durable/import-legacy", { method: "POST", body: { tenant, missions, lessons } });
}

export function durableForgetLesson(env: Env, tenant: string, missionId: string) {
  return call<{ deleted: number }>(env, `/durable/lessons/${encodeURIComponent(missionId)}`, { method: "DELETE", query: { tenant } });
}

export async function durableLessons(env: Env, tenant: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return (await call<{ lessons: Array<Record<string, unknown>> }>(env, "/durable/lessons", { query: { tenant, limit: String(limit) } })).lessons;
}

export function durableStats(env: Env, tenant: string) {
  return call<Record<string, unknown>>(env, "/durable/stats", { query: { tenant } });
}

export function durableDebugAbort(env: Env, tenant: string) {
  return call<{ aborted: boolean }>(env, "/durable/debug/abort", { method: "POST", body: { tenant } });
}

/**
 * Report row shape (src/alfred/report.ts MissionRow) for a durable mission. The Rust review
 * verdict + flags decide the outcome (an interrupted step makes it "partial", not success).
 */
export function durableReportRow(m: DurableMission) {
  const finished = m.status === "done" || m.status === "failed";
  return {
    id: m.id,
    objective: m.objective,
    status: m.status === "done" ? "done" : m.status === "failed" ? "error" : "running",
    // Until the review lands the mission still reads as running (never success by default).
    verdict: finished && m.verdict ? m.verdict : null,
    started_at: m.started_at ?? m.created_at,
    finished_at: finished && m.verdict ? m.finished_at : null,
    review: (m.review as never) ?? null,
  };
}
