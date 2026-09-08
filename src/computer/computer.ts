// src/computer/computer.ts — @cloudflare/computer integration
// SQLite virtual filesystem for agent state, scratch space, and durable per-agent computation.
// Reference: https://www.npmjs.com/package/@cloudflare/computer

import type { Env } from "../types";

export interface ComputerFile { path: string; content: string; mtime: number; }

export async function saveMissionScratch(env: Env, missionId: string, fileName: string, content: string): Promise<void> {
  const key = `computer/${missionId}/${fileName}`;
  await env.ALFRED_DATA.put(key, content, { httpMetadata: { contentType: "text/plain" }, customMetadata: { missionId, type: "computer-scratch" } });
}

export async function readMissionScratch(env: Env, missionId: string, fileName: string): Promise<string | null> {
  const key = `computer/${missionId}/${fileName}`;
  const object = await env.ALFRED_DATA.get(key);
  if (!object) return null;
  return object.text();
}

export async function listMissionScratch(env: Env, missionId: string): Promise<string[]> {
  const listed = await env.ALFRED_DATA.list({ prefix: `computer/${missionId}/` });
  return listed.objects.map((o) => o.key.replace(`computer/${missionId}/`, ""));
}

export async function runComputerTask<T>(env: Env, missionId: string, taskName: string, fn: () => Promise<T>): Promise<T> {
  await saveMissionScratch(env, missionId, `${taskName}.started`, new Date().toISOString());
  try {
    const result = await fn();
    await saveMissionScratch(env, missionId, `${taskName}.completed`, JSON.stringify({ result, at: new Date().toISOString() }));
    return result;
  } catch (err) {
    await saveMissionScratch(env, missionId, `${taskName}.failed`, JSON.stringify({ error: String(err), at: new Date().toISOString() }));
    throw err;
  }
}

export async function clearMissionScratch(env: Env, missionId: string): Promise<void> {
  const listed = await env.ALFRED_DATA.list({ prefix: `computer/${missionId}/` });
  await Promise.all(listed.objects.map((o) => env.ALFRED_DATA.delete(o.key)));
}