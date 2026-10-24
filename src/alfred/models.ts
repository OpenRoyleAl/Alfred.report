/**
 * Model routing for Alfred: one gateway (alfred-report), the primary Workers AI model first,
 * then AI Gateway Auto Router, then the Workers AI floor. Every call goes through env.AI.run with
 * the gateway option, so every request lands in the same gateway logs. No client-side SDK.
 */
import { BRAND } from "../brand.ts";
import {
  LIMITER,
  limiterAvailable,
  limiterCooldown,
  limiterTake,
  modelsFloor,
  modelsHeaders,
  modelsPrimary,
  modelsRateLimited,
  modelsText,
} from "./core.ts";

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
  return modelsRateLimited(String((err as Error)?.message || err));
}

function list(v: string | undefined, fallback: string[]): string[] {
  const items = (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

import { gatewayId } from "./gateway.ts";
export { gatewayId };

export function routerHeaders(env: ModelEnv): Record<string, string> {
  return modelsHeaders(env.AUTO_ALLOWED_PROVIDERS || "", env.AUTO_ALLOWED_MODELS || "");
}

export function floorModels(env: ModelEnv, limiter: RpmLimiter = deepseekLimiter): string[] {
  return modelsFloor(list(env.WORKERS_AI_FLOOR, DEFAULT_FLOOR), limiter.available());
}

export function primaryModel(env: ModelEnv): string | null {
  return modelsPrimary(env.MISSIONS_MODEL);
}

function textOf(r: unknown): { text: string; tokens: number } {
  return modelsText(r ?? {});
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

/** Auto Router (`cloudflare/auto`) on the gateway, pool restricted by cf-aig-allowed-* headers. */
async function runAuto(env: ModelEnv, system: string, user: string, opts: { maxTokens?: number; sessionId?: string }) {
  try {
    const r = await env.AI.run(
      AUTO_MODEL_ID as never,
      { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: opts.maxTokens ?? 400 } as never,
      {
        gateway: { id: gatewayId(env), metadata: { app: BRAND.slug } },
        extraHeaders: { ...routerHeaders(env), ...(opts.sessionId ? { "cf-aig-session-id": opts.sessionId } : {}) },
      } as never
    );
    const { text, tokens } = textOf(r);
    return text.trim() ? { text, model: AUTO_MODEL_ID, totalTokens: tokens } : null;
  } catch {
    return null;
  }
}

/** One-shot completion helper (KISS chat lane, missions LLM): primary, then Auto Router, then the floor. */
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
  const auto = await runAuto(env, system, user, opts);
  if (auto) return auto;
  for (const m of modelsFloor(floorModels(env), true, primary)) {
    const r = await runPrimary(env, m, system, user, opts);
    if (r) return r;
  }
  throw new Error("all models failed (primary, auto router, floor)");
}
