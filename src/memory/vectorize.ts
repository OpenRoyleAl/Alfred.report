// src/memory/vectorize.ts — Semantic memory via Vectorize

import type { Env } from "../types";

export async function storeMemoryVector(env: Env, userId: string, text: string, metadata: Record<string, string> = {}): Promise<void> {
  const embeddings = await env.AI.run("@cf/baai/bge-m3", { text: [text] }) as { data: number[][] };
  await env.ALFRED_MEMORY.insert({ id: crypto.randomUUID(), vector: embeddings.data[0], metadata: { userId, text, ...metadata, created_at: new Date().toISOString() } });
}

export async function recallSemantic(env: Env, userId: string, query: string, topK: number = 5): Promise<Array<{ score: number; text: string; metadata: Record<string, string> }>> {
  const embeddings = await env.AI.run("@cf/baai/bge-m3", { text: [query] }) as { data: number[][] };
  const results = await env.ALFRED_MEMORY.query({ vector: embeddings.data[0], topK, filter: { userId } });
  return results.matches.map((match) => ({ score: match.score, text: match.metadata.text as string, metadata: match.metadata as Record<string, string> }));
}

export async function storeConversationTurn(env: Env, userId: string, sessionId: string, speaker: string, text: string): Promise<void> {
  await storeMemoryVector(env, userId, text, { speaker, sessionId, type: "conversation" });
}

export async function recallContext(env: Env, userId: string, query: string, topK: number = 3): Promise<string> {
  const memories = await recallSemantic(env, userId, query, topK);
  if (memories.length === 0) return "";
  return memories.map((m, i) => `[${i + 1}] ${m.metadata.speaker || "unknown"}: ${m.text}`).join("\n");
}