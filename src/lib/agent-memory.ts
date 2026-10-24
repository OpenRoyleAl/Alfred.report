/**
 * Cloudflare Agent Memory adapter: thin binding calls only. Policy (profile = tenant, store gate,
 * redaction, recall budget, cite-only-recalled ids, forget/remember validation) is in Rust
 * (src/alfred/core.ts -> crates/alfred-core/src/memory.rs).
 *
 * Kingdoms: one namespace per Cloudflare account (`alfred` on alfred.report), one profile per
 * tenant. The tenant always comes from the verified identity, never from the request.
 */
import { memoryOp, memoryProfile, memoryQuery, memoryShape, type MemoryShape } from "../alfred/core.ts";

export interface AMMemory { id: string; type: string; summary: string; content?: string; sessionId: string | null; createdAt: string | Date; updatedAt: string | Date }
export interface AMProfile {
  ingest(messages: Array<{ role: "system" | "user" | "assistant"; content: string; timestamp?: Date }>, opts?: { sessionId?: string | null }): Promise<void>;
  remember(m: { content: string; sessionId?: string | null }): Promise<AMMemory>;
  recall(q: string, o?: { thinkingLevel?: "low" | "medium" | "high"; responseLength?: "short" | "medium" | "long"; referenceDate?: Date | string }): Promise<{ count: number; answer: string; candidates: Array<{ id: string; summary: string; sessionId: string | null; score: number }> }>;
  list(o?: { limit?: number; cursor?: string; sessionId?: string; type?: string }): Promise<{ memories: AMMemory[]; cursor?: string }>;
  get(id: string): Promise<AMMemory>;
  delete(id: string): Promise<AMMemory>;
  deleteSession(sessionId: string): Promise<void>;
}
export interface AMNamespace {
  getProfile(name: string): Promise<AMProfile>;
}
export type MemoryEnv = { MEMORY?: AMNamespace };

export class MemoryUnavailable extends Error {
  constructor() {
    super("Agent Memory binding (MEMORY) is not configured");
  }
}

/** `archive` selects the kingdom's archive profile (imported Hermes history), kept out of mission recall. */
export async function kingdom(env: MemoryEnv, tenant: string, archive = false): Promise<AMProfile> {
  if (!env.MEMORY) throw new MemoryUnavailable();
  return env.MEMORY.getProfile(memoryProfile(tenant, archive));
}

export async function recallFor(env: MemoryEnv, tenant: string, text: string, budgetTokens?: number | null, referenceDate?: Date, archive = false, confidence?: Record<string, number>): Promise<MemoryShape & { count: number }> {
  const q = memoryQuery(text);
  const r = await (await kingdom(env, tenant, archive)).recall(q, { responseLength: "short", ...(referenceDate ? { referenceDate } : {}) });
  const shaped = memoryShape({ answer: r.answer || "", candidates: (r.candidates || []).map((c) => ({ id: c.id, summary: c.summary, score: c.score })), budget_tokens: budgetTokens ?? null, ...(confidence ? { confidence } : {}) });
  return { ...shaped, count: r.count };
}

export async function rememberFor(env: MemoryEnv, tenant: string, args: unknown): Promise<AMMemory> {
  const m = memoryOp<{ content: string; sessionId: string | null }>("remember", args);
  return (await kingdom(env, tenant)).remember(m);
}

export async function forgetFor(env: MemoryEnv, tenant: string, args: unknown): Promise<{ forgot: string; id?: string; sessionId?: string }> {
  const f = memoryOp<{ kind: "memory" | "session"; id?: string; sessionId?: string }>("forget", args);
  const p = await kingdom(env, tenant, (args as { archive?: unknown })?.archive === true);
  if (f.kind === "memory") {
    await p.delete(f.id!);
    return { forgot: "memory", id: f.id };
  }
  await p.deleteSession(f.sessionId!);
  return { forgot: "session", sessionId: f.sessionId };
}

export async function exportFor(env: MemoryEnv, tenant: string, args: { cursor?: unknown; limit?: unknown; sessionId?: unknown; archive?: unknown }): Promise<{ memories: AMMemory[]; cursor: string | null }> {
  const { limit } = memoryOp<{ limit: number }>("export", args);
  const p = await kingdom(env, tenant, args.archive === true);
  const page = await p.list({
    limit,
    ...(typeof args.cursor === "string" && args.cursor ? { cursor: args.cursor } : {}),
    ...(typeof args.sessionId === "string" && args.sessionId ? { sessionId: args.sessionId.slice(0, 64) } : {}),
  });
  const memories: AMMemory[] = [];
  for (const m of page.memories) memories.push(await p.get(m.id));
  return { memories, cursor: page.cursor ?? null };
}
