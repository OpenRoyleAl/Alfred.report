// src/voice/stt.ts — Provider-agnostic STT layer

import type { Env, SecretStoreSecret, STTProvider, STTOptions } from "../types";
import { Buffer } from "node:buffer";

class WorkersAISTT implements STTProvider {
  constructor(private ai: Ai) {}
  async transcribe(audio: ArrayBuffer, options?: STTOptions): Promise<string> {
    const response = await this.ai.run("@cf/openai/whisper-large-v3-turbo", {
      audio: Buffer.from(audio).toString("base64"),
      ...(options?.language && { language: options.language }),
    }) as { text: string };
    return response.text || "";
  }
}

class DeepgramSTT implements STTProvider {
  constructor(private ai: Ai) {}
  async transcribe(audio: ArrayBuffer, options?: STTOptions): Promise<string> {
    const response = await this.ai.run("@cf/deepgram/nova-3", { audio: Array.from(new Uint8Array(audio)) }) as { text: string };
    return response.text || "";
  }
}

class GatewaySTT implements STTProvider {
  constructor(private gatewayUrl: string, private provider: string, private apiKey: SecretStoreSecret) {}
  async transcribe(audio: ArrayBuffer, options?: STTOptions): Promise<string> {
    const url = `${this.gatewayUrl}/custom-${this.provider}/v1/audio/transcriptions`;
    const formData = new FormData();
    formData.append("file", new Blob([audio]), "audio.wav");
    formData.append("model", this.provider === "mimo" ? "mimo-v2.5-asr" : "whisper-1");
    const apiKey = await this.apiKey.get();
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: formData });
    if (!response.ok) throw new Error(`STT provider ${this.provider} error: ${response.status}`);
    const data = await response.json<{ text: string }>();
    return data.text || "";
  }
}

export function createSTTProvider(env: Env, provider?: string): STTProvider {
  const p = provider || env.STT_PROVIDER || "workers-ai";
  switch (p) {
    case "workers-ai": return new WorkersAISTT(env.AI);
    case "deepgram": return new DeepgramSTT(env.AI);
    case "openai": if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set"); return new GatewaySTT(env.AI_GATEWAY_URL, "openai", env.OPENAI_API_KEY);
    case "mimo": if (!env.MIMO_API_KEY) throw new Error("MIMO_API_KEY not set"); return new GatewaySTT(env.AI_GATEWAY_URL, "mimo", env.MIMO_API_KEY);
    default: return new WorkersAISTT(env.AI);
  }
}