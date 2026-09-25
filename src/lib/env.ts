import type { SecretValue } from "./secret";

export interface Env {
  // Bindings
  ALFRED: DurableObjectNamespace;
  DB: D1Database;
  VAULT: R2Bucket;
  CONFIG: KVNamespace;
  ORACLE960: VectorizeIndex;
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

  // AI Gateway — set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID, CF_AIG_TOKEN
  // as secrets via `wrangler secret put`
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: SecretValue;
  AI_GATEWAY_ID?: string;
  CLOUDFLARE_API_TOKEN?: SecretValue;
  GROK_API_KEY?: SecretValue;

  // Cloudflare Agent Memory — set CF_API_TOKEN, CF_ACCOUNT_ID as secrets
  CF_API_TOKEN?: SecretValue;
  CF_ACCOUNT_ID?: SecretValue;

  // GBP Service Account — set GOOGLE_SA_KEY as secret (full SA JSON)
  GOOGLE_SA_KEY?: SecretValue;
  GBP_SUBJECT?: string;

  // ORAL Command proxy
  ALFRED_OPS_TOKEN?: SecretValue;

  /** alfred-proxy lease broker (service binding) */
  ALFRED_PROXY?: Fetcher;

  // Provider config (vars)
  HERMES_API_URL: string;
  HERMES_API_KEY?: SecretValue;
  HERMES_MODEL?: string;
  WORKERS_AI_MODEL: string;

  // Domains
  DOMAIN: string;
  SIGNAL_DOMAIN: string;
  VAULT_DOMAIN: string;
  LEDGER_DOMAIN: string;

  // Google OAuth (Alfred.report login)
  GOOGLE_CLIENT_ID?: SecretValue;
  GOOGLE_CLIENT_SECRET?: SecretValue;
  GOOGLE_OAUTH_CLIENT_ID?: SecretValue;
  GOOGLE_OAUTH_CLIENT_SECRET?: SecretValue;
  JWT_SECRET?: SecretValue;

  // Stripe (domain at cost + $99/mo)
  STRIPE_SECRET_KEY?: SecretValue;
  STRIPE_KEY?: SecretValue;
  STRIPE_WEBHOOK_SECRET?: SecretValue;
  STRIPE_PRICE_USD_99?: string;
  STRIPE_PRICE_GBP_99?: string;
}
