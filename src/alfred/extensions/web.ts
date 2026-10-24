/**
 * Web tools: web_search (one tool; provider chosen by the cost-aware router in ../search.ts:
 * Ceramic by default, then Exa Lite, then Exa auto, all on the gateway's Exa provider key), web_fetch, and
 * cf_docs_search (live Cloudflare docs, same backend as `cf docs search`).
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { webSearchTool } from "agents/websearch/pi";
import { webFetchTool } from "agents/webfetch/pi";
import { createAIWebSearch } from "agents/websearch";
import { gatewayId } from "../gateway.ts";
import { createRoutedSearch, memoryBudget, type ExaBudget } from "../search.ts";
import { createExaLiteSearch } from "../exa-lite.ts";
import type { SecretValue } from "../../lib/secret";
import { durableFetchCheck, untrustedWrap } from "../core.ts";

/**
 * fetch for the Pi web_fetch tool: the library already follows redirects by hand (redirect: "manual")
 * and calls this for every hop, so each hop passes the same Rust host allow-list as the durable engine.
 */
export function allowListedFetch(inner: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const checked = durableFetchCheck(href);
    return inner(checked, { ...init, redirect: "manual" });
  }) as typeof fetch;
}

/** Pi web_fetch: allow-listed hops, and the result fenced as untrusted data (same Rust wrap as durable). */
export function guardedWebFetchTool(env: { AI: Ai }, inner: typeof fetch = fetch): ToolRegistration {
  const base = webFetchTool({ binding: env.AI, fetch: allowListedFetch(inner), maxRedirects: 4 } as never) as unknown as ToolRegistration;
  return {
    ...base,
    async execute(input: never, api: never, context: never) {
      const r = (await (base.execute as (...a: unknown[]) => Promise<{ content?: Array<{ type: string; text?: string }> }>)(input, api, context)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      if (r?.isError || !Array.isArray(r?.content)) return r;
      const url = String((input as { url?: string })?.url || "");
      return {
        ...r,
        content: r.content.map((c) => (c.type === "text" && typeof c.text === "string" ? { ...c, text: untrustedWrap(url, 200, c.text, 20_000).text } : c)),
      };
    },
  } as ToolRegistration;
}

export interface WebEnv {
  AI: Ai;
  CLOUDFLARE_GATEWAY_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Alias of the Exa key in AI Gateway Provider Keys. Unset => Ceramic only. */
  EXA_KEY_ALIAS?: string;
  /** AI Gateway custom provider slug for Exa's own API (Exa Lite). Default "exa". */
  EXA_CUSTOM_PROVIDER?: string;
  /** cf-aig-authorization token for an authenticated gateway. */
  CF_AIG_TOKEN?: SecretValue;
  /** Max Exa escalations per day (default 200). */
  SEARCH_EXA_DAILY_LIMIT?: string;
}

/** Same public endpoint the `cf docs search` CLI (1.0.0-beta.19) calls; no login required. */
export const CF_DOCS_SEARCH_URL = "https://ai-search.developers.cloudflare.com/api/ai-search/search";

const CfDocsParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) });

export const cfDocsSearchTool: ToolRegistration<typeof CfDocsParams> = {
  name: "cf_docs_search",
  description:
    "Search live Cloudflare developer documentation (current betas, changelog, APIs). Returns up to 5 results " +
    "with title, description and url. Read a result with web_fetch (pages are served as Markdown).",
  parameters: CfDocsParams,
  replay: "safe",
  async execute({ query }, _api, context) {
    const signal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    const res = await fetch(CF_DOCS_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: query }],
        stream: false,
        ai_search_options: { retrieval: { metadata_only: true, max_num_results: 5 } },
      }),
      signal,
    });
    if (!res.ok) {
      return { output: [{ type: "text", text: `cf docs search failed (HTTP ${res.status}). Continue without it.` }], isError: true };
    }
    const body = (await res.json()) as {
      success?: boolean;
      result?: { chunks?: Array<{ item?: { key?: string; metadata?: { title?: string; description?: string } } }> };
    };
    const results = (body.result?.chunks || []).slice(0, 5).map((c) => {
      const key = c.item?.key || "";
      const url = new URL(key, "https://developers.cloudflare.com/").href;
      return {
        title: c.item?.metadata?.title || "Untitled",
        description: (c.item?.metadata?.description || "").slice(0, 400),
        url,
      };
    });
    const safe = results.filter((r) => r.url.startsWith("https://developers.cloudflare.com/"));
    return { output: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
  },
};

export function webTools(env: WebEnv, budget: ExaBudget = memoryBudget()): ToolRegistration[] {
  const gateway = gatewayId(env);
  const alias = (env.EXA_KEY_ALIAS || "").trim();
  const limit = Number.parseInt(env.SEARCH_EXA_DAILY_LIMIT || "200", 10);
  const source = createRoutedSearch({
    ceramic: createAIWebSearch({ binding: env.AI, gateway, provider: "ceramic" }),
    // byokAlias set => billed to the stored Exa key; the request fails instead of using credits.
    exaLite:
      // Stored keys need an authenticated gateway, so Exa Lite (plain HTTPS) needs CF_AIG_TOKEN.
      alias && env.CLOUDFLARE_ACCOUNT_ID && env.CF_AIG_TOKEN
        ? createExaLiteSearch({
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            gateway,
            slug: (env.EXA_CUSTOM_PROVIDER || "exa").trim(),
            alias,
            gatewayToken: env.CF_AIG_TOKEN,
          })
        : undefined,
    exa: alias ? createAIWebSearch({ binding: env.AI, gateway, provider: "exa", byokAlias: alias }) : undefined,
    budget,
    exaDailyLimit: Number.isFinite(limit) ? limit : 200,
  });
  return [
    webSearchTool({ source, limit: 6 }) as unknown as ToolRegistration,
    guardedWebFetchTool(env),
    cfDocsSearchTool as unknown as ToolRegistration,
  ];
}
