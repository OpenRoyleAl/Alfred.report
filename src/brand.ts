/**
 * Alfred.report naming and branding - the single source of truth.
 * Imported by the Workers, the cf configs (cloudflare.config.ts) and Node scripts.
 * See docs/NAMING.md. Keep this file dependency-free (plain TS, no enums) so Node can
 * load it with type stripping.
 */
export const BRAND = {
  /** Platform display brand (display strings only; never in identifiers). */
  platformBrand: "Alfred.report!",
  /** Plain product name for identifiers-adjacent text (package descriptions, UA, logs). */
  name: "Alfred.report",
  /** Slug used for every Cloudflare resource and package name. */
  slug: "alfred-report",
  tagline: "Your chief of staff on your own Cloudflare account.",
  /** Default sender local part for outbound mail ("al@<domain>"). */
  senderLocalPart: "al",
  userAgent: "AlfredReport/1.0",
} as const;

/** Worker names (one per app). */
/**
 * Product flow (display terms). The wake word is the instance brand itself, derived from
 * DOMAIN (wakeWord): the owner of alfred.report says "Alfred.report!", the owner of
 * name.report says "name.report!". ORAL listens for it; WAKE returns The Report - a short,
 * voice-first status: success/fail per recent mission, a brief synopsis, what needs attention.
 * Go Max AI! escalates a mission.
 */
export const FLOW = {
  oral: "ORAL",
  wake: "WAKE",
  goMax: "Go Max AI!",
  report: "The Report",
} as const;

/** The wake word of an instance = its display brand ("name.report!"). */
export function wakeWord(domain: string): string {
  return instanceBrand(domain);
}

/** Alfred.report!'s role behind every instance (docs/display only). */
export const PLATFORM_ROLE = "Sovereign Custodian";

export const WORKERS = {
  web: "alfred-report",
  missions: "alfred-report-missions",
  oral: "alfred-report-oral",
} as const;

/** Durable Object classes (exported names) and their agent route names (kebab-case). */
export const DURABLE_OBJECTS = {
  /** Per-tenant Pi agent in the web Worker. */
  alfred: { className: "Alfred", binding: "ALFRED", route: "alfred" },
  /** Missions board / workflows coordinator in the Missions Worker. */
  missions: { className: "AlfredMissions", binding: "MISSIONS_AGENT", route: "alfred-missions" },
  /** ORAL (voice-listen stage) realtime agent in the ORAL Worker. */
  oral: { className: "AlfredOral", binding: "ORAL_AGENT", route: "alfred-oral" },
} as const;

/** Default per-account resource names (override any of them in config, see docs/CONFIG.md). */
export const RESOURCES = {
  gateway: "alfred-report",
  memoryNamespace: "alfred-report",
  webD1: "alfred-report",
  webR2: "alfred-report-vault",
  webVectorize: "alfred-report-memory",
  missionsD1: "alfred-report-command" /* legacy D1 name kept: D1 cannot be renamed in place */,
  missionsR2: "alfred-report-command-content",
  missionsVectorize: "alfred-report-command-index",
  sandboxR2: "alfred-report-sandbox",
} as const;

/** The built-in field agent (missions executed by Alfred.report itself on Cloudflare). */
export const NATIVE_AGENT_ID = "alfred";

/**
 * Field agents a mission can be delegated to. "alfred" is Alfred.report itself (Workers +
 * Pi); the others are external harnesses that claim/report missions over A2A.
 */
export const FIELD_AGENTS = ["alfred", "cursor", "pi", "grok-cli", "openclaw", "hermes", "mimocode"] as const;
export type FieldAgent = (typeof FIELD_AGENTS)[number];

export function normalizeFieldAgent(id: string | null | undefined): string {
  const v = String(id ?? "").trim().toLowerCase();
  return LEGACY_AGENT_IDS[v] ?? (v || NATIVE_AGENT_ID);
}
/** Retired ids still found in stored missions; normalized to NATIVE_AGENT_ID on read. */
export const LEGACY_AGENT_IDS: Record<string, string> = { oral: NATIVE_AGENT_ID };

/** Publisher (legal entity shown on the public site). */
export const PUBLISHER = { name: "OpenRoyleAl", url: "https://openroyleal.com" } as const;

/**
 * Display brand of one customer instance, from its own paid domain:
 * "whatever.report" -> "whatever.report!". Falls back to the platform brand.
 */
export function instanceBrand(domain: string | undefined | null): string {
  const d = String(domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return d ? `${d}!` : BRAND.platformBrand;
}

/**
 * Product framework: every customer instance is branded by the customer's own domain
 * ("whatever.report!"); Alfred.report! is the platform and Sovereign Custodian behind every instance.
 */
export interface BrandContext {
  /** e.g. "whatever.report!" */
  instanceBrand: string;
  /** Always "Alfred.report!" - the platform and Sovereign Custodian. */
  platformBrand: string;
  /** e.g. "whatever.report! - by Alfred.report!" */
  byline: string;
}

export function brandContext(env: { DOMAIN?: string }): BrandContext {
  const inst = instanceBrand(env.DOMAIN);
  const byline = inst === BRAND.platformBrand ? BRAND.platformBrand : `${inst} - by ${BRAND.platformBrand}`;
  return { instanceBrand: inst, platformBrand: BRAND.platformBrand, byline };
}
