import type { Env } from "../types";

export interface DebriefResult {
  sent: boolean;
  to: string;
  messageId?: string;
  error?: string;
  stored: boolean;
}

function debriefText(
  mission: { id: string; title: string; status: string; user_id: string; result?: string | null },
  gate: { passed: boolean; summary?: string; reason?: string },
): string {
  return [
    `Alfred debrief — ${mission.title}`,
    ``,
    `Mission: ${mission.id}`,
    `Status: ${mission.status}`,
    `Gate: ${gate.passed ? "passed" : "failed"}`,
    gate.summary ? `Summary: ${gate.summary}` : "",
    gate.reason ? `Reason: ${gate.reason}` : "",
    mission.result ? `Result: ${mission.result}` : "",
    ``,
    `— Alfred`,
  ].filter((line) => line !== undefined).join("\n");
}

async function persistDebrief(env: Env, missionId: string, payload: Record<string, unknown>, text: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mission_events (mission_id, event_type, actor, event_data) VALUES (?, 'result_updated', 'alfred', ?)`
  ).bind(missionId, JSON.stringify({ debrief: true, ...payload })).run();
  await env.ALFRED_DATA.put(`debriefs/${missionId}.txt`, text, { httpMetadata: { contentType: "text/plain" } });
}

async function deliverEmail(
  env: Env,
  args: { to: string; from: string; subject: string; text: string; html: string },
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  let bindingError = "";
  try {
    if (env.EMAIL?.send) {
      const response = await env.EMAIL.send(args) as { messageId?: string };
      return { sent: true, messageId: response?.messageId };
    }
  } catch (err) {
    bindingError = String(err);
  }
  try {
    const token = await env.CF_API_TOKEN.get();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await res.json<{ success?: boolean; result?: { message_id?: string; id?: string }; errors?: Array<{ message: string }> }>();
    if (res.ok && data.success) {
      return { sent: true, messageId: data.result?.message_id || data.result?.id };
    }
    return { sent: false, error: data.errors?.map((e) => e.message).join("; ") || `email API ${res.status}` };
  } catch (err) {
    return { sent: false, error: `${bindingError ? bindingError + "; " : ""}${String(err)}` };
  }
}

export async function sendMissionDebrief(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  mission: { id: string; title: string; status: string; user_id: string; result?: string | null },
  gate: { passed: boolean; summary?: string; reason?: string },
): Promise<DebriefResult> {
  const to = "hans@icebergmedia.co.uk";
  const from = "alfred@alfred.report";
  const subject = `Alfred debrief: ${mission.title}`;
  const text = debriefText(mission, gate);
  const html = `<pre style="font-family:Georgia,serif;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre>`;

  try {
    await persistDebrief(env, mission.id, { sent: false, to, subject, pending: true }, text);
  } catch (err) {
    return { sent: false, stored: false, to, error: `persist failed: ${String(err)}` };
  }

  ctx.waitUntil((async () => {
    const result = await deliverEmail(env, { to, from, subject, text, html });
    await persistDebrief(env, mission.id, { ...result, to, subject, pending: false }, text).catch(() => {});
  })());

  return { sent: false, stored: true, to, error: "queued" };
}
