import { secretGet } from "./secret";
/**
 * Cloudflare AI Gateway — routes all LLM calls through the gateway
 * for telemetry, cost tracking, and per-tenant usage accounting.
 *
 * Fallback chain: MiMo (Hermes) → Workers AI (free daily) → Grok
 *
 * Gateway endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/
 * Providers are addressed as path segments: /openai/…, /workers-ai/…, /xai/…
 */

import type { Env } from "./env";
import { prepareMessagesForVision, type VisionMessage } from "./cf-images-vision";

// ─── Types ────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  /** Text string or multimodal parts (image_url after CF Images visionprep). */
  content: string | unknown;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  tenantId?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: LLMProvider;
  usage: TokenUsage;
  latencyMs: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export type LLMProvider = "mimo" | "workers-ai" | "grok";

// Cost per 1M tokens (input / output)
const COST_PER_MILLION: Record<LLMProvider, { input: number; output: number }> = {
  "mimo":       { input: 0.10,  output: 0.30  },  // MiMo via Hermes
  "workers-ai": { input: 0,     output: 0     },  // Free daily allocation
  "grok":       { input: 3.00,  output: 15.00 },  // xAI Grok
};


/**
 * Alfred-auto / Go Max Al!:
 * Workers AI free-first for text; vision → mimo-v2.6-flash then grok-4.7 (never stop on MiMo quota).
 * Heavy reason → grok-4.7.
 */
const MIMO_PRO = "mimo-v2.6-pro";
const MIMO_VISION = "mimo-v2.6-flash";
const GROK_DEFAULT = "grok-4.7";
const GROK_VISION = "grok-4.7";

function messageHasVision(messages: LLMMessage[]): boolean {
  for (const m of messages) {
    const c: unknown = (m as { content?: unknown }).content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "image_url") return true;
      }
    }
    if (typeof c === "string" && /data:image\/|!\[.*\]\(https?:/i.test(c)) return true;
  }
  return false;
}

