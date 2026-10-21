/**
 * Loop guards for Pi tools.
 *
 * Every tool is wrapped so that, per mission:
 *  - a tool cannot run more than MAX_CALLS_PER_TOOL times,
 *  - the same tool with the same arguments cannot run more than MAX_IDENTICAL_CALLS times,
 *  - after MAX_CONSECUTIVE_FAILURES failures in a row a tool is blocked (no retry storms).
 * A blocked call returns an error result that tells the model to change approach,
 * and every call is recorded in SQLite (alfred_tool_events) for the end-of-mission review.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";

export interface GuardLimits {
  maxCallsPerTool: number;
  maxIdenticalCalls: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_LIMITS: GuardLimits = {
  maxCallsPerTool: 12,
  maxIdenticalCalls: 2,
  maxConsecutiveFailures: 3,
};

export interface ToolEvent {
  mission_id: string;
  tool: string;
  args_hash: string;
  ok: boolean;
  blocked: string | null;
  ms: number;
  at: number;
}

export interface GuardStore {
  missionId(): string;
  record(ev: ToolEvent): void;
  events(missionId: string, tool?: string): ToolEvent[];
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Small, fast, non-cryptographic hash (FNV-1a 32-bit) — only used to compare args. */
export function argsHash(args: unknown): string {
  const s = stableStringify(args);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Decide whether a call may run, given the mission's prior events for this tool. */
export function checkCall(prior: ToolEvent[], hash: string, limits: GuardLimits = DEFAULT_LIMITS): string | null {
  const ran = prior.filter((e) => !e.blocked);
  if (ran.length >= limits.maxCallsPerTool) return `max_calls:${limits.maxCallsPerTool}`;
  if (ran.filter((e) => e.args_hash === hash).length >= limits.maxIdenticalCalls) return "repeat_call";
  let streak = 0;
  for (let i = ran.length - 1; i >= 0 && !ran[i].ok; i--) streak++;
  if (streak >= limits.maxConsecutiveFailures) return `failure_streak:${streak}`;
  return null;
}

const BLOCK_HINT: Record<string, string> = {
  repeat_call: "You already ran this exact call. Use the earlier result or change the arguments/approach.",
  max_calls: "This tool hit its per-mission call limit. Finish with what you have or use a different tool.",
  failure_streak: "This tool keeps failing. Stop retrying it; report the blocker or try another approach.",
};

/**
 * Some tool packages (agents/websearch/pi, agents/webfetch/pi) return `content`, while
 * pi-durable reads `output`; without this the model sees "(no tool output)" and loops.
 */
export function normalizeResult(result: unknown): unknown {
  const r = result as { content?: unknown; output?: unknown } | null;
  if (r && typeof r === "object" && r.output === undefined && Array.isArray(r.content)) {
    const { content, ...rest } = r as { content: unknown[] } & Record<string, unknown>;
    return { ...rest, output: content };
  }
  return result;
}

export function guardTool<T extends ToolRegistration>(tool: T, store: GuardStore, limits: GuardLimits = DEFAULT_LIMITS): T {
  const execute = tool.execute.bind(tool);
  const wrapped = {
    ...tool,
    async execute(args: unknown, api: unknown, context: unknown) {
      const mission = store.missionId();
      const hash = argsHash(args);
      const blocked = checkCall(store.events(mission, tool.name), hash, limits);
      if (blocked) {
        store.record({ mission_id: mission, tool: tool.name, args_hash: hash, ok: false, blocked, ms: 0, at: Date.now() });
        const key = blocked.split(":")[0];
        return {
          output: [{ type: "text", text: `Blocked by loop guard (${blocked}). ${BLOCK_HINT[key] || ""}` }],
          isError: true,
        };
      }
      const started = Date.now();
      try {
        const result = (await (execute as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(args, api, context)) as {
          isError?: boolean;
        };
        store.record({
          mission_id: mission,
          tool: tool.name,
          args_hash: hash,
          ok: !result?.isError,
          blocked: null,
          ms: Date.now() - started,
          at: Date.now(),
        });
        return normalizeResult(result);
      } catch (err) {
        store.record({ mission_id: mission, tool: tool.name, args_hash: hash, ok: false, blocked: null, ms: Date.now() - started, at: Date.now() });
        throw err;
      }
    },
  };
  return wrapped as unknown as T;
}
