/**
 * Clef (@cf/cloudflare/clef, Workers AI) decision gates.
 *
 * Types follow the published schemas (developers.cloudflare.com/workers-ai/models/clef/,
 * schema-input.json / schema-output.json, fetched 2026-10-20):
 *   - `questions` is an OBJECT map id -> question (1..64), never an array.
 *   - question types: noul (yes/no, optional criteria {true,false}), choice (criteria: map
 *     option -> description, 2..255), score (criteria: ordered array, lowest first, 2..10).
 *   - answers come back under `response.answers.<id>`.
 * clef-omni (2026-10-09) adds `audio` (max 4) and `videos` (max 2) as data URLs or {content_type, base64}.
 * Billing per M input tokens: clef $0.24, clef-flash $0.038 (24K context), clef-omni $0.15; no output charge. Calls go through the account's AI Gateway
 * so they appear in the mission's gateway logs like every other model call.
 */
import { gatewayId } from "./gateway.ts";

export type ClefModel = "clef" | "clef-flash" | "clef-omni";

export interface ClefNoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: { true?: unknown; false?: unknown };
}
export interface ClefChoiceQuestion<O extends string = string> {
  type: "choice";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: Record<O, unknown>;
}
export interface ClefScoreQuestion {
  type: "score";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: unknown[];
}
export type ClefQuestion = ClefNoulQuestion | ClefChoiceQuestion | ClefScoreQuestion;

export type ClefImage = string | { content_type: "image/png" | "image/jpeg" | "image/webp"; base64: string };
/** clef-omni only (changelog 2026-10-09; schema-input.json): data:audio/... URL or {content_type, base64}. */
export type ClefAudio = string | { content_type: string; base64: string };
export type ClefVideo = string | { content_type: string; base64: string };

export interface ClefInput {
  model: ClefModel;
  state: unknown;
  questions: Record<string, ClefQuestion>;
  images?: ClefImage[];
  /** clef-omni: max 4 clips (8 MiB / 300 s each). */
  audio?: ClefAudio[];
  /** clef-omni: max 2 videos (16 MiB / 60 s each). */
  videos?: ClefVideo[];
}

export interface ClefNoulAnswer { type: "noul"; noul: number }
export interface ClefChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ClefScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type ClefAnswer = ClefNoulAnswer | ClefChoiceAnswer | ClefScoreAnswer;

export interface ClefOutput {
  model: string;
  answers: Record<string, ClefAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export const CLEF_MODEL_ID = "@cf/cloudflare/clef";
export const CLEF_FLASH_MODEL_ID = "@cf/cloudflare/clef-flash";
export const CLEF_OMNI_MODEL_ID = "@cf/cloudflare/clef-omni";
const MODEL_IDS: Record<ClefModel, string> = { clef: CLEF_MODEL_ID, "clef-flash": CLEF_FLASH_MODEL_ID, "clef-omni": CLEF_OMNI_MODEL_ID };

export interface ClefEnv {
  AI: Ai;
  CLOUDFLARE_GATEWAY_ID?: string;
  /** "clef" (default), "clef-flash" or "clef-omni". */
  CLEF_MODEL?: string;
}

export function validateClefInput(input: ClefInput): string[] {
  const errs: string[] = [];
  const ids = Object.keys(input.questions || {});
  if (ids.length < 1 || ids.length > 64) errs.push("questions: 1..64 required");
  for (const id of ids) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) errs.push(`question id '${id}' invalid`);
    const q = input.questions[id];
    if (q.type === "choice") {
      const n = Object.keys(q.criteria || {}).length;
      if (n < 2 || n > 255) errs.push(`${id}: choice needs 2..255 options`);
    }
    if (q.type === "score" && (q.criteria.length < 2 || q.criteria.length > 10)) errs.push(`${id}: score needs 2..10 levels`);
  }
  if ((input.images?.length ?? 0) > 4) errs.push("images: max 4");
  if (input.model !== "clef-omni" && (input.audio?.length || input.videos?.length)) errs.push("audio/videos need clef-omni");
  if ((input.audio?.length ?? 0) > 4) errs.push("audio: max 4");
  if ((input.videos?.length ?? 0) > 2) errs.push("videos: max 2");
  for (const a of input.audio ?? []) {
    const ok = typeof a === "string" ? a.startsWith("data:audio/") : a.content_type.startsWith("audio/");
    if (!ok) errs.push("audio: data:audio/... URL or audio/* content_type (no remote URLs)");
  }
  return errs;
}

export function clefModel(env: ClefEnv, requested?: ClefModel, hasMedia = false): ClefModel {
  if (requested) return requested;
  if (hasMedia) return "clef-omni";
  const m = env.CLEF_MODEL?.trim();
  return m === "clef-flash" || m === "clef-omni" ? m : "clef";
}

