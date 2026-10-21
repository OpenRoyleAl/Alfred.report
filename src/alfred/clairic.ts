/**
 * Clairic (@cf/cloudflare/clairic, Workers AI, preview 2026-10-19) typed extraction.
 *
 * Types follow the published schemas (developers.cloudflare.com/workers-ai/models/clairic/,
 * schema-input.json / schema-output.json, fetched 2026-10-20):
 *   - input key is `state` (a STRING; text answers are spans of it), not `input`.
 *   - `fields` is an OBJECT map name -> spec; types text | number | date | time | datetime |
 *     duration | list | estimate | forecast (no float/int/string). number uses integer/decimals;
 *     list requires `items`; estimate/forecast require min/max.
 *   - answers: `response.answers.<field>.value` (null when undetermined) + p_null, confidence.
 * Clairic cannot measure latency or cost: those come from AI Gateway logs (review.ts).
 */
import { gatewayId } from "./gateway.ts";

export type ClairicFieldType = "text" | "number" | "date" | "time" | "datetime" | "duration" | "list" | "estimate" | "forecast";
export type DurationUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years";

export interface ClairicField {
  type: ClairicFieldType;
  instructions?: string;
  unit?: string;
  integer?: boolean;
  decimals?: number;
  items?: "text" | "number" | "date";
  min?: number | string;
  max?: number | string;
  step?: number | "month" | "year";
  scale?: "linear" | "log";
  null_threshold?: number;
  horizon?: number;
  interval?: "step" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
}

export type ClairicImage = string | { content_type: string; base64: string };

export interface ClairicInput {
  model: "clairic";
  state?: string;
  fields: Record<string, ClairicField>;
  images?: ClairicImage[];
  reference_date?: string;
  options?: { include_quantiles?: boolean; return_state_text?: boolean };
}

export interface ClairicAnswer {
  type: string;
  value: unknown;
  guess?: unknown;
  p_null?: number;
  confidence?: number;
  span?: number[];
  spans?: number[][];
  mean?: unknown;
  median?: unknown;
  p10?: unknown;
  p90?: unknown;
}

export interface ClairicOutput {
  model: string;
  answers: Record<string, ClairicAnswer>;
  truncated: boolean;
  state_text?: string;
  usage: { input_tokens: number; output_tokens: number; state_tokens?: number; image_tokens?: number; schema_tokens?: number; passes?: number };
}

export const CLAIRIC_MODEL_ID = "@cf/cloudflare/clairic";
export const WHISPER_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";

export interface ClairicEnv { AI: Ai; CLOUDFLARE_GATEWAY_ID?: string }

/** Fields Alfred pulls out of any intake (voice, email, image) to draft a mission. */
export const MISSION_FIELDS: Record<string, ClairicField> = {
  objective: { type: "text", instructions: "The single thing being asked for, as written" },
  client: { type: "text", instructions: "Customer or company the request is for" },
  due_date: { type: "date", instructions: "Deadline date" },
  due_time: { type: "time", instructions: "Deadline time of day" },
  amount: { type: "number", decimals: 2, instructions: "Money amount mentioned (invoice, quote, budget)" },
  currency: { type: "text", instructions: "Currency of the amount (code or symbol)" },
  duration: { type: "duration", unit: "minutes", instructions: "How long the work or meeting takes" },
  people: { type: "list", items: "text", instructions: "Names of people involved" },
};

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function validateClairicInput(input: ClairicInput): string[] {
  const errs: string[] = [];
  const names = Object.keys(input.fields || {});
  if (!names.length) errs.push("fields: at least one");
  for (const n of names) {
    const f = input.fields[n];
    if (!FIELD_NAME.test(n)) errs.push(`field '${n}' name invalid`);
    if (f.type === "list" && !f.items) errs.push(`${n}: list needs items`);
    if ((f.type === "estimate" || f.type === "forecast") && (f.min === undefined || f.max === undefined)) errs.push(`${n}: ${f.type} needs min/max`);
    if (f.decimals !== undefined && (f.decimals < 0 || f.decimals > 6)) errs.push(`${n}: decimals 0..6`);
  }
  if (!input.state?.trim() && !(input.images?.length)) errs.push("state must be non-empty unless images are sent");
  if ((input.images?.length ?? 0) > 4) errs.push("images: max 4");
  return errs;
}

function aiRun(env: { AI: Ai }) {
  return env.AI.run as unknown as (m: string, i: unknown, o?: unknown) => Promise<unknown>;
}
const gw = (env: ClairicEnv) => ({ gateway: { id: gatewayId(env) } });

export async function runClairic(env: ClairicEnv, input: Omit<ClairicInput, "model">): Promise<ClairicOutput> {
  const body: ClairicInput = { model: "clairic", ...input };
  const errs = validateClairicInput(body);
  if (errs.length) throw new Error(`clairic input invalid: ${errs.join("; ")}`);
  return (await aiRun(env)(CLAIRIC_MODEL_ID, body, gw(env))) as ClairicOutput;
}

/** Voice: Clairic reads text, so audio is transcribed first (Workers AI Whisper large-v3-turbo). */
export async function transcribe(env: ClairicEnv, audioBase64: string): Promise<string> {
  const out = (await aiRun(env)(WHISPER_MODEL_ID, { audio: audioBase64, task: "transcribe" }, gw(env))) as { text?: string };
  return (out.text || "").trim();
}

export type IntakeSource =
  | { kind: "email"; subject?: string; from?: string; body: string }
  | { kind: "voice"; transcript?: string; audioBase64?: string }
  | { kind: "image"; images: ClairicImage[]; caption?: string };

export async function intakeState(env: ClairicEnv, src: IntakeSource): Promise<{ state: string; images?: ClairicImage[] }> {
  switch (src.kind) {
    case "email":
      return { state: [src.subject && `Subject: ${src.subject}`, src.from && `From: ${src.from}`, "", src.body].filter((x) => x !== undefined && x !== "").join("\n") };
    case "voice": {
      const text = src.transcript?.trim() || (src.audioBase64 ? await transcribe(env, src.audioBase64) : "");
      return { state: text };
    }
    case "image":
      return { state: src.caption || "", images: src.images.slice(0, 4) };
  }
}

export interface ExtractedField { value: unknown; confidence: number | null; p_null: number | null; needsReview: boolean }
export interface Extraction { fields: Record<string, ExtractedField>; needsReview: string[]; truncated: boolean }

/** Route uncertain fields to human review using Clairic's own p_null / confidence. */
export function summarizeExtraction(out: ClairicOutput, minConfidence = 0.6, maxPNull = 0.5): Extraction {
  const fields: Record<string, ExtractedField> = {};
  const needsReview: string[] = [];
  for (const [name, a] of Object.entries(out.answers || {})) {
    const confidence = typeof a.confidence === "number" ? a.confidence : null;
    const p_null = typeof a.p_null === "number" ? a.p_null : null;
    const uncertain = a.value !== null && a.value !== undefined && ((confidence !== null && confidence < minConfidence) || (p_null !== null && p_null > maxPNull));
    fields[name] = { value: a.value ?? null, confidence, p_null, needsReview: uncertain };
    if (uncertain) needsReview.push(name);
  }
  return { fields, needsReview, truncated: !!out.truncated };
}

export async function extractMission(env: ClairicEnv, src: IntakeSource, referenceDate = new Date().toISOString().slice(0, 10)) {
  const { state, images } = await intakeState(env, src);
  const out = await runClairic(env, { state, fields: MISSION_FIELDS, images, reference_date: referenceDate });
  return { state, ...summarizeExtraction(out) };
}
