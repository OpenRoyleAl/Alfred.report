/**
 * Exa Lite through the AI Gateway. The Web Search API (env.AI.websearch) only exposes Exa's
 * `auto` type, so Lite goes to Exa's own POST /search with `type: "lite"` via an AI Gateway
 * custom provider (slug EXA_CUSTOM_PROVIDER, base_url https://api.exa.ai). The Exa key never
 * touches this code: AI Gateway injects the stored provider key selected by
 * `cf-aig-byok-alias: EXA_KEY_ALIAS`. Every call is logged on the gateway like any model call.
 *
 * Exa search limit is 10 requests/second per key; `exaRateLimiter` keeps every Exa call
 * (Lite and auto) under it per isolate.
 */
import type { WebSearchSource, WebSearchResponse } from "agents/websearch";
import { secretGet, type SecretValue } from "../lib/secret.ts";
import { LIMITER, limiterTake } from "./core.ts";

export const EXA_RPS = 10;

export interface ExaLiteConfig {
  accountId: string;
  gateway: string;
  /** Custom provider slug as created on the gateway (without the `custom-` prefix). */
  slug: string;
  /** Provider key alias on the gateway. */
  alias: string;
  /** Optional cf-aig-authorization token for an authenticated gateway. */
  gatewayToken?: SecretValue;
  fetcher?: typeof fetch;
  limiter?: RateLimiter;
}

export interface RateLimiter {
  take(): Promise<void>;
}

/** Exa limiter in the Rust core (sliding 1 s window, 10 starts); extra callers wait. */
export function createRateLimiter(now: () => number = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): RateLimiter {
  return {
    async take() {
      for (;;) {
        const wait = limiterTake(LIMITER.exa, now());
        if (wait === 0) return;
        await sleep(wait);
      }
    },
  };
}

/** One limiter per isolate, shared by Exa Lite and Exa auto. */
export const exaRateLimiter: RateLimiter = createRateLimiter();

export function exaLiteUrl(c: Pick<ExaLiteConfig, "accountId" | "gateway" | "slug">): string {
  return `https://gateway.ai.cloudflare.com/v1/${c.accountId}/${c.gateway}/custom-${c.slug}/search`;
}

interface ExaResult {
  url: string;
  title?: string | null;
  text?: string | null;
  summary?: string | null;
  highlights?: string[] | null;
}

export function createExaLiteSearch(c: ExaLiteConfig): WebSearchSource {
  const f = c.fetcher ?? fetch;
  const limiter = c.limiter ?? exaRateLimiter;
  return {
    async search(req): Promise<WebSearchResponse> {
      await limiter.take();
      const started = Date.now();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cf-aig-byok-alias": c.alias,
      };
      const token = await secretGet(c.gatewayToken);
      if (token) headers["cf-aig-authorization"] = `Bearer ${token}`;
      // Lite accepts only `query` (plus result count); no filters.
      const body = { query: req.query, type: "lite", numResults: Math.min(Math.max(req.limit ?? 6, 1), 10) };
      const r = await f(exaLiteUrl(c), { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`exa-lite ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { requestId?: string; results?: ExaResult[] };
      return {
        items: (j.results ?? []).map((x) => ({
          url: x.url,
          title: x.title ?? x.url,
          description: (x.summary || x.highlights?.join(" ") || x.text || "").slice(0, 400),
        })),
        metadata: { query: req.query, requestId: j.requestId ?? "", latencyMs: Date.now() - started },
      };
    },
  };
}
