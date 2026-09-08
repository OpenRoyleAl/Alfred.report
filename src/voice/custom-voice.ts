// src/voice/custom-voice.ts — Custom voice sample upload and retrieval

import type { Env } from "../types";

export async function handleVoiceUpload(request: Request, env: Env, userId: string): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get("voice_sample") as File;
  if (!file) return Response.json({ error: "voice_sample file is required" }, { status: 400 });
  const allowedTypes = ["audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/webm"];
  if (!allowedTypes.includes(file.type)) return Response.json({ error: `Invalid file type: ${file.type}. Allowed: ${allowedTypes.join(", ")}` }, { status: 400 });
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) return Response.json({ error: "File too large. Maximum size: 10MB" }, { status: 413 });
  const sampleId = crypto.randomUUID();
  const key = `voice-samples/${userId}/${sampleId}-${file.name}`;
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, updated_at) VALUES (?, datetime('now'))
     ON CONFLICT(user_id) DO NOTHING`
  ).bind(userId).run();
  await env.ALFRED_DATA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { userId, originalName: file.name, uploadedAt: new Date().toISOString() },
  });
  await env.DB.prepare(`INSERT INTO voice_samples (id, user_id, r2_key, file_name, file_size, mime_type, status) VALUES (?, ?, ?, ?, ?, ?, 'uploaded')`).bind(sampleId, userId, key, file.name, file.size, file.type).run();
  await env.DB.prepare(`UPDATE user_preferences SET voice_sample_key = ?, updated_at = datetime('now') WHERE user_id = ?`).bind(key, userId).run();
  return Response.json({ success: true, sample_id: sampleId, r2_key: key, status: "uploaded" });
}

export async function getVoiceSample(env: Env, sampleId: string): Promise<Response> {
  const sample = await env.DB.prepare(`SELECT * FROM voice_samples WHERE id = ?`).bind(sampleId).first();
  if (!sample) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(sample);
}

export async function downloadVoiceSample(env: Env, sampleId: string): Promise<Response> {
  const sample = await env.DB.prepare(`SELECT r2_key, mime_type FROM voice_samples WHERE id = ?`).bind(sampleId).first<{ r2_key: string; mime_type: string }>();
  if (!sample) return Response.json({ error: "Not found" }, { status: 404 });
  const object = await env.ALFRED_DATA.get(sample.r2_key);
  if (!object) return Response.json({ error: "File not found in R2" }, { status: 404 });
  return new Response(object.body, { headers: { "Content-Type": sample.mime_type, "Content-Disposition": `attachment; filename="${sampleId}"` } });
}

export async function listVoiceSamples(env: Env, userId: string): Promise<Response> {
  const results = await env.DB.prepare(`SELECT * FROM voice_samples WHERE user_id = ? ORDER BY created_at DESC`).bind(userId).all();
  return Response.json(results.results);
}