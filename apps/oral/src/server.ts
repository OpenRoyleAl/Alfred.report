import { Agent, type Connection } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { BRAND, FLOW, PLATFORM_ROLE, instanceBrand, wakeWord } from "../../../src/brand.ts";
import { speakReport, type TheReport } from "../../../src/alfred/report.ts";
import { isOwnerTenantId } from "../../../src/lib/tenant.ts";
import { gatewayId } from "../../../src/alfred/gateway.ts";
import { parseUtterance, wakeKeyterms } from "./wake.ts";
import { CANCELLED, decideTurn } from "./turn.ts";

// ORAL - the voice-listen stage (@cloudflare/voice withVoice on Workers AI: Flux STT, Aura TTS).
// Listening is continuous. Saying the instance brand alone is WAKE and speaks The Report (built
// from stored missions, no model in the loop). The owner can draft a mission by voice and start
// it with "Go Max AI!". The instance is named by the verified tenant (worker.ts enforces it).

/** RPC surface of the tenant's Alfred Durable Object in the web Worker (src/alfred/agent.ts). */
export interface AlfredRpc {
  bind(tenantId: string, isOwner: boolean): Promise<void>;
  report(limit?: number): Promise<TheReport>;
  draftFromVoice(transcript: string): Promise<{ objective: string; needsReview: string[]; due: string | null }>;
  missionFromVoice(objective: string): Promise<{ missionId: string }>;
  consumeQuota(kind: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }>;
}

const VoiceAgent = withVoice(Agent, { historyLimit: 20 });

function systemPrompt(domain: string): string {
  return `You are ${instanceBrand(domain)}, the voice of this Alfred.report instance (${FLOW.oral}).
${BRAND.platformBrand} is the platform and ${PLATFORM_ROLE} behind it.
- Speak naturally and briefly: 1-3 sentences.
- Saying "${wakeWord(domain)}" alone gives ${FLOW.report}; the owner can say "start a mission ..." and then "${FLOW.goMax}".
- You cannot see missions in this chat; if asked for status, tell them to say "${wakeWord(domain)}".
- Never invent facts, products, names or results.`;
}

export class AlfredOral extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, { eotThreshold: 0.7, keyterms: wakeKeyterms(this.env.DOMAIN) });
  tts = new WorkersAITTS(this.env.AI, { model: "@cf/deepgram/aura-1", speaker: "athena" });

  /** Drafted voice missions waiting for "Go Max AI!", per connection (calls keep the object alive). */
  private pending = new Map<string, string>();

  private get tenant(): string {
    return this.name;
  }
  private async ownerP(): Promise<boolean> {
    return isOwnerTenantId(this.env as never, this.tenant);
  }

  private async alfred(): Promise<AlfredRpc> {
    const stub = this.env.ALFRED.getByName(this.tenant) as unknown as AlfredRpc;
    await stub.bind(this.tenant, await this.ownerP());
    return stub;
  }

  onCallEnd(connection: Connection) {
    this.pending.delete(connection.id);
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const domain = this.env.DOMAIN || "";
    const conn = context.connection.id;
    const action = decideTurn(parseUtterance(transcript, domain), await this.ownerP(), this.pending.get(conn));

    switch (action.do) {
      case "report":
        return speakReport(await (await this.alfred()).report());
      case "say":
        return action.text;
      case "cancel":
        this.pending.delete(conn);
        return CANCELLED;
      case "draft": {
        const draft = await (await this.alfred()).draftFromVoice(action.objective);
        this.pending.set(conn, draft.objective);
        const unsure = draft.needsReview.length ? ` I'm not sure about the ${draft.needsReview.join(" and ").replace(/_/g, " ")}.` : "";
        return `Mission ready: ${draft.objective}.${unsure} Say ${FLOW.goMax} to start it, or cancel.`;
      }
      case "start":
        this.pending.delete(conn);
        return this.start(action.objective);
      case "chat":
        break;
    }
    if (action.metered) {
      const q = await (await this.alfred()).consumeQuota("ask", sandboxLimit(this.env.SANDBOX_ASKS_PER_DAY));
      if (!q.ok) return `You've used today's ${q.limit} sandbox questions. Try again tomorrow.`;
    }
    // Same single gateway as every other model call (logs, caching, rate limits).
    const workersai = createWorkersAI({ binding: this.env.AI, gateway: { id: gatewayId(this.env as never) } });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6"),
      system: systemPrompt(domain),
      messages: [
        ...context.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: transcript },
      ],
      abortSignal: context.signal,
    });
    return result.textStream;
  }

  private async start(objective: string): Promise<string> {
    const { missionId } = await (await this.alfred()).missionFromVoice(objective);
    return `${FLOW.goMax} Mission started, reference ${missionId.slice(-4)}. Say ${wakeWord(this.env.DOMAIN || "")} any time for ${FLOW.report}.`;
  }
}

export function sandboxLimit(v: string | undefined, fallback = 30): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
