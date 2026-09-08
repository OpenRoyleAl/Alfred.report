import { Agent } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
import { recordCop, recordCostEvent } from "../../src/cop/cop";
import { ingestMemories, buildMemoryContext } from "../../src/memory/agent-memory";
import { createOralTools, WORKERS_AI_TOOLS } from "./tools";
import { buildSystemPrompt, generateResponse, type AgentEnv } from "./llm";

const VoiceAgent = withVoice(Agent);

function parseToolCalls(raw: any): Array<{ name: string; arguments: any }> {
  const message = raw?.choices?.[0]?.message || raw;
  const calls = message?.tool_calls || raw?.tool_calls || [];
  if (!Array.isArray(calls)) return [];
  return calls.map((call: any) => {
    const name = call.function?.name || call.name;
    let args = call.function?.arguments || call.arguments || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = { query: args, url: args }; }
    }
    return { name, arguments: args };
  });
}

export class OralOperatorAgent extends VoiceAgent<AgentEnv> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI, { model: "@cf/deepgram/aura-2-en" });

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/turn") && request.method === "POST") {
      const body = await request.json<{ text?: string; userId?: string; missionId?: string }>();
      const text = body.text?.trim();
      if (!text) return Response.json({ error: "text is required" }, { status: 400 });
      const response = await this.processOral(text, { userId: body.userId, missionId: body.missionId });
      return Response.json({ response, agent: "OralOperatorAgent" });
    }
    return Response.json({
      status: "ok",
      agent: "OralOperatorAgent",
      voice: true,
      tools: ["search_knowledge_base", "browser_markdown", "browser_extract", "authorize_spend"],
      wallet: `${this.env.WALLET_HANDLE || "alfred"}.cloudflare.pay`,
    });
  }

  async processOral(input: string, context: { userId?: string; missionId?: string; sessionId?: string } = {}): Promise<string> {
    const start = Date.now();
    const uid = context.userId || "anonymous";
    const tools = createOralTools(this.env);
    const memoryContext = await buildMemoryContext(this.env as any, input, "alfred");
    const systemPrompt = buildSystemPrompt(this.env.ALFRED_PERSONALITY, memoryContext ? `Relevant memories:\n${memoryContext}` : "");

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "system", content: "You may call search_knowledge_base, browser_markdown, browser_extract, or authorize_spend when they would improve the answer. Skip tools for greetings." },
      { role: "user", content: input },
    ];

    let { response, provider, model, tokensIn, tokensOut, raw } = await generateResponse(this.env, messages, uid, { tools: WORKERS_AI_TOOLS });

    const calls = parseToolCalls(raw);
    if (calls.length > 0) {
      const observations: string[] = [];
      for (const call of calls.slice(0, 4)) {
        try {
          if (call.name === "search_knowledge_base") {
            observations.push(String(await tools.search.execute(call.arguments.query)));
          } else if (call.name === "browser_markdown") {
            observations.push(JSON.stringify(await tools.browser.browser_markdown(call.arguments.url)));
          } else if (call.name === "browser_extract") {
            observations.push(JSON.stringify(await tools.browser.browser_extract(call.arguments.url, call.arguments.instructions)));
          } else if (call.name === "authorize_spend") {
            observations.push(JSON.stringify(await tools.payments.execute(call.arguments)));
          }
        } catch (err) {
          observations.push(`${call.name} failed: ${String(err)}`);
        }
      }
      const follow = await generateResponse(this.env, [
        ...messages,
        { role: "assistant", content: response || "I'll use tools." },
        { role: "user", content: `Tool results:\n${observations.join("\n\n")}\nAnswer the original request using these results.` },
      ], uid);
      response = follow.response;
      provider = follow.provider;
      model = follow.model;
      tokensIn += follow.tokensIn;
      tokensOut += follow.tokensOut;
    }

    recordCop(this.env as any, {
      userId: uid,
      missionId: context.missionId || "oral",
      agent: "oral",
      provider,
      model,
      eventType: "llm",
      tokensIn,
      tokensOut,
      durationMs: Date.now() - start,
    });
    await recordCostEvent(this.env as any, {
      missionId: context.missionId || null,
      userId: uid,
      agent: "oral",
      provider,
      model,
      eventType: "llm",
      tokensIn,
      tokensOut,
      durationMs: Date.now() - start,
    });

    await ingestMemories(this.env as any, [
      { role: "user", content: input },
      { role: "assistant", content: response },
    ], "alfred").catch(() => {});

    return response;
  }
}
