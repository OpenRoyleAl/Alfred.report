// src/a2a/tasks.ts — A2A task lifecycle
import type { Env } from "../types";

export async function handleTaskSend(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ id: string; sessionId?: string; message: { role: string; parts: { type: string; text: string }[] }; acceptedInputModes?: string[] }>();
  if (!body.id || !body.message?.parts) return Response.json({ error: "id and message.parts are required" }, { status: 400 });
  const text = body.message.parts.filter((p) => p.type === "text").map((p) => p.text).join(" ");
  if (!text) return Response.json({ error: "At least one text part is required" }, { status: 400 });
  const missionId = `a2a:${body.id}`;
  const existing = await env.DB.prepare(`SELECT status, result FROM missions WHERE id = ? AND user_id = ?`).bind(missionId, `a2a:${body.id}`).first<any>();
  if (existing?.status === "completed" && existing.result) {
    const previous = JSON.parse(existing.result);
    return Response.json({ id: body.id, status: "completed", artifacts: [{ parts: [{ type: "text", text: previous.a2a_response || "" }] }] });
  }
  await env.DB.prepare(
    `INSERT INTO missions (id, user_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
       status = 'pending', result = NULL, updated_at = datetime('now')`
  ).bind(missionId, `a2a:${body.id}`, `A2A Task: ${text.substring(0, 80)}`, text).run();
  const oralResponse = await env.AGENT_ALFRED.fetch("https://agent-alfred/internal/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      sessionId: body.sessionId || body.id,
      missionId,
      userId: `a2a:${body.id}`,
    }),
  });
  if (!oralResponse.ok) {
    await env.DB.prepare(`UPDATE missions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).bind(missionId).run();
    return Response.json({ id: body.id, status: "failed", error: `ORAL operator returned ${oralResponse.status}` }, { status: 502 });
  }
  const result = await oralResponse.json<{ response: string }>();
  await env.DB.prepare(`UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?`).bind(JSON.stringify({ a2a_response: result.response }), missionId).run();
  return Response.json({ id: body.id, status: "completed", artifacts: [{ parts: [{ type: "text", text: result.response }] }] });
}

export async function handleTaskGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("id");
  if (!taskId) return Response.json({ error: "id required" }, { status: 400 });
  const mission = await env.DB.prepare(`SELECT * FROM missions WHERE id = ? AND user_id = ?`).bind(`a2a:${taskId}`, `a2a:${taskId}`).first<any>();
  if (!mission) return Response.json({ error: "Task not found" }, { status: 404 });
  return Response.json({ id: taskId, status: mission.status === "completed" ? "completed" : "working", artifacts: mission.result ? [{ parts: [{ type: "text", text: JSON.parse(mission.result).a2a_response || "" }] }] : [] });
}

export async function handleTaskCancel(request: Request, env: Env): Promise<Response> {
  const { id } = await request.json<{ id: string }>();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const result = await env.DB.prepare(`UPDATE missions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status != 'completed'`).bind(`a2a:${id}`, `a2a:${id}`).run();
  if (!result.meta.changes) return Response.json({ error: "Task not found or already completed" }, { status: 404 });
  return Response.json({ id, status: "cancelled" });
}