export async function runClef(env: ClefEnv, input: Omit<ClefInput, "model"> & { model?: ClefModel }): Promise<ClefOutput> {
  const model = clefModel(env, input.model, !!(input.audio?.length || input.videos?.length));
  const body: ClefInput = { ...input, model };
  const errs = validateClefInput(body);
  if (errs.length) throw new Error(`clef input invalid: ${errs.join("; ")}`);
  const id = MODEL_IDS[model];
  const gateway = gatewayId(env);
  // Not in @cloudflare/workers-types' AiModels yet; the shape above is the published schema.
  const run = env.AI.run.bind(env.AI) as unknown as (m: string, i: unknown, o?: unknown) => Promise<unknown>;
  try {
    return (await run(id, body, { gateway: { id: gateway } })) as ClefOutput;
  } catch (err) {
    // Gate must not silently vanish: log, then try once without the gateway hop.
    console.error(`clef via gateway ${gateway} failed: ${(err as Error).stack}`);
    return (await run(id, body)) as ClefOutput;
  }
}

// ─── Gates (question sets + pure decision functions, unit-tested) ───────────────

export const ROUTES = {
  chat: "A conversational question Alfred can answer directly from context, no tools needed",
  mission: "Work to carry out: create, change, check or deliver something, possibly with tools",
  research: "Needs current information from the web or documentation before answering",
  ops: "Account, billing, domain, deploy or security operation on the customer's Cloudflare account",
} as const;
export type Route = keyof typeof ROUTES;

export function routeQuestions(): Record<string, ClefQuestion> {
  return {
    route: { type: "choice", instructions: "How should Alfred handle this request?", criteria: { ...ROUTES } },
    needs_web: { type: "noul", instructions: "Does answering correctly require information newer than the model's training data?" },
  };
}

export interface RouteDecision { route: Route; confidence: number; needsWeb: boolean; fallback: boolean }
/** Low confidence => treat as a mission (the guarded, reviewed path) rather than a cheap chat. */
export function decideRoute(answers: Record<string, ClefAnswer>, minConfidence = 0.55): RouteDecision {
  const r = answers.route as ClefChoiceAnswer | undefined;
  const w = answers.needs_web as ClefNoulAnswer | undefined;
  const needsWeb = (w?.noul ?? 0) >= 0.5;
  if (!r || r.type !== "choice" || !(r.choice in ROUTES)) return { route: "mission", confidence: 0, needsWeb, fallback: true };
  if (r.confidence < minConfidence) return { route: "mission", confidence: r.confidence, needsWeb, fallback: true };
  return { route: r.choice as Route, confidence: r.confidence, needsWeb, fallback: false };
}

export const RISK_LEVELS = [
  "No risk: read-only or reversible inside Alfred",
  "Low: reversible change to the customer's own data",
  "Medium: visible to third parties or costs money, but reversible",
  "High: irreversible, legal, financial, security-sensitive or sent to a client",
];

export function escalateQuestions(): Record<string, ClefQuestion> {
  return {
    escalate: {
      type: "noul",
      instructions: "Should a human owner approve this before Alfred continues?",
      criteria: { true: "A person must decide or approve", false: "Alfred can proceed on its own" },
    },
    risk: { type: "score", instructions: "How risky is the next action?", criteria: RISK_LEVELS },
  };
}

export interface EscalateDecision { escalate: boolean; p: number; risk: number; reason: string }
export function decideEscalate(answers: Record<string, ClefAnswer>, pThreshold = 0.5, riskThreshold = 2): EscalateDecision {
  const e = answers.escalate as ClefNoulAnswer | undefined;
  const s = answers.risk as ClefScoreAnswer | undefined;
  const p = e?.type === "noul" ? e.noul : 1; // fail closed: no answer => escalate
  const risk = s?.type === "score" ? s.score : RISK_LEVELS.length - 1;
  const escalate = p >= pThreshold || risk >= riskThreshold;
  const reason = !e ? "no clef answer (fail closed)" : p >= pThreshold ? `escalate p=${p.toFixed(2)}` : risk >= riskThreshold ? `risk ${risk.toFixed(2)}` : "ok";
  return { escalate, p, risk, reason };
}

export function doneQuestions(): Record<string, ClefQuestion> {
  return {
    done: {
      type: "noul",
      instructions: "Did the agent fully accomplish the stated objective?",
      criteria: { true: "Objective met, nothing essential left undone", false: "Partial, wrong, or only planned" },
    },
    evidence_supports: {
      type: "noul",
      instructions: "Does the evidence actually show the work was done and verified (not just claimed)?",
    },
  };
}

export interface DoneDecision { done: boolean; pDone: number; pEvidence: number }
export function decideDone(answers: Record<string, ClefAnswer>, threshold = 0.7): DoneDecision {
  const d = answers.done as ClefNoulAnswer | undefined;
  const ev = answers.evidence_supports as ClefNoulAnswer | undefined;
  const pDone = d?.type === "noul" ? d.noul : 0;
  const pEvidence = ev?.type === "noul" ? ev.noul : 0;
  return { done: pDone >= threshold && pEvidence >= threshold - 0.1, pDone, pEvidence };
}

/** State object for the mission-done gate. Truncated; Clef truncates long text state itself too. */
export function doneState(objective: string, finalText: string, evidence: string | null) {
  return {
    objective: objective.slice(0, 4000),
    final_answer: finalText.slice(0, 12000),
    evidence: evidence ? evidence.slice(0, 4000) : "(none supplied)",
  };
}
