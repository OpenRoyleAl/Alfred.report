/**
 * web_search behind the one `web_search` tool: Ceramic and Exa queried IN PARALLEL, results
 * deduplicated by canonical URL and merged by reciprocal rank fusion (Rust, search.rs fuse).
 * Exa = Exa Lite (Exa's own /search type "lite" via the gateway's `exa` custom provider) when it
 * is configured, else Exa auto via the Web Search API. Both bill EXA_KEY_ALIAS on the gateway.
 *
 * Every kingdom uses the owner's Exa key, so Exa is metered per kingdom (search.rs quota_json):
 * the owner kingdom is unlimited, every other kingdom gets SEARCH_EXA_KINGDOM_DAILY per UTC day
 * and searches Ceramic only past it. If one provider fails, the other's results are returned.
 */
import type { WebSearchResponse, WebSearchSource } from "agents/websearch";
import { exaRateLimiter, type RateLimiter } from "./exa-lite.ts";
import { searchAnalyze, searchFuse, searchQuota, type FusedItem, type SearchItem, type SearchProvider } from "./core.ts";

export type { SearchProvider };

/** List prices (Web Search API + exa.ai/pricing, Oct 2026). */
export const PRICE_PER_1K_USD: Record<SearchProvider, number> = { ceramic: 0.25, "exa-lite": 4.0, exa: 7.0 };

export const MIN_GOOD_RESULTS = 3;

const items = (res: WebSearchResponse): SearchItem[] => res.items.map((i) => ({ title: i.title, description: i.description ?? null, url: i.url }));

export function queryTerms(query: string): string[] {
  return searchAnalyze(query).terms;
}
export function wantsDeepSearch(query: string): boolean {
  return searchAnalyze(query).deep;
}
export function termCoverage(query: string, res: WebSearchResponse): number {
  return searchAnalyze(query, items(res)).coverage;
}
export function isThin(query: string, res: WebSearchResponse): boolean {
  return searchAnalyze(query, items(res)).thin;
}

export interface ExaBudget {
  /** Exa searches this kingdom spent today. */
  used(): number | Promise<number>;
  /** Record one Exa search. */
  spend(): void | Promise<void>;
  /** Record one Ceramic search (usage log per kingdom). */
  ceramic?(): void | Promise<void>;
}

export interface SearchRoute {
  query: string;
  providers: Array<{ provider: SearchProvider; ok: boolean; count: number; error?: string }>;
  exa: { allowed: boolean; reason: string; used: number; cap: number | null };
  merged: number;
}

export interface ParallelOptions {
  ceramic: WebSearchSource;
  /** Exa Lite via the gateway custom provider (preferred Exa tier). */
  exaLite?: WebSearchSource;
  /** Exa auto via the Web Search API (used when Lite is not configured). */
  exa?: WebSearchSource;
  budget: ExaBudget;
  /** Default king: unlimited Exa. */
  owner: boolean;
  /** Daily Exa cap for other kingdoms (null/undefined = Rust default). */
  kingdomCap?: number | null;
  limiter?: RateLimiter;
  onRoute?: (route: SearchRoute) => void;
}

export function createParallelSearch(opts: ParallelOptions): WebSearchSource {
  const limiter = opts.limiter ?? exaRateLimiter;
  const exaTier: { name: SearchProvider; src: WebSearchSource } | null = opts.exaLite
    ? { name: "exa-lite", src: opts.exaLite }
    : opts.exa
      ? { name: "exa", src: opts.exa }
      : null;
  return {
    async search(req, call) {
      const used = Number(await opts.budget.used()) || 0;
      const q = searchQuota({ owner: opts.owner, used, cap: opts.kingdomCap ?? null, has_exa: Boolean(exaTier) });
      type Ran = { provider: SearchProvider; res?: WebSearchResponse; error?: string };
      const run = async (provider: SearchProvider, src: WebSearchSource, before?: () => Promise<void>): Promise<Ran> => {
        try {
          if (before) await before();
          return { provider, res: await src.search(req, call) };
        } catch (err) {
          return { provider, error: String((err as Error)?.message || err).slice(0, 200) };
        }
      };
      const jobs: Promise<Ran>[] = [run("ceramic", opts.ceramic, async () => void (await opts.budget.ceramic?.()))];
      if (q.exa && exaTier) {
        jobs.push(
          run(exaTier.name, exaTier.src, async () => {
            await limiter.take();
            await opts.budget.spend();
          })
        );
      }
      const ran = await Promise.all(jobs);
      const ok = ran.filter((r) => r.res);
      const route: SearchRoute = {
        query: req.query,
        providers: ran.map((r) => ({ provider: r.provider, ok: Boolean(r.res), count: r.res?.items.length ?? 0, ...(r.error ? { error: r.error } : {}) })),
        exa: { allowed: q.exa, reason: q.reason, used: q.exa && exaTier ? used + 1 : used, cap: q.cap },
        merged: 0,
      };
      if (!ok.length) {
        opts.onRoute?.(route);
        throw new Error(`web search failed: ${ran.map((r) => `${r.provider}: ${r.error}`).join("; ")}`);
      }
      const fused: FusedItem[] = searchFuse(ok.map((r) => ({ provider: r.provider, items: items(r.res!) })), req.limit ?? 6);
      route.merged = fused.length;
      opts.onRoute?.(route);
      return { items: fused.map((f) => ({ title: f.title, url: f.url, description: f.description ?? undefined, providers: f.providers })), metadata: { query: req.query } as never } as WebSearchResponse;
    },
  };
}

/** In-memory daily counter (resets at UTC midnight); the durable engine persists its own per kingdom. */
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
