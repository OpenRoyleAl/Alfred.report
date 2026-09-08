// src/cop/telemetry.ts — helper to instrument AI calls with COP telemetry
import type { Env } from "../types";
import { estimateCost, recordCop, recordCostEvent } from "./cop";

export async function withCop<T>(
  env: Env,
  meta: { userId: string; missionId: string; agent: string; provider: string; model: string; eventType: string; tokensIn?: number; tokensOut?: number; },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    recordCop(env, { ...meta, durationMs });
    await recordCostEvent(env, { ...meta, durationMs }).catch(() => {});
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    recordCop(env, { ...meta, durationMs, costUsd: 0 });
    throw err;
  }
}

export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
export { estimateCost };