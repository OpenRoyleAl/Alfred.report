// src/a2a/tasks.ts — A2A task lifecycle
import type { Env } from "../types";

export async function handleTaskSend(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ id: string; sessionId?: string; message: { role: string; parts: { type: string; text: string }[] }; acceptedInputModes?: string[] }>();
  const text = body.message.parts.filter((p) => p.type === "text").map((p) => p.text).join(" ");
  const missionId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO missions (id, user_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`).bind(missionId, `a2a:${body.id}`, `A2A Task: ${text.substring(0, 80)}`, text).run();
  const oralResponse = await env.AGENT_ALFRED.fetch("https://agent-alfred/internal/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sessionId: body.sessionId || body.id, missionId }) });
  const result = await oralResponse.json<{ response: string }>();
  await env.DB.prepare(`UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?`).bind(JSON.stringify({ a2a_response: result.response }), missionId).run();
  return Response.json({ id: body.id, status: "completed", artifacts: [{ parts: [{ type: "text", text: result.response }] }] });
}

export async function handleTaskGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("id");
  if (!taskId) return Response.json({ error: "id required" }, { status: 400 });
  const mission = await env.DB.prepare(`SELECT * FROM missions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(`a2a:${taskId}`).first<any>();
  if (!mission) return Response.json({ error: "Task not found" }, { status: 404 });
  return Response.json({ id: taskId, status: mission.status === "completed" ? "completed" : "working", artifacts: mission.result ? [{ parts: [{ type: "text", text: JSON.parse(mission.result).a2a_response || "" }] }] : [] });
}

export async function handleTaskCancel(request: Request, env: Env): Promise<Response> {
  const { id } = await request.json<{ id: string }>();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await env.DB.prepare(`UPDATE missions SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ?`).bind(`a2a:${id}`).run();
  return Response.json({ id, status: "cancelled" });
}