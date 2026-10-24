/**
 * Cloudflare Agent Memory on the missions Worker. Profiles are per tenant (kingdom); reads and
 * writes go through src/lib/agent-memory.ts with the tenant from the verified identity. This file
 * only answers the ops health probe, which never opens or creates a profile.
 */
import type { AMNamespace } from "../../../../src/lib/agent-memory.ts";
export type AgentMemoryNamespace = AMNamespace;

export interface MemoryEnv {
  MEMORY?: AMNamespace;
  AGENT_MEMORY_NAMESPACE?: string;
}

export async function memoryHealth(env: MemoryEnv): Promise<{ ok: boolean; binding: boolean; namespace: string | null; model: string }> {
  return { ok: Boolean(env.MEMORY), binding: Boolean(env.MEMORY), namespace: env.AGENT_MEMORY_NAMESPACE ?? null, model: "profile per tenant" };
}
