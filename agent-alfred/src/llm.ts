import type { SecretStoreSecret, AgentMemoryNamespace, AiSearchNamespace } from "../../src/types";

export interface AgentEnv {
  AI: Ai;
  DB: D1Database;
  ALFRED_MEMORY: AgentMemoryNamespace;
  ALFRED_DATA: R2Bucket;
  ALFRED_COP: AnalyticsEngineDataset;
  AI_SEARCH: AiSearchNamespace;
  BROWSER: Fetcher;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_URL: string;
  OPENAI_API_KEY: SecretStoreSecret;
  MIMO_API_KEY: SecretStoreSecret;
  XAI_API_KEY: SecretStoreSecret;
  ALFRED_PERSONALITY: string;
  WALLET_HANDLE?: string;
}

export function buildSystemPrompt(personality: string, extra?: string): string {
  let prompt = `You are Alfred, a warm British male ORAL (Operator Response and Action Logic) operator. `;
  prompt += `You are authoritative yet approachable. You speak concisely with dry wit. You are highly proactive. `;
  prompt += `You manage missions, interact via voice, browse the web, and generate reports. `;
  prompt += `Respond naturally as if speaking aloud — keep responses spoken-style and concise.\n`;
  if (personality) prompt += `\nPersonality tag: ${personality}\n`;
  if (extra) prompt += `\n${extra}\n`;
  return prompt;
}

export async function generateResponse(
  env: AgentEnv,
  messages: Array<{ role: string; content: string }>,
  userId: string,
  extra?: { tools?: unknown[]; toolChoice?: string },
): Promise<{ response: string; provider: string; model: string; tokensIn: number; tokensOut: number; raw?: any }> {
  let provider = "workers-ai";
  try {
    const prefs = await env.DB.prepare(`SELECT tts_provider FROM user_preferences WHERE user_id = ?`).bind(userId).first<{ tts_provider: string }>();
    provider = prefs?.tts_provider || "workers-ai";
  } catch { /* default */ }

  const tokensIn = messages.reduce((sum, m) => sum + Math.ceil((m.content || "").length / 4), 0);
  let response = "";
  let model = "";
  let raw: any;

  switch (provider) {
    case "openai": {
      model = "gpt-4o";
      const apiKey = await env.OPENAI_API_KEY.get();
      const res = await fetch(`${env.AI_GATEWAY_URL}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      raw = data;
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    case "mimo": {
      model = "mimo-v2.5-pro";
      const apiKey = await env.MIMO_API_KEY.get();
      const res = await fetch(`${env.AI_GATEWAY_URL}/custom-mimo/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      raw = data;
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    case "xai": {
      model = "grok-3";
      const apiKey = await env.XAI_API_KEY.get();
      const res = await fetch(`${env.AI_GATEWAY_URL}/custom-xai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });
      const data = await res.json<any>();
      raw = data;
      response = data.choices?.[0]?.message?.content || "";
      break;
    }
    default: {
      model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      const payload: Record<string, unknown> = { messages, temperature: 0.7 };
      if (extra?.tools) payload.tools = extra.tools;
      const aiResponse = await env.AI.run(model, payload as any) as any;
      raw = aiResponse;
      response = aiResponse.response || aiResponse.choices?.[0]?.message?.content || "";
      provider = "workers-ai";
    }
  }

  const tokensOut = Math.ceil((response || "").length / 4);
  return { response, provider, model, tokensIn, tokensOut, raw };
}