function pickAlfredAutoModel(messages: LLMMessage[], requested?: string): { providerHint?: LLMProvider; model: string; vision?: boolean } {
  const req = (requested || "").trim();
  if (req && req !== "Alfred-auto" && req !== "alfred-auto" && req !== "auto") {
    if (req.startsWith("mimo-")) return { providerHint: "mimo", model: req, vision: messageHasVision(messages) };
    if (req.startsWith("grok-")) return { providerHint: "grok", model: req, vision: messageHasVision(messages) };
    if (req.startsWith("@cf/") || req.startsWith("workers-ai/")) return { providerHint: "workers-ai", model: req.replace(/^workers-ai\//, "") };
    return { model: req };
  }
  if (messageHasVision(messages)) return { providerHint: "mimo", model: MIMO_VISION, vision: true };
  // Free-first Workers AI; MIMO pro when caller elevates via options.model
  return { providerHint: "workers-ai", model: "" }; // empty → use workersAIModel in callProvider
}

// ─── Gateway Client ──────────────────────────────────────────

export class AIGateway {
  private gatewayBase: string;
  private hermesUrl: string;
  private hermesKey: string;
  private grokKey: string;
  private cfToken: string;
  private defaultModel: string;
  private workersAIModel: string;
  private keysReady: Promise<void> | null = null;

  constructor(private env: Env) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const gatewayId = env.CLOUDFLARE_GATEWAY_ID;

    if (!accountId || !gatewayId) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID must be configured");
    }

    this.gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
    this.hermesUrl = env.HERMES_API_URL || "https://hermes-api.openroyleal.com/v1";
    this.hermesKey = "";
    this.grokKey = "";
    this.cfToken = "";
    this.defaultModel = env.HERMES_MODEL || "mimo-v2.6-pro";
    this.workersAIModel = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  }

  private async ensureKeys(): Promise<void> {
    if (!this.keysReady) {
      this.keysReady = (async () => {
        this.hermesKey =
          (await secretGet(this.env.HERMES_API_KEY as any)) ||
          (await secretGet(this.env.MIMO_API_KEY as any)) ||
          "";
        this.grokKey =
          (await secretGet(this.env.XAI_API_KEY as any)) ||
          (await secretGet(this.env.GROK_API_KEY as any)) ||
          "";
        this.cfToken =
          (await secretGet(this.env.CF_API_TOKEN as any)) ||
          (await secretGet(this.env.CF_AIG_TOKEN as any)) ||
          "";
      })();
    }
    await this.keysReady;
  }

  /**
   * Primary entry point — tries providers in order with automatic fallback.
   * Returns content string for drop-in compatibility with HermesClient.chat().
   */
  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<string> {
    const result = await this.chatWithMeta(messages, options);
    return result.content;
  }

  /**
   * Like chat() but returns full telemetry alongside the content.
   */
  async chatWithMeta(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    await this.ensureKeys();
    const tenantId = options?.tenantId || "default";
    const errors: Array<{ provider: LLMProvider; error: string }> = [];
    const auto = pickAlfredAutoModel(messages, options?.model);
    const vision = Boolean(auto.vision || messageHasVision(messages));
    // Always-on CF Images visionprep before any multimodal LLM call.
    let outbound = messages;
    if (vision) {
      try {
        const { messages: prepped, meta } = await prepareMessagesForVision(
          this.env,
          messages as VisionMessage[],
        );
        outbound = prepped as LLMMessage[];
        if (meta.prepared || meta.failed) {
          console.info(
            `[ai-gateway] cf-images visionprep via=${meta.via} prepared=${meta.prepared} skipped=${meta.skipped} failed=${meta.failed}`,
          );
        }
      } catch (err) {
        console.warn(
          "[ai-gateway] cf-images visionprep error (continuing with originals):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Vision: never demote to text-only Workers AI — MiMo flash → Grok 4.7 multimodal.
    const order: LLMProvider[] = vision
      ? (["mimo", "grok"] as LLMProvider[])
      : auto.providerHint === "mimo"
        ? (["mimo", "workers-ai", "grok"] as LLMProvider[])
        : auto.providerHint === "grok"
          ? (["grok", "workers-ai", "mimo"] as LLMProvider[])
          : this.fallbackOrder();

    for (const provider of order) {
      try {
        const modelForProvider =
          provider === "mimo"
            ? auto.model || options?.model || (vision ? MIMO_VISION : MIMO_PRO)
            : provider === "grok"
              ? vision
                ? GROK_VISION
                : options?.model?.startsWith("grok-")
                  ? options.model
                  : GROK_DEFAULT
              : options?.model;
        const resolvedOpts: LLMOptions = {
          ...options,
          model: modelForProvider,
        };
        const result = await this.callProvider(provider, outbound, resolvedOpts);
        this.logTelemetry(result, tenantId).catch(() => {});
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ provider, error: msg });
        console.warn(`[ai-gateway] ${provider} failed: ${msg}`);
      }
    }

    throw new Error(
      `All LLM providers exhausted: ${errors.map(e => `${e.provider}: ${e.error}`).join("; ")}`
    );
  }

  /**
   * Convenience: parses LLM response as JSON. Drop-in for HermesClient.chatJSON().
   */
  async chatJSON<T>(messages: LLMMessage[], options?: LLMOptions): Promise<T> {
    const text = await this.chat(messages, { ...options, temperature: options?.temperature ?? 0.5 });
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("Failed to parse LLM response as JSON");
    }
  }

  /**
   * Returns usage totals for a tenant on a given date (YYYY-MM-DD).
   */
  async getUsage(tenantId: string, date: string): Promise<UsageTotals | null> {
    const key = `llm:totals:${tenantId}:${date}`;
    return (await this.env.CONFIG.get(key, "json")) as UsageTotals | null;
  }

  // ─── Provider Dispatch ──────────────────────────────────────

  private fallbackOrder(): LLMProvider[] {
    const order: LLMProvider[] = [];

    // MiMo first (cheapest) — requires Hermes key
    if (this.hermesKey) order.push("mimo");

    // Workers AI second (free) — always available with CF binding
    order.push("workers-ai");

    // Grok last (most expensive) — requires xAI key
    if (this.grokKey) order.push("grok");

    return order;
  }

  private async callProvider(
    provider: LLMProvider,
    messages: LLMMessage[],
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    switch (provider) {
      case "mimo":       return this.callMimo(messages, options);
      case "workers-ai": return this.callWorkersAI(messages, options);
      case "grok":       return this.callGrok(messages, options);
    }
  }

  // ─── MiMo (Hermes) ─────────────────────────────────────────

  private async callMimo(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    if (!this.hermesKey) throw new Error("Hermes API key not configured");

    const model = options?.model || this.defaultModel;
    const upstream = `${this.hermesUrl}/chat/completions`;

    return this.executeRequest("mimo", `${this.gatewayBase}/openai/chat/completions`, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.hermesKey}`,
        "cf-aig-custom-url": upstream,
        "User-Agent": "Alfred-Report/1.0",
      },
      body: {
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1024,
      },
    });
  }

  // ─── Workers AI (free daily) ────────────────────────────────

  private async callWorkersAI(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.workersAIModel;
    const token = this.cfToken;
    if (!token) throw new Error("No CF token available for Workers AI");

    return this.executeRequest("workers-ai", `${this.gatewayBase}/workers-ai/${encodeURIComponent(model)}`, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: {
        messages,
        max_tokens: options?.maxTokens ?? 1024,
        stream: false,
      },
    });
  }

  // ─── Grok (xAI) ────────────────────────────────────────────

  private async callGrok(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    if (!this.grokKey) throw new Error("Grok API key not configured");

    const model = options?.model || GROK_DEFAULT;

    return this.executeRequest("grok", `${this.gatewayBase}/xai/chat/completions`, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.grokKey}`,
        "User-Agent": "Alfred-Report/1.0",
      },
      body: {
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1024,
      },
    });
  }

  // ─── Core Request + Usage Extraction ────────────────────────

  private async executeRequest(
    provider: LLMProvider,
    url: string,
    opts: { headers: Record<string, string>; body: Record<string, unknown> },
  ): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${provider} error ${response.status}: ${text.substring(0, 200)}`);
      }

      const data: any = await response.json();

      // Hermes-specific error envelope
      if (data.hermes?.failed) {
        throw new Error(`Hermes upstream error: ${data.hermes.error || "unknown"}`);
      }

      const content = data.choices?.[0]?.message?.content || "";
      if (!content) throw new Error(`${provider} returned empty response`);

      const usage = this.extractTokenUsage(data, provider, opts.body.messages as LLMMessage[]);

      return {
        content,
        model: data.model || (opts.body.model as string) || "unknown",
        provider,
        usage,
        latencyMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractTokenUsage(
    data: any,
    provider: LLMProvider,
    messages: LLMMessage[],
  ): TokenUsage {
    const apiUsage = data.usage;
    const costs = COST_PER_MILLION[provider];

    // Use API-reported tokens when available; fall back to char-based estimate
    const promptTokens = apiUsage?.prompt_tokens ?? this.estimateTokens(
      messages.map(m => m.content).join(""),
    );
    const completionTokens = apiUsage?.completion_tokens ?? this.estimateTokens(
      data.choices?.[0]?.message?.content || "",
    );
    const totalTokens = promptTokens + completionTokens;

    const costUsd =
      (promptTokens * costs.input + completionTokens * costs.output) / 1_000_000;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    };
  }

  /**
   * ~4 chars per token — adequate for telemetry when providers don't report usage.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ─── Telemetry ──────────────────────────────────────────────

  private async logTelemetry(result: LLMResponse, tenantId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    // Rolling per-call log in KV (7-day TTL)
    const callKey = `llm:call:${tenantId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    const callEntry: TelemetryCall = {
      ts: new Date().toISOString(),
      provider: result.provider,
      model: result.model,
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
      cost_usd: result.usage.estimatedCostUsd,
      latency_ms: result.latencyMs,
      tenant_id: tenantId,
    };
    await this.env.CONFIG.put(callKey, JSON.stringify(callEntry), { expirationTtl: 86400 * 7 });

    // Increment daily aggregate counter
    const totalsKey = `llm:totals:${tenantId}:${today}`;
    const totals: UsageTotals =
      (await this.env.CONFIG.get(totalsKey, "json")) || this.emptyTotals();

    totals.calls += 1;
    totals.total_tokens += result.usage.totalTokens;
    totals.total_cost_usd += result.usage.estimatedCostUsd;
    totals.providers[result.provider] = (totals.providers[result.provider] || 0) + 1;

    await this.env.CONFIG.put(totalsKey, JSON.stringify(totals), { expirationTtl: 86400 * 90 });
  }

  private emptyTotals(): UsageTotals {
    return { calls: 0, total_tokens: 0, total_cost_usd: 0, providers: {} };
  }
}

// ─── Telemetry Types ─────────────────────────────────────────

export interface TelemetryCall {
  ts: string;
  provider: LLMProvider;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  tenant_id: string;
}

export interface UsageTotals {
  calls: number;
  total_tokens: number;
  total_cost_usd: number;
  providers: Partial<Record<LLMProvider, number>>;
}

// ─── Factory ─────────────────────────────────────────────────

export function createAIGateway(env: Env): AIGateway {
  return new AIGateway(env);
}
