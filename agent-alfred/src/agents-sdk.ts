// agent-alfred/src/agents-sdk.ts — Agents SDK integration
// Rebuilds the ORAL operator as an Agents SDK Agent with:
// - Browser Run tools (createBrowserTools)
// - AI Search tool (createAISearchTool)
// - Voice channel (withVoice)
// - Durable execution via Agent base class (Durable Object)

import { Agent, routeAgentRequest } from "agents";
import { createBrowserTools } from "agents/browser/ai";
import { createAISearchTool } from "agents/tools/ai-search";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";

interface AgentEnv {
  AI: Ai;
  BROWSER: Fetcher;
  AI_SEARCH: AiSearchNamespace;
  DB: D1Database;
  ALFRED_MEMORY: AgentMemoryNamespace;
  ALFRED_COP: AnalyticsEngineDataset;
}

// --- Voice-capable ORAL agent ---
const VoiceAgent = withVoice(Agent);

export class OralOperatorAgent extends VoiceAgent {
  // Workers AI powers STT and TTS (no API keys needed)
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  // Browser automation via Browser Run
  browserTools = createBrowserTools({
    ctx: this.ctx,
    browser: this.env.BROWSER,
    loader: this.env.LOADER,
    session: { mode: "dynamic" },
  });

  // Grounded retrieval over alfred.report content
  aiSearchTool = createAISearchTool(this.env.AI_SEARCH, "alfred-kb");

  async onTurn(transcript: string, context: any) {
    // Voice turn: transcript → ORAL processing → spoken response
    const response = await this.processOral(transcript, context);
    return response; // TTS speaks automatically via withVoice
  }

  async onMessage(message: string) {
    // Text message: process through ORAL loop
    return this.processOral(message, {});
  }

  private async processOral(input: string, context: any): Promise<string> {
    // 1. Recall from Agent Memory
    let memoryContext = "";
    try {
      const memories = await this.env.ALFRED_MEMORY.recall({
        query: input,
        profile: "alfred",
        topK: 3,
      });
      memoryContext = memories.map((m: any) => m.content || m.text).join("\n");
    } catch { /* memory optional */ }

    // 2. Build prompt with Alfred personality
    const systemPrompt = `You are Alfred, a warm British male ORAL operator. Authoritative yet approachable. Concise with dry wit. Highly proactive. Respond as if speaking aloud.`;
    const messages = [
      { role: "system", content: systemPrompt },
      ...(memoryContext ? [{ role: "system", content: `Relevant memories:\n${memoryContext}` }] : []),
      { role: "user", content: input },
    ];

    // 3. Generate response via Workers AI (default)
    const aiResponse = await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      { messages, temperature: 0.7 }
    ) as any;
    const response = aiResponse.response || "";

    // 4. COP telemetry
    this.env.ALFRED_COP.writeDataPoint({
      blobs: [context.userId || "anonymous", "oral", "workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "llm"],
      doubles: [Math.ceil(input.length / 4), Math.ceil(response.length / 4), 0, 0],
      indexes: ["oral"],
    });

    // 5. Ingest into Agent Memory
    try {
      await this.env.ALFRED_MEMORY.ingest({
        messages: [
          { role: "user", content: input },
          { role: "assistant", content: response },
        ],
        profile: "alfred",
      });
    } catch { /* memory optional */ }

    return response;
  }
}

// --- Router: route requests to the agent ---
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return routeAgentRequest(request, env);
  },
};