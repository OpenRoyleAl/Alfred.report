/**
 * Cost-aware web search router behind the single `web_search` tool. The model never chooses
 * the provider; escalation is cheapest-first:
 *
 *   Ceramic ($0.25 / 1k, Web Search API default)
 *     -> Exa Lite ($4 / 1k, Exa's own /search type "lite" via an AI Gateway custom provider,
 *        see ./exa-lite.ts) when Ceramic comes back thin
 *     -> Exa auto ($7 / 1k, the Exa mode the Web Search API exposes) when the query has deep
 *        intent up front, or Exa Lite was also thin / failed.
 *
 * Both Exa tiers bill the instance's own Exa key stored on its AI Gateway (EXA_KEY_ALIAS);
 * nothing falls back to credits and no key lives in code. They share one daily cap
 * (SEARCH_EXA_DAILY_LIMIT) and one 10 rps limiter (Exa's search limit).
 */
import type { WebSearchRequest, WebSearchResponse, WebSearchSource } from "agents/websearch";
import { exaRateLimiter, type RateLimiter } from "./exa-lite.ts";
import { searchAnalyze, searchPlan, type SearchItem, type SearchStage } from "./core.ts";

export type SearchProvider = "ceramic" | "exa-lite" | "exa";

/** List prices (Web Search API + exa.ai/pricing, Oct 2026). */
export const PRICE_PER_1K_USD: Record<SearchProvider, number> = { ceramic: 0.25, "exa-lite": 4.0, exa: 7.0 };

export const MIN_GOOD_RESULTS = 3;

// Decisions (terms, deep intent, coverage, thinness, next tier) run in Rust: crates/alfred-core.
const items = (res: WebSearchResponse): SearchItem[] => res.items.map((i) => ({ title: i.title, description: i.description ?? null, url: i.url }));

export function queryTerms(query: string): string[] {
  return searchAnalyze(query).terms;
}

/** True when the query reads like research that cheap search tends to answer poorly. */
export function wantsDeepSearch(query: string): boolean {
  return searchAnalyze(query).deep;
}

/** Share of query terms that appear in the results' titles/descriptions (0..1). */
export function termCoverage(query: string, res: WebSearchResponse): number {
  return searchAnalyze(query, items(res)).coverage;
}

/** Ceramic results too thin to answer from. */
export function isThin(query: string, res: WebSearchResponse): boolean {
  return searchAnalyze(query, items(res)).thin;
}

export interface ExaBudget {
  /** Exa searches spent today. */
  used(): number | Promise<number>;
  /** Record one Exa search. */
  spend(): void | Promise<void>;
}

export interface RouterOptions {
  ceramic: WebSearchSource;
  /** Exa Lite via the gateway custom provider. Undefined => skip the Lite tier. */
  exaLite?: WebSearchSource;
  /** Exa auto via the Web Search API. Undefined when no Exa key is configured. */
  exa?: WebSearchSource;
  budget: ExaBudget;
  exaDailyLimit: number;
  /** Shared Exa limiter (10 rps). Defaults to the per-isolate limiter. */
  limiter?: RateLimiter;
  /** Observability hook: which provider served the query and why. */
  onRoute?: (route: { query: string; provider: SearchProvider; reason: string }) => void;
}

export function createRoutedSearch(opts: RouterOptions): WebSearchSource {
  const limiter = opts.limiter ?? exaRateLimiter;
  const underCap = async () => opts.exaDailyLimit > 0 && (await opts.budget.used()) < opts.exaDailyLimit;
  type Call = Parameters<WebSearchSource["search"]>[1];
  const viaExa = async (tier: "exa-lite" | "exa", req: WebSearchRequest, call: Call, reason: string) => {
    const src = tier === "exa" ? opts.exa! : opts.exaLite!;
    await limiter.take();
    await opts.budget.spend();
    opts.onRoute?.({ query: req.query, provider: tier, reason });
    return src.search(req, call);
  };
  const better = (a: WebSearchResponse, b: WebSearchResponse) => (b.items.length >= a.items.length ? b : a);
  return {
    async search(req, call) {
      const base = { query: req.query, has_lite: Boolean(opts.exaLite), has_exa: Boolean(opts.exa) };
      let best: WebSearchResponse | null = null;
      let stage: SearchStage = "start";
      let failed = false;
      for (;;) {
        const plan = searchPlan({ ...base, stage, items: best ? items(best) : [], failed, under_cap: await underCap() });
        if (plan.action === "return") {
          if (stage === "after_ceramic" && plan.reason === "default") opts.onRoute?.({ query: req.query, provider: "ceramic", reason: "default" });
          return best ?? { items: [], metadata: { query: req.query } as never };
        }
        if (plan.action === "ceramic") {
          best = await opts.ceramic.search(req, call);
          stage = "after_ceramic";
          continue;
        }
        const tier = plan.action;
        failed = false;
        try {
          const r = await viaExa(tier, req, call, plan.reason);
          best = best ? better(best, r) : r;
          if (stage === "start") return best; // deep intent: Exa auto answers directly
        } catch (err) {
          if (stage === "start") throw err;
          failed = true;
        }
        stage = tier === "exa-lite" ? "after_lite" : "after_exa";
      }
    },
  };
}

/** In-memory daily counter (resets at UTC midnight); the Alfred DO persists its own. */
export function memoryBudget(now: () => number = Date.now): ExaBudget {
  let day = "";
  let n = 0;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  return {
    used() {
      if (day !== today()) { day = today(); n = 0; }
      return n;
    },
    spend() {
      if (day !== today()) { day = today(); n = 0; }
      n++;
    },
  };
}
