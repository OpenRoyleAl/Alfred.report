import type { SecretValue } from "./secret";

/** Minimal shape of the Agent Memory binding we use (see agent-memory/api/workers-api). */
export interface AgentMemoryProfileLike {
  remember(m: { content: string; sessionId?: string | null }): Promise<{ id: string; summary: string }>;
  recall(
    q: string,
    o?: { thinkingLevel?: "low" | "medium" | "high"; responseLength?: "short" | "medium" | "long" }
  ): Promise<{ count: number; answer: string; candidates: Array<{ id: string; summary: string; score: number }> }>;
  ingest(
    messages: Iterable<{ role: "system" | "user" | "assistant"; content: string; timestamp?: Date }>,
    o?: { sessionId?: string | null }
  ): Promise<void>;
}
export interface AgentMemoryNamespaceLike {
  getProfile(name: string): Promise<AgentMemoryProfileLike>;
}

export interface Env {
  // Bindings
  ALFRED: DurableObjectNamespace<import("../alfred/agent").Alfred>;
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  /** Cloudflare Images binding — vision token prep (resize/encode, no LLM). */
  IMAGES?: {
    info: (stream: ReadableStream) => Promise<{
      format?: string;
      width?: number;
      height?: number;
      fileSize?: number;
    }>;
    input: (stream: ReadableStream) => {
      transform: (opts: {
        width?: number;
        height?: number;
        fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
      }) => {
        output: (opts: { format?: string; quality?: number }) => Promise<{
          response: () => Response;
          image: () => ReadableStream;
        }>;
      };
    };
  };
  EMAIL?: {
    send: (msg: {
      from: string | { name?: string; email: string };
      to: string | { name?: string; email: string };
      subject: string;
      text?: string;
      html?: string;
    }) => Promise<{ messageId?: string } | void>;
  };

  // AI Gateway (docs/CONFIG.md)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: SecretValue;

  // Scoped token for the domain availability check only (Account > Registrar > Read).
  // There is deliberately NO account-wide Cloudflare API token in this Worker.
  REGISTRAR_API_TOKEN?: SecretValue;

  // Cloudflare Agent Memory (binding, no token)
  MEMORY?: AgentMemoryNamespaceLike;
  // Model routing (see src/alfred/models.ts)
  AUTO_ALLOWED_MODELS?: string;
  AUTO_ALLOWED_PROVIDERS?: string;
  WORKERS_AI_FLOOR?: string;
  EXA_KEY_ALIAS?: string;
  EXA_CUSTOM_PROVIDER?: string;
  SEARCH_EXA_DAILY_LIMIT?: string;
  SANDBOX_ASKS_PER_DAY?: string;
  /** "clef" (default) or "clef-flash" for the route/escalate/done gates. */
  CLEF_MODEL?: string;

  // Identity (per-account vars) — see src/lib/access.ts
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAILS?: string;

  // GBP Service Account — set GOOGLE_SA_KEY as secret (full SA JSON)
  GOOGLE_SA_KEY?: SecretValue;
  GBP_SUBJECT?: string;

  // Ops bearer (acts as the first owner)
  ALFRED_OPS_TOKEN?: SecretValue;
  /** Session cookie signing key(s), "new,old" during rotation. */
  ALFRED_SESSION_KEY?: SecretValue;
  ALFRED_AGENT_TOKEN?: SecretValue;

  /** Alfred.report Missions Worker (apps/missions) - missions board, knowledge graph, workflows. */
  MISSIONS?: Fetcher;

  /** The customer's paid domain; display brand is `${DOMAIN}!` (src/brand.ts). */
  DOMAIN: string;

  // Google OAuth (Alfred.report login)
  GOOGLE_CLIENT_ID?: SecretValue;
  GOOGLE_CLIENT_SECRET?: SecretValue;
  JWT_SECRET?: SecretValue;

  // Stripe (domain at cost + $99/mo)
  STRIPE_KEY?: SecretValue;
  STRIPE_WEBHOOK_SECRET?: SecretValue;
  STRIPE_PRICE_USD_99?: string;
  STRIPE_PRICE_GBP_99?: string;
}
