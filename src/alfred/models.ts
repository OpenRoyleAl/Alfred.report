/**
 * Model routing for Alfred — AI Gateway Auto Router with a Workers AI floor.
 *
 * - Default model: `cloudflare/auto` on the account's gateway (default id from src/brand.ts RESOURCES.gateway).
 *   Auto Router picks per turn; `cf-aig-session-id` pins a model for a turn (prompt cache).
 * - The candidate pool is restricted with `cf-aig-allowed-models` / `cf-aig-allowed-providers`
 *   (docs: ai-gateway/features/auto-router). Default pool = Workers AI models only, because
 *   BYOK provider plans are exhausted; widen it per account via vars.
 * - Floor: if the router call fails before producing output, pi-ai's client-side fallback
 *   walks WORKERS_AI_FLOOR (Workers AI via env.AI.run — no keys, always available).
 *
 * `cloudflare/auto` is not in pi-ai's catalog, so we declare it as a Cloudflare model object
 * (api "cloudflare-ai"): the provider then calls env.AI.run("cloudflare/auto", ..., { gateway }),
 * which is exactly the documented Auto Router binding call. The provider is wrapped so a Pi
 * session (which stores provider + id) can resolve the model again after eviction.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAI } from "agents/models/pi-ai";
import { BRAND } from "../brand.ts";
import { LIMITER, limiterAvailable, limiterCooldown, limiterTake, modelsFloor } from "./core.ts";

export const AUTO_MODEL_ID = "cloudflare/auto";

/** Workers AI models that Auto Router lists as eligible "additional models" (2026-10 docs). */
/** Default missions/coding model: DeepSeek V4.1 Flash on Workers AI (1M ctx, tools; 20 req/min). */
export const DEEPSEEK_FLASH = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const DEEPSEEK_RPM = 20;

export const DEFAULT_AUTO_POOL = [
  DEEPSEEK_FLASH,
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/qwen/qwen3.8-27b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/openai/gpt-oss-20b",
];

/** Guaranteed floor, tried in order when the routed call fails before any output. */
export const DEFAULT_FLOOR = [DEEPSEEK_FLASH, "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.2", "@cf/openai/gpt-oss-20b"];

export interface ModelEnv {
  AI: Ai;
  CLOUDFLARE_GATEWAY_ID?: string;
  /** Comma list for cf-aig-allowed-models (wildcards allowed, e.g. "anthropic/*"). */
  AUTO_ALLOWED_MODELS?: string;
  /** Comma list for cf-aig-allowed-providers, e.g. "workers-ai,anthropic". */
  AUTO_ALLOWED_PROVIDERS?: string;
  /** Comma list of @cf/ ids for the floor. */
  WORKERS_AI_FLOOR?: string;
  /** Override the primary missions model (default DEEPSEEK_FLASH); "auto" = Auto Router only. */
  MISSIONS_MODEL?: string;
}

/** Rate limiter for a rate-limited Workers AI model; the window lives in the Rust core. */
export interface RpmLimiter {
  available(now?: number): boolean;
  take(now?: number): boolean;
  cooldown(ms?: number, now?: number): void;
}

export function rustLimiter(id: number): RpmLimiter {
  return {
    available: (now = Date.now()) => limiterAvailable(id, now),
    take: (now = Date.now()) => limiterTake(id, now) === 0,
    cooldown: (ms = 60_000, now = Date.now()) => limiterCooldown(id, now + ms),
  };
}
export const deepseekLimiter: RpmLimiter = rustLimiter(LIMITER.deepseek);

function isRateLimited(err: unknown): boolean {
  const m = String((err as Error)?.message || err);
  return /\b429\b|rate.?limit|capacity|too many requests/i.test(m);
}

