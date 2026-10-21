/**
 * Alfred.report per-account configuration - the ONE typed schema.
 *
 * Every value an instance needs is declared here once. The cf configs
 * (deploy/web, apps/missions, apps/oral) take their vars and Secrets Store bindings from
 * it, and docs/CONFIG.md + alfred.config.example.json are generated from it
 * (`npm run config:docs`; the gate fails when they are stale).
 *
 * kinds:
 *   var      plain Worker variable
 *   secret   Secrets Store secret; binding name = secret name = key
 *   resource name/id of a Cloudflare resource behind a binding (not a variable)
 *   build    used only while deploying
 */
import { RESOURCES, WORKERS } from "../src/brand.ts";

export type App = "web" | "missions" | "oral";
export type Kind = "var" | "secret" | "resource" | "build";

export interface ConfigKey {
  kind: Kind;
  apps: readonly App[];
  description: string;
  required?: boolean;
  default?: string;
  example?: string;
}

const ALL: readonly App[] = ["web", "missions", "oral"];

export const SCHEMA = {
  // account / identity
  CLOUDFLARE_ACCOUNT_ID: { kind: "var", apps: ALL, required: true, description: "Cloudflare account that owns this instance (also used for the AI Gateway URL).", example: "<32-hex account id>" },
  SECRETS_STORE_ID: { kind: "build", apps: ALL, required: true, description: "Secrets Store holding every `secret` below.", example: "<secrets store id>" },
  DOMAIN: { kind: "var", apps: ["web", "oral"], required: true, description: "The customer's paid domain. Display brand is `<domain>!` (whatever.report!).", example: "whatever.report" },
  SECRET_NAMES: { kind: "build", apps: ALL, description: "Optional map of secret key -> Secrets Store secret name, for stores that already use other names.", example: '{"JWT_SECRET":"MY_JWT_SECRET"}' },
  SECRETS_ABSENT: { kind: "build", apps: ALL, description: "Comma list of optional secrets this account does not have (not bound; the feature that needs one stays off).", example: "GOOGLE_SA_KEY,REGISTRAR_API_TOKEN" },
  ZONE_NAME: { kind: "build", apps: ["web", "oral"], description: "Zone that holds DOMAIN, when it differs from DOMAIN." },
  OWNER_EMAILS: { kind: "var", apps: ["web", "missions", "oral"], required: true, description: "Comma-separated owner emails. Owners forward email and start missions; every other signed-in user gets a limited sandbox tenant.", example: "owner@example.com" },
  ACCESS_TEAM_DOMAIN: { kind: "var", apps: ["web", "oral"], required: true, description: "Cloudflare Access team domain used to verify sign-in JWTs.", example: "yourteam.cloudflareaccess.com" },
  ACCESS_AUD: { kind: "var", apps: ["web", "oral"], required: true, description: "AUD tag of the Access application in front of the instance.", example: "<access aud tag>" },

  // models and search
  CLOUDFLARE_GATEWAY_ID: { kind: "var", apps: ["web", "missions"], default: RESOURCES.gateway, description: "AI Gateway id. Every model and search call goes through it; provider keys (Exa, BYOK LLMs) live on the gateway." },
  AUTO_ALLOWED_MODELS: { kind: "var", apps: ["web", "missions"], description: "Auto Router candidate models (cf-aig-allowed-models). Default: the Workers AI pool in src/alfred/models.ts." },
  AUTO_ALLOWED_PROVIDERS: { kind: "var", apps: ["web", "missions"], description: "Auto Router providers (cf-aig-allowed-providers)." },
  WORKERS_AI_FLOOR: { kind: "var", apps: ["web", "missions"], description: "Comma list of @cf/ models tried when the routed call fails." },
  EXA_KEY_ALIAS: { kind: "var", apps: ["web"], description: "Alias of the Exa key in AI Gateway Provider Keys. Set it to let the search router escalate to Exa; unset means Ceramic only.", example: "default" },
  EXA_CUSTOM_PROVIDER: { kind: "var", apps: ["web"], default: "exa", description: "Slug of the AI Gateway custom provider for Exa's own API (base_url https://api.exa.ai, BYOK alias EXA_KEY_ALIAS). Enables the Exa Lite tier ($4/1k) between Ceramic and Exa auto." },
  SEARCH_EXA_DAILY_LIMIT: { kind: "var", apps: ["web"], default: "200", description: "Max Exa escalations per day per instance; past it the router stays on Ceramic." },
  MISSIONS_MODEL: { kind: "var", apps: ["web", "missions"], description: "Primary mission/coding model (Workers AI id) tried before Auto Router. Default DeepSeek V4.1 Flash; \"auto\" = Auto Router only." },
  CLEF_MODEL: { kind: "var", apps: ["web"], default: "clef", description: "Clef model for the route/escalate/done gates: clef, clef-flash or clef-omni (audio/video input always uses clef-omni)." },

  // limits
  SANDBOX_ASKS_PER_DAY: { kind: "var", apps: ["web", "oral"], default: "30", description: "Asks per day for a non-owner sandbox tenant (typed asks and ORAL voice turns share it)." },
  HOLD_NEW_MISSIONS: { kind: "var", apps: ["missions"], default: "0", description: "\"1\" refuses new missions (ops override header X-Alfred-Override: metering-bootstrap)." },

  // billing / integrations
  STRIPE_PRICE_USD_99: { kind: "var", apps: ["web"], description: "Stripe price id, USD plan." },
  STRIPE_PRICE_GBP_99: { kind: "var", apps: ["web"], description: "Stripe price id, GBP plan." },
  GBP_SUBJECT: { kind: "var", apps: ["web"], description: "Google Business Profile user to impersonate (only when GBP is used)." },

  // secrets (Secrets Store)
  ALFRED_OPS_TOKEN: { kind: "secret", apps: ["web", "missions"], description: "Ops bearer for automation; acts as the first OWNER_EMAILS entry." },
  ALFRED_AGENT_TOKEN: { kind: "secret", apps: ["web"], description: "Second owner bearer for the owner's own agents (deploy smoke tests). Revocable separately from ALFRED_OPS_TOKEN." },
  CF_AIG_TOKEN: { kind: "secret", apps: ["web", "missions"], description: "AI Gateway token (cf-aig-authorization) for an authenticated gateway." },
  A2A_BEARER_TOKEN: { kind: "secret", apps: ["missions"], description: "Bearer for external field agents on /a2a/*." },
  OWNER_WAKE_URL: { kind: "secret", apps: ["missions"], description: "Optional webhook that wakes the owner (mission complete / needs owner)." },
  OWNER_WAKE_AUTH: { kind: "secret", apps: ["missions"], description: "Bearer sent to OWNER_WAKE_URL." },
  JWT_SECRET: { kind: "secret", apps: ["web"], description: "Signs web session cookies." },
  GOOGLE_CLIENT_ID: { kind: "secret", apps: ["web"], description: "Google OAuth client id (Google sign-in)." },
  GOOGLE_CLIENT_SECRET: { kind: "secret", apps: ["web"], description: "Google OAuth client secret." },
  GOOGLE_SA_KEY: { kind: "secret", apps: ["web"], description: "Google service-account JSON (only when GBP is used)." },
  STRIPE_KEY: { kind: "secret", apps: ["web"], description: "Stripe secret key." },
  STRIPE_WEBHOOK_SECRET: { kind: "secret", apps: ["web"], description: "Stripe webhook signing secret." },
  REGISTRAR_API_TOKEN: { kind: "secret", apps: ["web"], description: "Cloudflare API token with Registrar Read (domain availability)." },

  // resources (an unset id lets cf deploy provision the resource)
  WEB_WORKER_NAME: { kind: "resource", apps: ["web", "oral"], default: WORKERS.web, description: "Web Worker name (ORAL binds its Alfred Durable Object)." },
  MISSIONS_WORKER_NAME: { kind: "resource", apps: ["web", "missions"], default: WORKERS.missions, description: "Missions Worker name (bound into web as MISSIONS)." },
  ORAL_WORKER_NAME: { kind: "resource", apps: ["oral"], default: WORKERS.oral, description: "ORAL (voice) Worker name." },
  AGENT_MEMORY_NAMESPACE: { kind: "resource", apps: ["web", "missions"], default: RESOURCES.memoryNamespace, description: "Agent Memory namespace (owner seed: scripts/seed-memory.mjs)." },
  WEB_D1_NAME: { kind: "resource", apps: ["web"], default: RESOURCES.webD1, description: "Web D1 database name." },
  WEB_D1_ID: { kind: "resource", apps: ["web"], description: "Web D1 database id (pin after the first deploy)." },
  MISSIONS_D1_NAME: { kind: "resource", apps: ["missions"], default: RESOURCES.missionsD1, description: "Missions D1 database name." },
  MISSIONS_D1_ID: { kind: "resource", apps: ["missions"], description: "Missions D1 database id (pin after the first deploy)." },
  MISSIONS_KV_ID: { kind: "resource", apps: ["missions"], description: "Missions KV namespace id (pin after the first deploy)." },
  MISSIONS_R2_BUCKET: { kind: "resource", apps: ["missions"], default: RESOURCES.missionsR2, description: "Missions R2 bucket." },
  MISSIONS_DO_PHASE: { kind: "build", apps: ["missions"], default: "live", description: "Durable Object cutover from the old Command Worker: \"receive\" (take AlfredCommand from LEGACY_COMMAND_WORKER_NAME), \"transfer-out\" (deploys the old Worker with the transferred tombstone), \"rename\" (AlfredCommand -> AlfredMissions), \"live\" (fresh installs and after cutover). See apps/missions/MIGRATION.md." },
  LEGACY_COMMAND_WORKER_NAME: { kind: "build", apps: ["missions"], default: "alfred-report-command", description: "Old Command Worker that still owns the AlfredCommand namespace (used only by MISSIONS_DO_PHASE=receive and transfer-out)." },
  MISSIONS_VECTORIZE_INDEX: { kind: "resource", apps: ["missions"], default: RESOURCES.missionsVectorize, description: "Missions Vectorize index." },
} as const satisfies Record<string, ConfigKey>;

export type ConfigName = keyof typeof SCHEMA;

export function keysFor(app: App, kind?: Kind): ConfigName[] {
  return (Object.keys(SCHEMA) as ConfigName[]).filter((k) => {
    const d: ConfigKey = SCHEMA[k];
    return d.apps.includes(app) && (!kind || d.kind === kind);
  });
}
