// src/voice/tts.ts — Provider-agnostic TTS layer

import type { Env, SecretStoreSecret, TTSProvider, TTSOptions } from "../types";

class WorkersAITTS implements TTSProvider {
  constructor(private ai: Ai) {}
  async synthesize(text: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const model = options?.voice?.startsWith("aura-2") ? "@cf/deepgram/aura-2-en" : "@cf/deepgram/aura-1";
    const response = await this.ai.run(model, { text, ...(options?.voice && { voice: options.voice }) });
    return response as ArrayBuffer;
  }
}

class GatewayTTS implements TTSProvider {
  constructor(private gatewayUrl: string, private provider: string, private apiKey: SecretStoreSecret) {}
  async synthesize(text: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const url = `${this.gatewayUrl}/custom-${this.provider}/v1/audio/speech`;
    const apiKey = await this.apiKey.get();
    const model = this.provider === "mimo" ? "mimo-v2.5-tts" : options?.voice || "tts-1";
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, input: text, voice: options?.voice || "alloy" }) });
    if (!response.ok) throw new Error(`TTS provider ${this.provider} error: ${response.status}`);
    return response.arrayBuffer();
  }
}

class OpenAITTS implements TTSProvider {
  constructor(private gatewayUrl: string, private apiKey: SecretStoreSecret) {}
  async synthesize(text: string, options?: TTSOptions): Promise<ArrayBuffer> {
    const url = `${this.gatewayUrl}/openai/v1/audio/speech`;
    const apiKey = await this.apiKey.get();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: "tts-1", input: text, voice: options?.voice || "alloy" }) });
    if (!response.ok) throw new Error(`OpenAI TTS error: ${response.status}`);
    return response.arrayBuffer();
  }
}

export function createTTSProvider(env: Env, provider?: string): TTSProvider {
  const p = provider || env.TTS_PROVIDER || "workers-ai";
  switch (p) {
    case "workers-ai": return new WorkersAITTS(env.AI);
    case "mimo": if (!env.MIMO_API_KEY) throw new Error("MIMO_API_KEY not set"); return new GatewayTTS(env.AI_GATEWAY_URL, "mimo", env.MIMO_API_KEY);
    case "openai": if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set"); return new OpenAITTS(env.AI_GATEWAY_URL, env.OPENAI_API_KEY);
    case "xai": if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not set"); return new GatewayTTS(env.AI_GATEWAY_URL, "xai", env.XAI_API_KEY);
    default: return new WorkersAITTS(env.AI);
  }
}