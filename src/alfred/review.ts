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
}

export interface ReviewFlag {
  kind: "failed_tool" | "loop" | "wasted_tokens" | "unanswered" | "no_evidence" | "failed_request" | "logs_missing" | "clef_not_done" | "clef_unavailable" | "escalated";
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
}

export const WASTE_RATIO_LIMIT = 0.25;

export function reviewMission(input: ReviewInput): ReviewResult {
  const flags: ReviewFlag[] = [];
  const ran = input.events.filter((e) => !e.blocked);
  const failures = ran.filter((e) => !e.ok);
  const blocked = input.events.filter((e) => e.blocked);

  if (failures.length) {
    const byTool = new Map<string, number>();
    for (const f of failures) byTool.set(f.tool, (byTool.get(f.tool) || 0) + 1);
    flags.push({
      kind: "failed_tool",
      blocking: failures.length >= 3 || failures.length > ran.length / 2,
      detail: [...byTool].map(([t, n]) => `${t}×${n}`).join(", "),
    });
  }

  const repeats = new Map<string, number>();
  for (const e of ran) repeats.set(`${e.tool}:${e.args_hash}`, (repeats.get(`${e.tool}:${e.args_hash}`) || 0) + 1);
  const looped = [...repeats].filter(([, n]) => n >= 3);
  if (blocked.length || looped.length) {
    flags.push({
      kind: "loop",
      blocking: true,
      detail: [
        ...blocked.map((b) => `${b.tool} blocked (${b.blocked})`),
        ...looped.map(([k, n]) => `${k.split(":")[0]} identical ×${n}`),
      ].join("; "),
    });
  }

  const tokens = (l: GatewayLogSummary) => l.tokens_in + l.tokens_out;
  const failedReq = input.logs.filter((l) => !l.success || l.status >= 400);
  if (failedReq.length) {
    flags.push({ kind: "failed_request", blocking: false, detail: `${failedReq.length} gateway request(s) failed` });
  }
  const total = input.logs.reduce((s, l) => s + tokens(l), 0);
  // Attribute waste: failed requests + a share of tokens proportional to failed/blocked tool calls.
  const toolWasteShare = input.events.length ? (failures.length + blocked.length) / input.events.length : 0;
  const wasted = Math.round(failedReq.reduce((s, l) => s + tokens(l), 0) + (total - failedReq.reduce((s, l) => s + tokens(l), 0)) * toolWasteShare);
  if (total > 0 && wasted / total > WASTE_RATIO_LIMIT) {
    flags.push({ kind: "wasted_tokens", blocking: true, detail: `${wasted}/${total} tokens (${Math.round((wasted / total) * 100)}%) wasted` });
  }

  if (input.status !== "done" || !input.finalText.trim()) {
    flags.push({ kind: "unanswered", blocking: true, detail: `run status ${input.status}` });
  }
  if (input.requireEvidence && !input.evidence) {
    flags.push({ kind: "no_evidence", blocking: true, detail: "mission ended without mission_complete evidence" });
  }
  if (input.clefDone === "unavailable") {
    flags.push({ kind: "clef_unavailable", blocking: false, detail: "mission-done gate could not run" });
  } else if (input.clefDone && !input.clefDone.done) {
    flags.push({
      kind: "clef_not_done",
      blocking: true,
      detail: `clef done p=${input.clefDone.pDone.toFixed(2)}, evidence p=${input.clefDone.pEvidence.toFixed(2)}`,
    });
  }
  if (input.escalation) {
    // Correctly stopping for a human is not a failure, but it must not become a lesson.
    flags.push({ kind: "escalated", blocking: true, detail: input.escalation });
  }
  if (input.missingLogs > 0) {
    flags.push({ kind: "logs_missing", blocking: false, detail: `${input.missingLogs} gateway log(s) not retrievable` });
  }

  return {
    missionId: input.missionId,
    verdict: flags.some((f) => f.blocking) ? "fail" : "pass",
    flags,
    totals: {
      requests: input.logs.length,
      tokens_in: input.logs.reduce((s, l) => s + l.tokens_in, 0),
      tokens_out: input.logs.reduce((s, l) => s + l.tokens_out, 0),
      cost: Number(input.logs.reduce((s, l) => s + l.cost, 0).toFixed(6)),
      wasted_tokens: wasted,
      tool_calls: ran.length,
      tool_failures: failures.length,
    },
    models: [...new Set(input.logs.map((l) => l.model).filter(Boolean))],
    ...(input.clefDone !== undefined ? { done: input.clefDone } : {}),
  };
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
