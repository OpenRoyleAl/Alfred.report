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
  durable_create(ptr: number, len: number): bigint;
  durable_plan(ptr: number, len: number): bigint;
  durable_recover(ptr: number, len: number): bigint;
  durable_next_alarm(ptr: number, len: number): bigint;
  durable_rank(ptr: number, len: number): bigint;
  durable_catalog(ptr: number, len: number): bigint;
  durable_fetch_check(ptr: number, len: number): bigint;
  durable_html_text(ptr: number, len: number): bigint;
  review_mission(ptr: number, len: number): bigint;
  durable_board_id(ptr: number, len: number): bigint;
  memory_profile(ptr: number, len: number): bigint;
  memory_query(ptr: number, len: number): bigint;
  memory_store(ptr: number, len: number): bigint;
  memory_shape(ptr: number, len: number): bigint;
  memory_op(ptr: number, len: number): bigint;
  nav_app_redirect(ptr: number, len: number): bigint;
  nav_safe_next(ptr: number, len: number): bigint;
  untrusted_wrap(ptr: number, len: number): bigint;
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
export type SearchStage = "start" | "after_ceramic" | "after_lite" | "after_exa" | "after_deep" | "after_fallback";
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

/** Throws unless the Rust allow-list says yes (fail closed on any other answer). */
export function mcpAllow(name: string, scopes: readonly string[], isOwner: boolean): void {
  const r = callJson<{ ok?: unknown }>("mcp_allow", { name, scopes, is_owner: isOwner });
  if (r?.ok !== true) throw new Error(`forbidden: ${name}`);
}

export function mcpTokenOk(bearer: string): boolean {
  return callJson<{ ok?: unknown }>("mcp_token_ok", { bearer }).ok === true;
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

// ─── Durable mission engine (crates/alfred-core/src/durable.rs) ─────────────

export interface DurableCreate {
  request_id: string;
  auto_request_id: boolean;
  receipt_key: string;
  mission_id: string;
  objective: string;
  kind: "mission" | "history_search";
  source: string;
  status: "queued" | "scheduled";
  run_at: number;
}
export interface DurableTask {
  id: string;
  seq: number;
  name: string;
  input?: unknown;
  output?: string | null;
  status: string;
  attempts: number;
}
export type DurablePlan =
  | { action: "call_model"; messages: Array<{ role: string; content: string }>; max_tokens: number }
  | { action: "run_tool"; name: string; args: Record<string, unknown>; replay_safe: boolean }
  | { action: "finish"; answer: string; evidence: string; uncited: string[] }
  | { action: "fail"; reason: string }
  | { action: "resume"; task_id: string; name: string };

export function durableCreate(input: {
  tenant: string;
  request_id?: string | null;
  fallback?: string[];
  objective: string;
  source?: string;
  kind?: string;
  run_at?: number | null;
  delay_seconds?: number | null;
  now: number;
  /** ALFRED_RECEIPT_KEY: HMAC key for derived ids (required; create fails closed without it). */
  mac_key: string;
}): DurableCreate {
  return callJson("durable_create", input);
}
export function durablePlan(input: { goal: string; kind: string; tasks: DurableTask[]; tenant_label?: string; lessons?: string[]; memory?: Array<{ id: string; summary: string }> }): DurablePlan {
  return callJson("durable_plan", input);
}
export function durableRecover(tasks: DurableTask[]): { retry: string[]; interrupt: string[]; fail: string[] } {
  return callJson("durable_recover", { tasks });
}
export function durableNextAlarm(missions: Array<{ status: string; run_at: number }>, now: number, busy: boolean): { at: number | null; reason: string } {
  return callJson("durable_next_alarm", { missions, now, busy });
}
export function durableRank(input: {
  query: string;
  exclude: string[];
  candidates: Array<{ id: string; goal: string; answer: string | null; kind: string; status: string; created_at: number }>;
  limit?: number;
}): { items: Array<{ id: string; score: number; goal: string; answer: string }>; text: string; terms: string[] } {
  return callJson("durable_rank", input);
}
export function durableCatalog(): Array<{ name: string; replay_safe: boolean; description: string }> {
  return callJson("durable_catalog", {});
}
export function durableFetchCheck(url: string): string {
  return callJson<{ url: string }>("durable_fetch_check", { url }).url;
}
export function durableHtmlText(html: string, limit = 4000): string {
  return callJson<{ text: string }>("durable_html_text", { html, limit }).text;
}

/** End-of-mission review (crates/alfred-core/src/review.rs); shared by Pi and durable missions. */
export function reviewCore<T>(input: unknown): T {
  return callJson<T>("review_mission", input);
}

/** Board (D1) mission id derived from a client requestId (idempotent create). */
export function durableBoardId(requestId: string, macKey: string): string {
  return callJson<{ id: string }>("durable_board_id", { request_id: requestId, mac_key: macKey }).id;
}

/** Where an app page goes: owner -> / (board), other signed-in -> /home, signed out -> /login/?next=<path> (decided in Rust). */
export function navAppRedirect(path: string, search: string, signedIn: boolean, owner = false): { location: string; alias: boolean } {
  return callJson<{ location: string; alias: boolean }>("nav_app_redirect", { path, search, signed_in: signedIn, owner });
}

/** Same-origin return path or /home (Rust rejects //host, backslashes, absolute URLs). */
export function navSafeNext(next: string | null | undefined): string {
  return callJson<{ next: string }>("nav_safe_next", { next: next ?? null }).next;
}

/** Fence a fetched page as untrusted data (Rust): fence markers neutralised, injection attempts flagged. */
export function untrustedWrap(url: string, status: number, text: string, limit = 8000): { text: string; flags: string[]; rule: string } {
  return callJson<{ text: string; flags: string[]; rule: string }>("untrusted_wrap", { url, status, text, limit });
}

/** The untrusted-content rule both engines put in their system prompt. */
export function untrustedRule(): string {
  return untrustedWrap("", 0, "", 0).rule;
}

// ─── Agent Memory policy (Rust: crates/alfred-core/src/memory.rs) ───
export interface MemoryStorePlan { store: boolean; reason: string; session_id: string; messages: Array<{ role: "user" | "assistant"; content: string }> }
export interface MemoryShape { answer: string; items: Array<{ id: string; summary: string; score: number }>; ids: string[]; tokens: number; budget: number }
export function memoryProfile(tenant: string, archive = false): string {
  return callJson<{ profile: string }>("memory_profile", { tenant, archive }).profile;
}
export function memoryQuery(text: string): string {
  return callJson<{ query: string }>("memory_query", { text }).query;
}
export function memoryStorePlan(input: { mission_id: string; objective: string; answer: string; evidence: string | null; lesson_ok: boolean; verdict: string; interrupted: number; tools: string[] }): MemoryStorePlan {
  return callJson("memory_store", input);
}
export function memoryShape(input: { answer: string; candidates: Array<{ id: string; summary: string; score: number }>; budget_tokens?: number | null }): MemoryShape {
  return callJson("memory_shape", input);
}
export function memoryOp<T>(op: "forget" | "remember" | "export" | "uncited", args: unknown): T {
  return callJson<T>("memory_op", { op, args });
}
