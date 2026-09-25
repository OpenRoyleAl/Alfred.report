import { secretGet } from "./secret";
import type { Env } from "./env";

export interface HermesMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class HermesClient {
  constructor(
    private apiUrl: string,
    private apiKey: string,
    private model: string = "mimo-v2.6-pro"
  ) {}

  async chat(messages: HermesMessage[], options?: { temperature?: number }): Promise<string> {
    if (!this.apiKey) {
      throw new Error("Hermes API key not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(`${this.apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "User-Agent": "Alfred-Report/1.0",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Hermes API error: ${response.status} ${body.substring(0, 200)}`);
      }

      const data: any = await response.json();

      // Check for Hermes gateway errors
      if (data.hermes?.failed) {
        throw new Error(`Hermes error: ${data.hermes.error || "unknown"}`);
      }

      return data.choices[0]?.message?.content || "";
    } finally {
      clearTimeout(timeout);
    }
  }

  async chatJSON<T>(messages: HermesMessage[], options?: { temperature?: number }): Promise<T> {
    const text = await this.chat(messages, { ...options, temperature: options?.temperature ?? 0.5 });
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("Failed to parse Hermes response as JSON");
    }
  }
}

export function createHermesClient(env: Env): HermesClient {
  // Route through CF AI Gateway when configured for full telemetry
  const gatewayId = env.CLOUDFLARE_GATEWAY_ID || env.AI_GATEWAY_ID || "alfred";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";

  let apiUrl = env.HERMES_API_URL || "https://token-plan-sgp.xiaomimimo.com/v1";

  // If AI Gateway is configured, route through it for telemetry
  if (accountId && gatewayId) {
    apiUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
  }

  return new HermesClient(
    apiUrl,
    (await secretGet(env.HERMES_API_KEY as any)) || "",
    env.HERMES_MODEL || "mimo-v2.6-pro"
  );
}
