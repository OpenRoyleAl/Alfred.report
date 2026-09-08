// src/memory/agent-memory.ts — Cloudflare Agent Memory integration
// Uses agent_memory binding (NOT KV). Namespace: alfred.
// Reference: https://developers.cloudflare.com/agent-memory/api/workers-api/

import type { Env } from "../types";

export async function ingestMemories(env: Env, messages: Array<{ role: string; content: string }>, profile?: string): Promise<void> {
  await env.ALFRED_MEMORY.ingest({ messages: messages.map((m) => ({ role: m.role, content: m.content })), profile: profile || "default" });
}

export async function remember(env: Env, content: string, profile?: string, metadata?: Record<string, string>): Promise<void> {
  await env.ALFRED_MEMORY.remember({ content, profile: profile || "default", metadata });
}

export async function recall(env: Env, query: string, profile?: string, topK?: number): Promise<string[]> {
  const results = await env.ALFRED_MEMORY.recall({ query, profile: profile || "default", topK: topK || 5 });
  return results.map((r: any) => r.content || r.text || JSON.stringify(r));
}

export async function getMemorySummary(env: Env, profile?: string): Promise<string | null> {
  return env.ALFRED_MEMORY.getSummary({ profile: profile || "default" });
}

export async function promoteFactToSkill(env: Env, fact: string, skillName: string, profile?: string): Promise<void> {
  await env.ALFRED_MEMORY.remember({ content: fact, profile: profile || "default", metadata: { type: "skill", skillName, promoted: new Date().toISOString() } });
}

export async function buildMemoryContext(env: Env, query: string, profile?: string): Promise<string> {
  const memories = await recall(env, query, profile, 3);
  if (memories.length === 0) return "";
  return memories.map((m, i) => `[Memory ${i + 1}] ${m}`).join("\n");
}