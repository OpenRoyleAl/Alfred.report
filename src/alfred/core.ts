/**
 * Bridge to the Rust core (crates/alfred-core, compiled to src/alfred/wasm/alfred_core.wasm).
 *
 * Search router, Exa Lite request/result shape, model floor/primary/429, The Report, MCP
 * token/scope/tool checks, and the Exa / DeepSeek sliding-window limiters run in Rust.
 * JSON over linear memory; one instance per isolate.
 *
 * `initCore` MUST be called from every Worker entry module (src/index.ts, apps/missions/src/index.ts,
 * apps/oral/src/worker.ts). A missing init was a Worker 1101 twice: the isolate imports the wasm
 * Module, but nothing instantiates it until initCore, and a later call then throws.
 * Tests load it from disk in scripts/test-core.ts. Do not rely on a side-effect import
 * (`package.json` has sideEffects=false, so bundlers tree-shake it).
 */
interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  search_plan(ptr: number, len: number): bigint;
  search_analyze(ptr: number, len: number): bigint;
  search_lite_url(ptr: number, len: number): bigint;
  search_lite_body(ptr: number, len: number): bigint;
  search_lite_parse(ptr: number, len: number): bigint;
  search_better(ptr: number, len: number): bigint;
  models_floor(ptr: number, len: number): bigint;
  models_primary(ptr: number, len: number): bigint;
  models_headers(ptr: number, len: number): bigint;
  models_rate_limited(ptr: number, len: number): bigint;
  models_text(ptr: number, len: number): bigint;
  report_build(ptr: number, len: number): bigint;
  report_speak(ptr: number, len: number): bigint;
  report_title(ptr: number, len: number): bigint;
  mcp_parse_scopes(ptr: number, len: number): bigint;
  mcp_tools(ptr: number, len: number): bigint;
  mcp_allow(ptr: number, len: number): bigint;
  mcp_token_ok(ptr: number, len: number): bigint;
  mcp_protocol(ptr: number, len: number): bigint;
  mcp_scopes(ptr: number, len: number): bigint;
  limiter_take(id: number, now: number): number;
  limiter_available(id: number, now: number): number;
  limiter_cooldown(id: number, until: number): void;
  limiter_config(id: number, cap: number, windowMs: number): void;
}

type JsonFn = {
  [K in keyof Exports]: Exports[K] extends (ptr: number, len: number) => bigint ? K : never;
}[keyof Exports];

export const LIMITER = { exa: 0, deepseek: 1 } as const;

let ex: Exports | null = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function initCore(mod: WebAssembly.Module): void {
  if (ex) return;
  ex = new WebAssembly.Instance(mod, {}).exports as unknown as Exports;
}

function core(): Exports {
  if (!ex) throw new Error("alfred-core wasm not initialised (call initCore from the entry module)");
  return ex;
}

function callJson<T>(fn: JsonFn, input: unknown): T {
  const c = core();
  const bytes = enc.encode(JSON.stringify(input));
  const ptr = c.alloc(bytes.length);
  new Uint8Array(c.memory.buffer, ptr, bytes.length).set(bytes);
  const packed = c[fn](ptr, bytes.length);
  c.dealloc(ptr, bytes.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const text = dec.decode(new Uint8Array(c.memory.buffer, outPtr, outLen));
  c.dealloc(outPtr, outLen);
  const v = JSON.parse(text) as T & { error?: string };
  if (v && typeof v === "object" && "error" in v && typeof v.error === "string") throw new Error(`alfred-core ${fn}: ${v.error}`);
  return v;
}

export interface SearchItem { title: string; description?: string | null; url: string }
export type SearchStage = "start" | "after_ceramic" | "after_lite" | "after_exa";
export interface SearchPlan {
  action: "ceramic" | "exa-lite" | "exa" | "return";
  reason: string;
  on_fail: "throw" | "continue";
  served?: SearchProvider;
  next_stage?: SearchStage;
}
export type SearchProvider = "ceramic" | "exa-lite" | "exa";

export function searchPlan(input: {
  query: string;
  stage: SearchStage;
  items?: SearchItem[];
  failed?: boolean;
  has_lite: boolean;
  has_exa: boolean;
  under_cap: boolean;
}): SearchPlan {
  return callJson<SearchPlan>("search_plan", input);
}

export function searchAnalyze(query: string, items: SearchItem[] = []): { terms: string[]; deep: boolean; coverage: number; thin: boolean } {
  return callJson("search_analyze", { query, items });
}

export function searchLiteUrl(accountId: string, gateway: string, slug: string): string {
  return callJson<string>("search_lite_url", { account_id: accountId, gateway, slug });
}

export function searchLiteBody(query: string, limit?: number): { query: string; type: "lite"; numResults: number } {
  return callJson("search_lite_body", { query, limit: limit ?? null });
}

export function searchLiteParse(raw: unknown): { items: SearchItem[]; requestId: string } {
  return callJson("search_lite_parse", raw);
}

export function searchBetter(a: SearchItem[], b: SearchItem[]): "a" | "b" {
  return callJson<{ pick: "a" | "b" }>("search_better", { a, b }).pick;
}

export function modelsFloor(models: string[], primaryAvailable: boolean, exclude?: string | null): string[] {
  return callJson<string[]>("models_floor", { models, primary_available: primaryAvailable, exclude: exclude ?? null });
}

export function modelsPrimary(missionsModel?: string | null): string | null {
  return callJson<string | null>("models_primary", { missions_model: missionsModel ?? "" });
}

export function modelsHeaders(providers: string, models: string): Record<string, string> {
  return callJson("models_headers", { providers, models });
}

export function modelsRateLimited(message: string): boolean {
  return callJson<{ limited: boolean }>("models_rate_limited", { message }).limited;
}

export function modelsText(body: unknown): { text: string; tokens: number } {
  return callJson("models_text", body ?? {});
}

export function reportBuild(input: unknown): unknown {
  return callJson("report_build", input);
}

export function reportSpeak(report: unknown): string {
  return callJson<string>("report_speak", report);
}

export function reportTitle(objective: string, words?: number): string {
  return callJson<string>("report_title", { objective, words: words ?? null });
}

export function mcpParseScopes(input: unknown): string[] {
  return callJson<string[]>("mcp_parse_scopes", { input });
}

export function mcpTools(scopes: readonly string[], isOwner: boolean): Array<Record<string, unknown>> {
  return callJson("mcp_tools", { scopes, is_owner: isOwner });
}

export function mcpAllow(name: string, scopes: readonly string[], isOwner: boolean): void {
  callJson<{ ok: boolean }>("mcp_allow", { name, scopes, is_owner: isOwner });
}

export function mcpTokenOk(bearer: string): boolean {
  return callJson<{ ok: boolean }>("mcp_token_ok", { bearer }).ok;
}

export function mcpProtocol(asked: string): string {
  return callJson<string>("mcp_protocol", { asked });
}

export function mcpScopes(): readonly string[] {
  return callJson<string[]>("mcp_scopes", {});
}

/** 0 = slot taken; otherwise ms to wait. */
export const limiterTake = (id: number, now = Date.now()) => core().limiter_take(id, now);
export const limiterAvailable = (id: number, now = Date.now()) => core().limiter_available(id, now) === 1;
export const limiterCooldown = (id: number, until: number) => core().limiter_cooldown(id, until);
export const limiterConfig = (id: number, cap: number, windowMs: number) => core().limiter_config(id, cap, windowMs);
