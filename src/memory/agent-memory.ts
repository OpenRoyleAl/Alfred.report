// src/memory/agent-memory.ts — Cloudflare Agent Memory integration
// Uses agent_memory binding (NOT KV). Namespace: alfred.
// Reference: https://developers.cloudflare.com/agent-memory/api/workers-api/

import type { Env } from "../types";

export async function ingestMemories(env: Env, messages: Array<{ role: string; content: string }>, profile?: string): Promise<void> {
  const memory = await env.ALFRED_MEMORY.getProfile(profile || "default");
  await memory.ingest(messages.map((m) => ({ role: m.role, content: m.content })));
}

export async function remember(env: Env, content: string, profile?: string, metadata?: Record<string, string>): Promise<void> {
  const memory = await env.ALFRED_MEMORY.getProfile(profile || "default");
  await memory.remember({
    content: metadata ? `${content}\n\nMetadata: ${JSON.stringify(metadata)}` : content,
  });
}

export async function recall(env: Env, query: string, profile?: string, topK?: number): Promise<string[]> {
  const memory = await env.ALFRED_MEMORY.getProfile(profile || "default");
  const result = await memory.recall(query, {
    thinkingLevel: topK && topK > 5 ? "medium" : "low",
    responseLength: "medium",
  });
  return result.answer ? [result.answer] : [];
}

export async function getMemorySummary(env: Env, profile?: string): Promise<string | null> {
  const memory = await env.ALFRED_MEMORY.getProfile(profile || "default");
  const result = await memory.getSummary();
  return result.summary || null;
}

export async function promoteFactToSkill(env: Env, fact: string, skillName: string, profile?: string): Promise<void> {
  await remember(env, fact, profile, {
    type: "skill",
    skillName,
    promoted: new Date().toISOString(),
  });
}

export async function buildMemoryContext(env: Env, query: string, profile?: string): Promise<string> {
  const memories = await recall(env, query, profile, 3);
  if (memories.length === 0) return "";
  return memories.map((m, i) => `[Memory ${i + 1}] ${m}`).join("\n");
}