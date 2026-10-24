/**
 * End-of-mission review — the gate in front of the lessons (self-improvement) store.
 *
 * Inputs: the mission's Pi transcript (its own session), the loop-guard tool events, and the
 * AI Gateway log of every model request in the mission (env.AI.gateway(id).getLog(logId)).
 * Flags: failed tool calls, loops (guard blocks or repeated identical calls), wasted tokens
 * (tokens spent on failed requests or on turns whose tool calls failed), unanswered runs,
 * and completion without evidence. A run with any blocking flag is quarantined: it is
 * stored for inspection but NEVER becomes a lesson.
 */
import type { ToolEvent } from "./guards";
import { reviewCore } from "./core.ts";

export interface GatewayLogSummary {
  id: string;
  model: string;
  success: boolean;
  status: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration: number;
}

export interface ReviewInput {
  missionId: string;
  status: "done" | "unanswered" | string;
  finalText: string;
  events: ToolEvent[];
  logs: GatewayLogSummary[];
  missingLogs: number;
  evidence: string | null;
  requireEvidence: boolean;
  /** Clef mission-done gate: decision, "unavailable", or undefined when the run did not finish. */
  clefDone?: { done: boolean; pDone: number; pEvidence: number } | "unavailable";
  /** Set when clef_escalate_check said a human must approve during this mission. */
  escalation?: string | null;
  /** Durable engine: steps interrupted by an eviction (outcome unknown). */
  interrupted?: number;
  /** Durable engine: sources cited without being fetched. */
  uncited?: string[];
}

export interface ReviewFlag {
  kind: "failed_tool" | "loop" | "wasted_tokens" | "unanswered" | "no_evidence" | "failed_request" | "logs_missing" | "clef_not_done" | "clef_unavailable" | "escalated" | "interrupted" | "uncited_source";
  blocking: boolean;
  detail: string;
}

export interface ReviewResult {
  missionId: string;
  verdict: "pass" | "fail";
  flags: ReviewFlag[];
  totals: { requests: number; tokens_in: number; tokens_out: number; cost: number; wasted_tokens: number; tool_calls: number; tool_failures: number };
  models: string[];
  /** Clef mission-done gate outcome (fed into The Report). Absent when the run never finished. */
  done?: { done: boolean; pDone: number; pEvidence: number } | "unavailable";
  /** Rust: pass + evidence + nothing interrupted. Only then may the run teach a lesson. */
  lessonOk: boolean;
}

export const WASTE_RATIO_LIMIT = 0.25;

/** The decision lives in Rust (crates/alfred-core/src/review.rs); this keeps the TS signature. */
export function reviewMission(input: ReviewInput): ReviewResult {
  return reviewCore<ReviewResult>(input);
}

/** Deep-scan Pi transcript entries for AI Gateway log ids (cloudflare diagnostics). */
export function collectLogIds(entries: unknown): string[] {
  const out = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.logId === "string" && o.logId) out.add(o.logId);
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(entries);
  return [...out];
}

export function summarizeLog(log: AiGatewayLog): GatewayLogSummary {
  return {
    id: log.id,
    model: log.model,
    success: !!log.success,
    status: log.status_code,
    tokens_in: log.tokens_in ?? 0,
    tokens_out: log.tokens_out ?? 0,
    cost: log.cost ?? 0,
    duration: log.duration,
  };
}
