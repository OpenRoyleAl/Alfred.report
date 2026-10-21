/**
 * Bridge to the Rust core (crates/alfred-core, compiled to src/alfred/wasm/alfred_core.wasm):
 * search-router decisions, the Exa / DeepSeek rate limiters and the model floor run in Rust.
 * JSON over linear memory; one instance per isolate. `initCore` is called once by the entry
 * module (src/index.ts and apps/missions/src/index.ts in the Workers, scripts/test-core.ts in tests).
 */
interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  search_plan(ptr: number, len: number): bigint;
  search_analyze(ptr: number, len: number): bigint;
  models_floor(ptr: number, len: number): bigint;
  limiter_take(id: number, now: number): number;
  limiter_available(id: number, now: number): number;
  limiter_cooldown(id: number, until: number): void;
  limiter_config(id: number, cap: number, windowMs: number): void;
}

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

function callJson<T>(fn: "search_plan" | "search_analyze" | "models_floor", input: unknown): T {
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
export interface SearchPlan { action: "ceramic" | "exa-lite" | "exa" | "return"; reason: string }

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

export function modelsFloor(models: string[], primaryAvailable: boolean, exclude?: string | null): string[] {
  return callJson<string[]>("models_floor", { models, primary_available: primaryAvailable, exclude: exclude ?? null });
}

/** 0 = slot taken; otherwise ms to wait. */
export const limiterTake = (id: number, now = Date.now()) => core().limiter_take(id, now);
export const limiterAvailable = (id: number, now = Date.now()) => core().limiter_available(id, now) === 1;
export const limiterCooldown = (id: number, until: number) => core().limiter_cooldown(id, until);
export const limiterConfig = (id: number, cap: number, windowMs: number) => core().limiter_config(id, cap, windowMs);
