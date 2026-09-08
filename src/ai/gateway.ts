// src/ai/gateway.ts — AI Gateway integration for external providers

import type { Env } from "../types";

export class AlfredAIGateway {
  private gatewayBase: string;

  constructor(private env: Env) {
    this.gatewayBase = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;
  }

  async workersAI(model: string, input: any): Promise<any> { return this.env.AI.run(model, input); }

  async openAI(model: string, messages: any[], options?: { temperature?: number; max_tokens?: number }): Promise<any> {
    const response = await fetch(`${this.gatewayBase}/openai/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, messages, ...options }) });
    if (!response.ok) throw new Error(`OpenAI Gateway error: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async mimo(model: string, messages: any[], options?: { temperature?: number; max_tokens?: number }): Promise<any> {
    const response = await fetch(`${this.gatewayBase}/custom-mimo/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.env.MIMO_API_KEY}` }, body: JSON.stringify({ model, messages, ...options }) });
    if (!response.ok) throw new Error(`MiMo Gateway error: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async xai(model: string, messages: any[], options?: { temperature?: number; max_tokens?: number }): Promise<any> {
    const response = await fetch(`${this.gatewayBase}/custom-xai/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.env.XAI_API_KEY}` }, body: JSON.stringify({ model, messages, ...options }) });
    if (!response.ok) throw new Error(`xAI Gateway error: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async chat(messages: any[], userId?: string, options?: { temperature?: number; max_tokens?: number }): Promise<any> {
    let provider = "workers-ai";
    if (userId) {
      const prefs = await this.env.DB.prepare(`SELECT tts_provider FROM user_preferences WHERE user_id = ?`).bind(userId).first<{ tts_provider: string }>();
      provider = prefs?.tts_provider || "workers-ai";
    }
    switch (provider) {
      case "workers-ai": return this.workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages, ...options });
      case "openai": return this.openAI("gpt-4o", messages, options);
      case "mimo": return this.mimo("mimo-latest", messages, options);
      case "xai": return this.xai("grok-3", messages, options);
      default: return this.workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages, ...options });
    }
  }

  async embed(text: string | string[]): Promise<number[]> {
    const texts = Array.isArray(text) ? text : [text];
    const response = await this.env.AI.run("@cf/baai/bge-m3", { text: texts }) as { data: number[][] };
    return response.data[0];
  }
}