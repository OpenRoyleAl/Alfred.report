/**
 * One stateless voice turn (text in -> spoken text out), shared by the signed-in web app's
 * in-app voice (/api/alfred/voice) and ORAL's device endpoint (POST oral.<DOMAIN>/api/voice, for
 * Siri Shortcuts and agents). Same policy as the ORAL socket: WAKE -> The Report; the owner can
 * draft a mission and start it with "Go Max AI!" (the draft round-trips as `pending`).
 */
import { BRAND, FLOW, PLATFORM_ROLE, instanceBrand, wakeWord } from "../brand.ts";
import { speakReport, type TheReport } from "./report.ts";
import { parseUtterance } from "../../apps/oral/src/wake.ts";
import { CANCELLED, decideTurn } from "../../apps/oral/src/turn.ts";

/** RPC surface of the tenant's Alfred Durable Object (src/alfred/agent.ts). */
export interface AlfredVoiceRpc {
  bind(tenantId: string, isOwner: boolean): Promise<void>;
  report(limit?: number): Promise<TheReport>;
  draftFromVoice(transcript: string): Promise<{ objective: string; needsReview: string[]; due: string | null }>;
  missionFromVoice(objective: string, requestId?: string | null, source?: "voice" | "siri" | "oral"): Promise<{ missionId: string }>;
  consumeQuota(kind: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }>;
}

export interface VoiceTurnResult {
  text: string;
  action: "report" | "say" | "draft" | "start" | "cancel" | "chat";
  /** Drafted objective waiting for "Go Max AI!" (send it back as `pending`). */
  pending?: string;
  missionId?: string;
}

export const CHAT_MODEL = "@cf/moonshotai/kimi-k2.6";

function systemPrompt(domain: string): string {
  return `You are ${instanceBrand(domain)}, the voice of this Alfred.report instance (${FLOW.oral}).
${BRAND.platformBrand} is the platform and ${PLATFORM_ROLE} behind it.
- Speak naturally and briefly: 1-3 sentences. Plain text only, no markdown.
- Saying "${wakeWord(domain)}" alone gives ${FLOW.report}; the owner can say "start a mission ..." and then "${FLOW.goMax}".
- Never invent facts, products, names or results.`;
}

function aiText(r: unknown): string {
  const o = r as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof o?.response === "string") return o.response;
  const c = o?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

export async function voiceTurn(
  o: { ai: Ai; alfred: AlfredVoiceRpc; domain: string; isOwner: boolean; askLimit: number; requestId?: string | null },
  transcript: string,
  pending?: string
): Promise<VoiceTurnResult> {
  const action = decideTurn(parseUtterance(transcript, o.domain), o.isOwner, pending || undefined);
  switch (action.do) {
    case "report":
      return { action: "report", text: speakReport(await o.alfred.report()) };
    case "say":
      return { action: "say", text: action.text, pending };
    case "cancel":
      return { action: "cancel", text: CANCELLED };
    case "draft": {
      const d = await o.alfred.draftFromVoice(action.objective);
      const unsure = d.needsReview.length ? ` I'm not sure about the ${d.needsReview.join(" and ").replace(/_/g, " ")}.` : "";
      return { action: "draft", pending: d.objective, text: `Mission ready: ${d.objective}.${unsure} Say ${FLOW.goMax} to start it, or cancel.` };
    }
    case "start": {
      // Client requestId (one per drafted mission): a repeated "Go Max AI!" is one run.
      const { missionId } = await o.alfred.missionFromVoice(action.objective, o.requestId ?? null);
      return {
        action: "start",
        missionId,
        text: `${FLOW.goMax} Mission started, reference ${missionId.slice(-4)}. Say ${wakeWord(o.domain)} any time for ${FLOW.report}.`,
      };
    }
    case "chat":
      break;
  }
  if (action.metered) {
    const q = await o.alfred.consumeQuota("ask", o.askLimit);
    if (!q.ok) return { action: "say", text: `You've used today's ${q.limit} sandbox questions. Try again tomorrow.` };
  }
  const r = await o.ai.run(CHAT_MODEL as never, {
    messages: [
      { role: "system", content: systemPrompt(o.domain) },
      { role: "user", content: transcript.slice(0, 2000) },
    ],
    max_tokens: 300,
  } as never);
  return { action: "chat", text: aiText(r).trim() || "Sorry, I didn't catch that.", pending };
}

/** Speech -> text (Workers AI Whisper). Accepts any audio container Whisper decodes. */
export async function transcribe(ai: Ai, audio: ArrayBuffer): Promise<string> {
  const r = (await ai.run("@cf/openai/whisper" as never, { audio: [...new Uint8Array(audio)] } as never)) as { text?: string };
  return (r?.text || "").trim();
}

/** Text -> speech (Workers AI Aura). Returns mp3 bytes. */
export async function speak(ai: Ai, text: string): Promise<ReadableStream | ArrayBuffer> {
  const r = (await ai.run("@cf/deepgram/aura-1" as never, { text: text.slice(0, 1900), speaker: "athena" } as never, { returnRawResponse: true } as never)) as unknown;
  if (r instanceof Response) return r.body ?? (await r.arrayBuffer());
  if (r instanceof ReadableStream) return r;
  return r as ArrayBuffer;
}