function list(v: string | undefined, fallback: string[]): string[] {
  const items = (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

import { gatewayId } from "./gateway.ts";
export { gatewayId };

export function routerHeaders(env: ModelEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  const providers = (env.AUTO_ALLOWED_PROVIDERS || "").trim();
  if (providers) headers["cf-aig-allowed-providers"] = providers;
  headers["cf-aig-allowed-models"] = list(env.AUTO_ALLOWED_MODELS, DEFAULT_AUTO_POOL).join(",");
  return headers;
}

export function floorModels(env: ModelEnv, limiter: RpmLimiter = deepseekLimiter): string[] {
  return modelsFloor(list(env.WORKERS_AI_FLOOR, DEFAULT_FLOOR), limiter.available());
}

export function primaryModel(env: ModelEnv): string | null {
  const m = (env.MISSIONS_MODEL || DEEPSEEK_FLASH).trim();
  return m === "auto" || !m.startsWith("@cf/") ? null : m;
}

function textOf(r: unknown): { text: string; tokens: number } {
  const o = r as {
    response?: string;
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    usage?: { total_tokens?: number };
  };
  const text = o?.choices?.[0]?.message?.content ?? o?.choices?.[0]?.text ?? o?.response ?? "";
  return { text: String(text), tokens: o?.usage?.total_tokens ?? 0 };
}

/**
 * Direct call to the primary Workers AI model through the gateway. Stable prefix: the system
 * prompt is always message 0 (cacheable), volatile content goes last; the session id rides as
 * x-session-affinity so Workers AI reuses the prefix cache for the mission.
 */
export async function runPrimary(
  env: ModelEnv,
  model: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; sessionId?: string },
  limiter: RpmLimiter = deepseekLimiter
): Promise<{ text: string; model: string; totalTokens: number } | null> {
  if (model === DEEPSEEK_FLASH && !limiter.take()) return null;
  try {
    const r = await env.AI.run(
      model as never,
      { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: opts.maxTokens ?? 400 } as never,
      {
        gateway: { id: gatewayId(env), metadata: { app: BRAND.slug } },
        ...(opts.sessionId ? { extraHeaders: { "x-session-affinity": opts.sessionId } } : {}),
      } as never
    );
    const { text, tokens } = textOf(r);
    if (!text.trim()) return null;
    return { text, model, totalTokens: tokens };
  } catch (err) {
    if (model === DEEPSEEK_FLASH && isRateLimited(err)) limiter.cooldown();
    return null;
  }
}

export function createAlfredModels(env: ModelEnv) {
  const floor = floorModels(env);
  const ai = createAI({
    binding: env.AI,
    id: gatewayId(env),
    headers: routerHeaders(env),
    fallback: modelsFloor(floor, true, primaryModel(env)) as never,
    metadata: { app: BRAND.slug },
  } as never);

  const base = ai(floor[0] as never) as Model<Api>;
  const autoModel: Model<Api> = {
    ...base,
    id: AUTO_MODEL_ID,
    name: "Cloudflare Auto Router",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
  };

  const primary = primaryModel(env);
  const primaryDecl: Model<Api> | null = primary
    ? { ...base, id: primary, name: primary, contextWindow: primary === DEEPSEEK_FLASH ? 1_000_000 : base.contextWindow, maxTokens: 16_384 }
    : null;
  const inner = ai.provider;
  const provider = Object.create(inner) as typeof inner;
  Object.defineProperty(provider, "getModels", {
    value: () => {
      const listed = inner.getModels();
      const extra = [autoModel, ...(primaryDecl && !listed.some((m) => m.id === primaryDecl.id) ? [primaryDecl] : [])];
      return [...listed, ...extra];
    },
  });

  const models = createModels();
  models.setProvider(provider);

  // Missions default: the primary Workers AI model (DeepSeek V4.1 Flash) with the floor as
  // pi-ai's fallback chain (429 / capacity -> next Workers AI model). Auto Router only when
  // MISSIONS_MODEL=auto, so a turn never lands on a paid provider by surprise.
  const missionModel = primaryDecl ? (ai(primaryDecl as never) as Model<Api>) : (ai(autoModel as never) as Model<Api>);
  return {
    ai,
    models,
    missionModel,
    autoModel: ai(autoModel as never) as Model<Api>,
    floorModel: base,
    gateway: gatewayId(env),
  };
}

/** One-shot completion helper (KISS chat lane): Auto Router first, Workers AI floor on failure. */
export async function completeText(
  env: ModelEnv,
  system: string,
  user: string,
  opts: { maxTokens?: number; sessionId?: string } = {}
): Promise<{ text: string; model: string; totalTokens: number }> {
  const primary = primaryModel(env);
  if (primary) {
    const direct = await runPrimary(env, primary, system, user, opts);
    if (direct) return direct;
  }
  const { ai, autoModel } = createAlfredModels(env);
  const reply = await ai.completeSimple(
    autoModel as never,
    { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] } as never,
    { maxTokens: opts.maxTokens ?? 400, sessionId: opts.sessionId } as never
  );
  const r = reply as unknown as {
    content: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { totalTokens?: number; input?: number; output?: number };
  };
  const text = r.content.filter((p) => p.type === "text").map((p) => p.text || "").join("");
  const usage = r.usage || {};
  return {
    text,
    model: r.model || AUTO_MODEL_ID,
    totalTokens: usage.totalTokens ?? (usage.input || 0) + (usage.output || 0),
  };
}
