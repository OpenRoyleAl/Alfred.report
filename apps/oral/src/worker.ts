/// <reference path="../../../src/wasm.d.ts" />
import coreWasm from "../../../src/alfred/wasm/alfred_core.wasm";
import { initCore } from "../../../src/alfred/core.ts";
import { routeAgentRequest } from "agents";
import { AlfredOral, sandboxLimit } from "./server";
import { agentNameAllowed, identify } from "./identity";
import { instanceBrand, wakeWord } from "../../../src/brand.ts";
import { speak, transcribe, voiceTurn, type AlfredVoiceRpc } from "../../../src/alfred/voice-turn.ts";

// Instantiate the Rust core in the entry module (speakReport / The Report). A missing initCore
// is a Worker 1101: the wasm Module import is not an Instance until this runs.
initCore(coreWasm);

export { AlfredOral };

const REALM = 'Bearer realm="oral", error="invalid_token", error_description="agent token with the voice scope required"';
const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized", hint: "Authorization: Bearer <agent token with scope voice>" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": REALM, "Cache-Control": "no-store" },
  });

// ORAL is for devices and agents only (Siri Shortcuts, other agents, hardware). Humans use voice
// inside their signed-in web app. Every request needs a `voice`-scoped agent token; 401 otherwise.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = await identify(request, env as never);
    if (!id) return unauthorized();

    if (url.pathname === "/api/whoami") {
      return Response.json({ tenant: id.tenant, isOwner: id.isOwner, token: id.name, brand: instanceBrand(env.DOMAIN), wakeWord: wakeWord(env.DOMAIN) });
    }
    if (url.pathname === "/api/voice" || url.pathname === "/api/siri") {
      return voiceEndpoint(request, env, url, id);
    }
    const guard = (_req: Request, route: { name: string }) =>
      agentNameAllowed(route.name, id) ? undefined : new Response("Forbidden", { status: 403 });
    const routed = await routeAgentRequest(request, env, { onBeforeConnect: guard, onBeforeRequest: guard });
    if (routed) return routed;
    if (url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

/**
 * Siri Shortcut / device endpoint. POST one of:
 *   text/plain body ("Alfred report", "Go Max AI! book ...")
 *   application/json {"text": "...", "pending"?: "..."}
 *   audio/* body (m4a, wav, mp3, webm) -> transcribed first
 * Reply: spoken Report/answer as text/plain (default; Siri "Speak Text"), or audio/mpeg when
 * `Accept: audio/mpeg` or `?format=audio`, or JSON with `?format=json`.
 */
async function voiceEndpoint(req: Request, env: Env, url: URL, id: { tenant: string; isOwner: boolean }): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ usage: "POST text/plain, application/json {text}, or audio/* ; ?format=text|audio|json" }, { headers: { Allow: "POST" } });
  }
  const ct = (req.headers.get("Content-Type") || "").toLowerCase();
  let text = "";
  let pending: string | undefined;
  let heard: string | undefined;
  if (ct.startsWith("audio/") || ct === "application/octet-stream") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) return Response.json({ error: "audio too large (20 MB max)" }, { status: 413 });
    text = heard = await transcribe(env.AI, buf);
  } else if (ct.includes("json")) {
    const b = (await req.json().catch(() => ({}))) as { text?: unknown; pending?: unknown };
    text = typeof b.text === "string" ? b.text : "";
    pending = typeof b.pending === "string" ? b.pending.slice(0, 4000) : undefined;
  } else {
    text = await req.text();
  }
  text = text.trim().slice(0, 4000);
  if (!text) return Response.json({ error: "say something: text or audio body required" }, { status: 400 });

  const alfred = env.ALFRED.getByName(id.tenant) as unknown as AlfredVoiceRpc;
  await alfred.bind(id.tenant, id.isOwner);
  const out = await voiceTurn(
    { ai: env.AI, alfred, domain: env.DOMAIN || "", isOwner: id.isOwner, askLimit: sandboxLimit(env.SANDBOX_ASKS_PER_DAY) },
    text,
    pending
  );
  const format = url.searchParams.get("format") || ((req.headers.get("Accept") || "").includes("audio/") ? "audio" : "text");
  const headers = { "Cache-Control": "no-store" };
  if (format === "audio") {
    return new Response(await speak(env.AI, out.text), { headers: { ...headers, "Content-Type": "audio/mpeg" } });
  }
  if (format === "json") return Response.json({ ...out, heard }, { headers });
  return new Response(out.text, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
