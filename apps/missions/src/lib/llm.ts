/**
 * Alfred.report Missions - model access and mission budgets.
 *
 * All model calls go through the shared router in src/alfred/models.ts: AI Gateway Auto
 * Router (`cloudflare/auto`) on the account's gateway with a Workers AI floor. Provider keys
 * (if any) live on the gateway as BYOK Provider Keys - this Worker holds no LLM API keys.
 */
import { AUTO_MODEL_ID, completeText, floorModels, gatewayId, routerHeaders, type ModelEnv } from "../../../../src/alfred/models";

export type LlmRole = "smart" | "simple" | "vision" | "image" | "tts" | "embed" | "speech";
export type CostClass = "free" | "byok" | "paid_workers" | "gateway";
export type SpeedNeed = "fast" | "normal" | "deep";
export type SpendClass = "metered" | "zero_compute" | "legacy_unmetered";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MissionBudget {
  max_tokens?: number;
  used_tokens?: number;
  max_neurons?: number;
  used_neurons?: number;
  prefer_free_workers_ai?: boolean;
  cost_class?: CostClass;
  speed?: SpeedNeed;
  model?: string;
  spend_usd?: number;
  max_usd?: number;
  spend_class?: SpendClass;
  spend_note?: string;
  /** Field agent that executes the mission (see NATIVE_AGENT_ID in src/brand.ts). */
  field_agent?: string;
  go_max?: boolean;
  go_max_at?: number;
  go_max_until?: number;
  legacy_backfill_at?: number;
}

export interface ChatOptions {
  role?: LlmRole;
  temperature?: number;
  max_tokens?: number;
  budget?: MissionBudget | null;
  mission_id?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  neurons_est?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: "auto_router";
  usage: TokenUsage;
  cost_class: CostClass;
}

export type LlmEnv = ModelEnv;

/** Workers AI free allocation per day (neurons). */
export const FREE_NEURONS_PER_DAY = 10_000;

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class ProviderBrokenError extends Error {
  readonly code = "PROVIDER_BROKEN";
  constructor(message: string) {
    super(message);
    this.name = "ProviderBrokenError";
  }
}

export function assertBudgetAllows(budget: MissionBudget | null | undefined): void {
  if (!budget) return;
  const usedT = budget.used_tokens ?? 0;
  if (typeof budget.max_tokens === "number" && usedT >= budget.max_tokens) {
    throw new BudgetExceededError(`token budget exhausted: used_tokens=${usedT} >= max_tokens=${budget.max_tokens}`);
  }
  const usedN = budget.used_neurons ?? 0;
  if (typeof budget.max_neurons === "number" && usedN >= budget.max_neurons) {
    throw new BudgetExceededError(`neuron budget exhausted: used_neurons=${usedN} >= max_neurons=${budget.max_neurons}`);
  }
  if (typeof budget.max_usd === "number" && typeof budget.spend_usd === "number" && budget.spend_usd >= budget.max_usd) {
    throw new BudgetExceededError(`usd budget exhausted: spend_usd=${budget.spend_usd} >= max_usd=${budget.max_usd}`);
  }
}

export function applyUsageToBudget(budget: MissionBudget | null | undefined, usage: TokenUsage, spendUsd = 0): MissionBudget | null {
  if (!budget) return null;
  return {
    ...budget,
    used_tokens: (budget.used_tokens ?? 0) + (usage.total_tokens ?? 0),
    used_neurons: (budget.used_neurons ?? 0) + (usage.neurons_est ?? 0),
    spend_usd: (budget.spend_usd ?? 0) + spendUsd,
    model: budget.model,
  };
}

export function defaultMissionBudget(partial?: Partial<MissionBudget>): MissionBudget {
  return {
    max_tokens: partial?.max_tokens ?? 50_000,
    used_tokens: partial?.used_tokens ?? 0,
    max_neurons: partial?.max_neurons ?? FREE_NEURONS_PER_DAY,
    used_neurons: partial?.used_neurons ?? 0,
    prefer_free_workers_ai: partial?.prefer_free_workers_ai ?? true,
    cost_class: partial?.cost_class ?? "gateway",
    speed: partial?.speed ?? "fast",
    spend_usd: partial?.spend_usd ?? 0,
    max_usd: partial?.max_usd,
    model: partial?.model,
    field_agent: partial?.field_agent,
    spend_class: partial?.spend_class,
    spend_note: partial?.spend_note,
    legacy_backfill_at: partial?.legacy_backfill_at,
  };
}

/** One chat turn through Auto Router. System messages become the system prompt. */
export async function chat(env: LlmEnv, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  assertBudgetAllows(opts.budget);
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const user =
    rest.length === 1 && rest[0].role === "user"
      ? rest[0].content
      : rest.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  try {
    const r = await completeText(env, system || "You are Alfred.report.", user, {
      maxTokens: opts.max_tokens ?? 1024,
      sessionId: opts.mission_id,
    });
    return {
      content: r.text,
      model: r.model,
      provider: "auto_router",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: r.totalTokens },
      cost_class: "gateway",
    };
  } catch (err) {
    throw new ProviderBrokenError(`model call failed: ${(err as Error).message}`);
  }
}

/** Chat expecting JSON (handles ```json fences). */
export async function chatJSON<T>(env: LlmEnv, messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  const r = await chat(env, messages, opts);
  const fenced = r.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : r.content).trim()) as T;
}

/** Small adapter with the chat/chatJSON shape the workers and workflows use. */
export function createChatClient(env: LlmEnv) {
  return {
    chat: async (messages: ChatMessage[], o?: { temperature?: number; max_tokens?: number }) =>
      (await chat(env, messages, { max_tokens: o?.max_tokens, temperature: o?.temperature })).content,
    chatJSON: <T>(messages: ChatMessage[], o?: { temperature?: number; max_tokens?: number }) =>
      chatJSON<T>(env, messages, { max_tokens: o?.max_tokens, temperature: o?.temperature }),
  };
}

export function routingTable(env: LlmEnv) {
  return {
    primary: AUTO_MODEL_ID,
    gateway: gatewayId(env),
    allowed: routerHeaders(env),
    floor: floorModels(env),
    keys: "BYOK Provider Keys on the AI Gateway (none in this Worker)",
  };
}

export async function healthProbe(env: LlmEnv): Promise<{ ok: boolean; model?: string; detail?: string; checked_at: number }> {
  try {
    const r = await completeText(env, "Reply with OK.", "ping", { maxTokens: 8 });
    return { ok: true, model: r.model, checked_at: Date.now() };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, checked_at: Date.now() };
  }
}
