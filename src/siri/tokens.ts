import type { Env } from "../types";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function issueSiriToken(env: Env, email: string): Promise<{ token: string; created: boolean }> {
  const existing = await env.DB.prepare(
    `SELECT token FROM siri_tokens WHERE user_id = ?`
  ).bind(email).first<{ token: string }>();
  if (existing?.token) return { token: existing.token, created: false };
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO siri_tokens (token, user_id, email) VALUES (?, ?, ?)`
  ).bind(token, email, email).run();
  return { token, created: true };
}

export async function findSiriToken(env: Env, token: string): Promise<{ user_id: string; email: string } | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT user_id, email FROM siri_tokens WHERE token = ?`
  ).bind(token).first<{ user_id: string; email: string }>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE siri_tokens SET last_used_at = datetime('now') WHERE token = ?`).bind(token).run().catch(() => {});
  return row;
}

export function shortcutsImportUrl(token: string): string {
  const fileUrl = `https://voice.alfred.report/siri/alfred-report.shortcut?token=${encodeURIComponent(token)}`;
  return `shortcuts://import-shortcut?url=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent("Alfred report")}`;
}

export function briefingUrl(token: string): string {
  return `https://voice.alfred.report/voice/briefing?token=${encodeURIComponent(token)}`;
}
