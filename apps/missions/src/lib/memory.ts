/**
 * Cloudflare Agent Memory helpers (Workers API binding).
 * The namespace is bound per account (config AGENT_MEMORY_NAMESPACE, default from
 * src/brand.ts RESOURCES.memoryNamespace); the owner's facts live under MEMORY_PROFILE.
 */

export const MEMORY_PROFILE = "owner";

/** Minimal typing for the Agent Memory Workers binding (private beta). */
export interface AgentMemoryNamespace {
  getProfile(profileName: string): Promise<AgentMemoryProfile>;
  deleteProfile(profileName: string): Promise<void>;
}

export interface AgentMemoryProfile {
  remember(memory: { content: string; sessionId?: string | null }): Promise<AgentMemoryMemory>;
  ingest(
    messages: Iterable<{ role: "system" | "user" | "assistant"; content: string; timestamp?: Date }>,
    options?: { sessionId?: string | null }
  ): Promise<void>;
  recall(
    query: string,
    options?: {
      thinkingLevel?: "low" | "medium" | "high";
      responseLength?: "short" | "medium" | "long";
      referenceDate?: Date | string;
    }
  ): Promise<AgentMemoryRecallResult>;
  list(options?: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    type?: "fact" | "event" | "instruction" | "task";
  }): Promise<{ memories: AgentMemoryListEntry[]; cursor?: string }>;
  get(memoryId: string): Promise<AgentMemoryMemory>;
  delete(memoryId: string): Promise<AgentMemoryMemory>;
  deleteSession(sessionId: string): Promise<void>;
  getSummary(options?: { sessionId?: string | null }): Promise<{ summary: string }>;
}

export type AgentMemoryMemory = {
  id: string;
  type: "fact" | "event" | "instruction" | "task";
  summary: string;
  content: string;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentMemoryListEntry = Omit<AgentMemoryMemory, "content">;

export type AgentMemoryRecallResult = {
  count: number;
  answer: string;
  candidates: Array<{ id: string; summary: string; sessionId: string | null; score: number }>;
};

export interface MemoryEnv {
  MEMORY?: AgentMemoryNamespace;
}

export class MemoryUnavailableError extends Error {
  constructor(message = "MEMORY binding missing - bind Agent Memory in cloudflare.config.ts") {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

async function profile(env: MemoryEnv): Promise<AgentMemoryProfile> {
  if (!env.MEMORY) throw new MemoryUnavailableError();
  return env.MEMORY.getProfile(MEMORY_PROFILE);
}

/** Explicit store (preferred when the fact is already known). */
export async function rememberFact(
  env: MemoryEnv,
  content: string,
  sessionId?: string | null
): Promise<AgentMemoryMemory> {
  const p = await profile(env);
  return p.remember({ content, sessionId: sessionId ?? null });
}

/** Semantic recall → synthesized answer + candidates. */
export async function recallFacts(
  env: MemoryEnv,
  query: string,
  options?: {
    thinkingLevel?: "low" | "medium" | "high";
    responseLength?: "short" | "medium" | "long";
  }
): Promise<AgentMemoryRecallResult> {
  const p = await profile(env);
  return p.recall(query, {
    thinkingLevel: options?.thinkingLevel ?? "low",
    responseLength: options?.responseLength ?? "medium",
  });
}

/** List recent memories (no content bodies). */
export async function listFacts(
  env: MemoryEnv,
  options?: { limit?: number; sessionId?: string; cursor?: string }
) {
  const p = await profile(env);
  return p.list(options);
}

/** Health probe: binding present + profile reachable. */
export async function memoryHealth(env: MemoryEnv): Promise<{
  ok: boolean;
  provider: string;
  profile: string;
  binding: boolean;
  detail?: string;
}> {
  const binding = Boolean(env.MEMORY);
  if (!binding) {
    return {
      ok: false,
      provider: "cloudflare-agent-memory",
      profile: MEMORY_PROFILE,
      binding: false,
      detail: "MEMORY binding missing",
    };
  }
  try {
    const p = await profile(env);
    await p.list({ limit: 1 });
    return {
      ok: true,
      provider: "cloudflare-agent-memory",
      profile: MEMORY_PROFILE,
      binding: true,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "cloudflare-agent-memory",
      profile: MEMORY_PROFILE,
      binding: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @deprecated Old Agents SDK agent.memory.* shape — do not use for Missions OS.
 * Kept as named aliases pointing at Workers binding helpers for call-site migration.
 */
export async function ingestMemory(
  env: MemoryEnv,
  content: string,
  _metadata?: Record<string, unknown>,
  sessionId?: string | null
): Promise<void> {
  await rememberFact(env, content, sessionId);
}

export async function recallMemory(
  env: MemoryEnv,
  query: string,
  _topK = 5
): Promise<Array<{ id: string; content: string; score?: number }>> {
  const result = await recallFacts(env, query);
  return (result.candidates ?? []).map((c) => ({
    id: c.id,
    content: c.summary,
    score: c.score,
  }));
}

export async function rememberDecision(
  env: MemoryEnv,
  content: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const tag = metadata?.type ? `[${String(metadata.type)}] ` : "";
  await rememberFact(env, `${tag}${content}`, (metadata?.sessionId as string) ?? null);
}
