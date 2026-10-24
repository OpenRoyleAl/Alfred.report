/**
 * Durable mission engine: thin TS glue around crates/alfred-core/src/durable.rs.
 *
 * One AlfredMissions instance per tenant (getAgentByName(env.MISSIONS_AGENT, "tenant:<id>")).
 * Everything lives in that object's SQLite: request receipts, missions, one task row per model
 * step / tool call, notes. Rust decides (receipt key, next step, recovery, next alarm, history
 * ranking); this file only does SQL, the DeepSeek call on the alfred-report gateway, fetch,
 * and the Agents SDK schedule that arms the alarm.
 *
 * Wake contract: every entry (onStart, RPC, the alarm callback) runs wake(): recover tasks a
 * dead isolate left `running` (replay-safe -> pending, others -> interrupted), then re-arm one
 * `durableWake` schedule at the Rust-computed time. durableWake is idempotent: a second fire
 * with nothing due is a no-op, and a mission already running in this isolate is skipped.
 */
import { secretGet } from "../../../src/lib/secret.ts";
import { kingdom, recallFor, type AMNamespace } from "../../../src/lib/agent-memory.ts";
import {
  durableCreate,
  durableNextAlarm,
  durablePlan,
  memoryStorePlan,
  memoryOp,
  durableRank,
  durableRecover,
  durableFetchCheck,
  untrustedWrap,
  durableHtmlText,
  modelsText,
  durableOp,
  type DurableTask,
} from "../../../src/alfred/core.ts";
import * as kg from "./lib/db.ts";
import { DEEPSEEK_FLASH, deepseekLimiter, gatewayId } from "../../../src/alfred/models.ts";
import { reviewMission, summarizeLog, type GatewayLogSummary, type ReviewResult } from "../../../src/alfred/review.ts";
import { decideDone, doneQuestions, doneState, runClef, type DoneDecision } from "../../../src/alfred/clef.ts";
import { createParallelSearch, type ExaBudget } from "../../../src/alfred/search.ts";
import { createExaLiteSearch } from "../../../src/alfred/exa-lite.ts";
import { createAIWebSearch, type WebSearchSource } from "agents/websearch";
import type { SecretValue } from "../../../src/lib/secret";

type Row = Record<string, SqlStorageValue>;

export interface DurableHost {
  ctx: DurableObjectState;
  env: DurableEnv;
  schedule(when: Date, callback: "durableWake"): Promise<unknown>;
  listSchedules(): Promise<Array<{ id: string; callback: string; time?: number }>>;
  cancelSchedule(id: string): Promise<boolean>;
}

export interface DurableEnv {
  AI: Ai;
  CLOUDFLARE_GATEWAY_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLEF_MODEL?: string;
  /** Same search config as the web Worker (config/schema.ts): Exa key lives on the gateway. */
  EXA_KEY_ALIAS?: string;
  EXA_CUSTOM_PROVIDER?: string;
  /** Daily Exa searches per non-owner kingdom (config/schema.ts); owner unlimited. */
  SEARCH_EXA_KINGDOM_DAILY?: string;
  CF_AIG_TOKEN?: SecretValue;
  /** HMAC key for derived mission ids (Secrets Store). */
  ALFRED_RECEIPT_KEY?: SecretValue;
  /** Version metadata binding: the Worker version id this isolate runs (recorded on every task). */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  MEMORY?: AMNamespace;
  /** Missions D1 (knowledge graph: records / edges / observations), owner-only tools. */
  DB?: D1Database;
}

export interface CreateArgs {
  tenant: string;
  objective: string;
  requestId?: string | null;
  fallback?: string[];
  source?: string;
  kind?: "mission" | "history_search";
  runAt?: number | null;
  delaySeconds?: number | null;
  requireEvidence?: boolean;
  /** Owner debug only: sleep before each step so an eviction can land mid-mission. */
  debugStepDelayMs?: number;
  /** Caller is the default king: owner-only tools (knowledge graph) are offered. Set by the web Worker. */
  owner?: boolean;
}

export interface MissionView {
  id: string;
  tenant: string;
  objective: string;
  kind: string;
  source: string;
  status: string;
  answer: string | null;
  error: string | null;
  request_id: string;
  run_at: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  wakes: number;
  evidence: string | null;
  verdict: string | null;
  review: ReviewResult | null;
  interrupted: number;
  /** Agent Memory: recalled ids this mission may cite (mem:<id>), and what happened on recall/store. */
  memory_ids: string[];
  memory_status: string | null;
  tasks?: Array<Record<string, unknown>>;
}

const FETCH_MAX_HOPS = 4;
const FETCH_MAX_BYTES = 400_000;

/** Fetch a public page: every hop (including redirects) must pass the Rust host allow-list. */
export async function fetchPublicPage(
  url: string,
  hopFetch: typeof fetch = fetch
): Promise<{ status: number; url: string; body: string }> {
  let current = durableFetchCheck(url);
  for (let hop = 0; hop < FETCH_MAX_HOPS; hop++) {
    const r = await hopFetch(current, {
      headers: { "User-Agent": "AlfredReport/1.0 (+durable)" },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("Location");
      if (!loc) throw new Error("redirect without location");
      current = durableFetchCheck(new URL(loc, current).href);
      continue;
    }
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > FETCH_MAX_BYTES) throw new Error("response too large");
    const body = (await r.text()).slice(0, FETCH_MAX_BYTES);
    return { status: r.status, url: current, body };
  }
  throw new Error("too many redirects");
}

const MAX_RUN_LOOP = 24;
/** Build stamp in /durable/stats (shows which code a live instance runs after a deploy). */
const ENGINE_BUILD = "durable-2026-10-24-onefold";
const MODEL_RETRY_MS = 5_000;
/** Work due within this window runs now (alarm clock skew / 1 s schedule resolution). */
const DUE_SLACK_MS = 1_000;

export class DurableEngine {
  private recovered = false;
  private inflight = new Set<string>();
  private ticking: Promise<void> | null = null;

  private h: DurableHost;
  constructor(h: DurableHost) {
    this.h = h;
  }

  private get sql() {
    return this.h.ctx.storage.sql;
  }
  private rows(q: string, ...b: SqlStorageValue[]): Row[] {
    return this.sql.exec(q, ...b).toArray() as Row[];
  }

  ensure(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_receipts (
      tenant TEXT NOT NULL, request_id TEXT NOT NULL, mission_id TEXT NOT NULL, source TEXT, created_at INTEGER,
      PRIMARY KEY (tenant, request_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_missions (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, objective TEXT NOT NULL, kind TEXT NOT NULL, source TEXT,
      status TEXT NOT NULL, answer TEXT, error TEXT, request_id TEXT, parent_task_id TEXT, owner_mission_id TEXT,
      run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      wakes INTEGER NOT NULL DEFAULT 0, debug_delay_ms INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_tasks (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, input TEXT,
      output TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, replay_safe INTEGER NOT NULL,
      parent_task_id TEXT, started_at INTEGER, finished_at INTEGER, UNIQUE (mission_id, seq))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_notes (id TEXT PRIMARY KEY, mission_id TEXT, text TEXT, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_wakes (at INTEGER, reason TEXT, recovered TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_lessons (id TEXT PRIMARY KEY, mission_id TEXT, lesson TEXT, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_search_usage (day TEXT PRIMARY KEY, exa INTEGER)`);
    // Opinion confidence per Agent Memory id (Rust rule in memory.rs) + weekly consolidation state.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_mem_confidence (id TEXT PRIMARY KEY, pass INTEGER NOT NULL, fail INTEGER NOT NULL, confidence REAL NOT NULL, last_mission TEXT, updated_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dm_meta (k TEXT PRIMARY KEY, v TEXT)`);
    // Additive columns (idempotent): evidence + review on missions, gateway log id on tasks.
    const cols = (t: string) => new Set(this.rows(`PRAGMA table_info(${t})`).map((r) => String(r.name)));
    const m = cols("dm_missions");
    for (const [c, ddl] of [
      ["evidence", "TEXT"],
      ["verdict", "TEXT"],
      ["review", "TEXT"],
      ["uncited", "TEXT"],
      ["require_evidence", "INTEGER NOT NULL DEFAULT 0"],
      ["debug_search", "TEXT"],
      ["memory", "TEXT"],
      ["memory_status", "TEXT"],
      ["owner", "INTEGER NOT NULL DEFAULT 0"],
    ] as const)
      if (!m.has(c)) this.sql.exec(`ALTER TABLE dm_missions ADD COLUMN ${c} ${ddl}`);
    const t = cols("dm_tasks");
    if (!cols("dm_search_usage").has("ceramic")) this.sql.exec(`ALTER TABLE dm_search_usage ADD COLUMN ceramic INTEGER NOT NULL DEFAULT 0`);
    if (!t.has("log_id")) this.sql.exec(`ALTER TABLE dm_tasks ADD COLUMN log_id TEXT`);
    // Worker version id that started / finished each task (proves which deploy ran it).
    if (!t.has("started_version")) this.sql.exec(`ALTER TABLE dm_tasks ADD COLUMN started_version TEXT`);
    if (!t.has("finished_version")) this.sql.exec(`ALTER TABLE dm_tasks ADD COLUMN finished_version TEXT`);
    if (!cols("dm_wakes").has("version")) this.sql.exec(`ALTER TABLE dm_wakes ADD COLUMN version TEXT`);
  }

  /** On every wake: recover once per isolate, then rebuild the alarm from stored work. */
  async wake(reason: string): Promise<void> {
    this.ensure();
    if (!this.recovered) {
      this.recovered = true;
      const stale = this.rows(`SELECT id, seq, name, output, status, attempts FROM dm_tasks WHERE status = 'running'`).map(taskOf);
      const orphaned = Number(this.rows(`SELECT COUNT(*) AS n FROM dm_missions WHERE status = 'running'`)[0]?.n ?? 0);
      if (stale.length || orphaned) {
        const r = stale.length ? durableRecover(stale) : { retry: [], interrupt: [], fail: [] };
        const now = Date.now();
        this.h.ctx.storage.transactionSync(() => {
          for (const id of r.retry) this.sql.exec(`UPDATE dm_tasks SET status = 'pending' WHERE id = ?`, id);
          for (const id of r.interrupt)
            this.sql.exec(`UPDATE dm_tasks SET status = 'interrupted', finished_at = ?, output = 'interrupted by eviction; not re-run (not replay-safe)' WHERE id = ?`, now, id);
          for (const id of r.fail) this.sql.exec(`UPDATE dm_tasks SET status = 'failed', finished_at = ?, output = 'gave up after eviction retries' WHERE id = ?`, now, id);
          this.sql.exec(`UPDATE dm_missions SET wakes = wakes + 1 WHERE status = 'running'`);
          this.sql.exec(`INSERT INTO dm_wakes (at, reason, recovered, version) VALUES (?, ?, ?, ?)`, now, reason, JSON.stringify({ ...r, orphaned_missions: orphaned }), this.version());
        });
      }
    }
    await this.rearm();
  }

  /** One `durableWake` schedule at the Rust-computed time (or none when idle). */
  async rearm(): Promise<{ at: number | null; reason: string }> {
    const now = Date.now();
    const missions = this.rows(`SELECT status, run_at FROM dm_missions WHERE status IN ('queued','scheduled','retry','running')`).map((m) => ({
      status: String(m.status),
      run_at: Number(m.run_at),
    }));
    // Finished-but-unreviewed missions are due work too (review runs from the alarm).
    const unreviewed = Number(this.rows(`SELECT COUNT(*) AS n FROM dm_missions WHERE kind = 'mission' AND status IN ('done','failed') AND review IS NULL`)[0]?.n ?? 0);
    if (unreviewed) missions.push({ status: "queued", run_at: now });
    const next = durableNextAlarm(missions, now, this.inflight.size > 0);
    const mine = (await this.h.listSchedules()).filter((s) => s.callback === "durableWake");
    // Agents SDK schedules have 1 s resolution (time is unix seconds): round UP so the alarm never
    // fires before the work is due. A row whose time has passed is the one executing now: never keep it.
    const want = next.at == null ? null : Math.ceil(Math.max(next.at, now + 250) / 1000) * 1000;
    const keep = want != null && mine.length === 1 && Number(mine[0].time ?? 0) * 1000 > now && Number(mine[0].time) * 1000 === want;
    if (!keep) {
      for (const s of mine) await this.h.cancelSchedule(s.id);
      if (want != null) await this.h.schedule(new Date(want), "durableWake");
    }
    return next;
  }

  /** Idempotent create: receipt + mission in one SQLite transaction. */
  async create(a: CreateArgs): Promise<{ missionId: string; requestId: string; duplicate: boolean; status: string; runAt: number }> {
    this.ensure();
    const now = Date.now();
    const macKey = await secretGet(this.h.env.ALFRED_RECEIPT_KEY);
    const c = durableCreate({
      mac_key: macKey,
      tenant: a.tenant,
      request_id: a.requestId ?? null,
      fallback: a.fallback ?? [],
      objective: a.objective,
      source: a.source ?? "web",
      kind: a.kind ?? "mission",
      run_at: a.runAt ?? null,
      delay_seconds: a.delaySeconds ?? null,
      now,
    });
    const debug = Math.max(0, Math.min(20_000, Math.floor(a.debugStepDelayMs ?? 0)));
    const out = this.h.ctx.storage.transactionSync(() => {
      const [had] = this.rows(`SELECT mission_id FROM dm_receipts WHERE tenant = ? AND request_id = ?`, a.tenant, c.request_id);
      if (had) {
        const [m] = this.rows(`SELECT status, run_at FROM dm_missions WHERE id = ?`, String(had.mission_id));
        return { missionId: String(had.mission_id), requestId: c.request_id, duplicate: true, status: String(m?.status ?? "unknown"), runAt: Number(m?.run_at ?? 0) };
      }
      this.sql.exec(`INSERT INTO dm_receipts VALUES (?, ?, ?, ?, ?)`, a.tenant, c.request_id, c.mission_id, c.source, now);
      this.sql.exec(
        `INSERT INTO dm_missions (id, tenant, objective, kind, source, status, request_id, run_at, created_at, debug_delay_ms, require_evidence, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.mission_id, a.tenant, c.objective, c.kind, c.source, c.status, c.request_id, c.run_at, now, debug, a.requireEvidence ? 1 : 0,
        a.owner ? 1 : 0
      );
      return { missionId: c.mission_id, requestId: c.request_id, duplicate: false, status: c.status, runAt: c.run_at };
    });
    await this.wake("create");
    return out;
  }

  get(id: string, withTasks = true): MissionView | null {
    this.ensure();
    const [m] = this.rows(`SELECT * FROM dm_missions WHERE id = ?`, id);
    if (!m) return null;
    const v = viewOf(m, this.interruptedOf(id));
    if (withTasks)
      v.tasks = this.rows(`SELECT id, seq, name, status, attempts, replay_safe, parent_task_id, started_at, finished_at, started_version, finished_version, log_id, substr(output, 1, 600) AS output FROM dm_tasks WHERE mission_id = ? ORDER BY seq`, id).map((t) => ({ ...t, replay_safe: Number(t.replay_safe) === 1 }));
    return v;
  }

  list(limit = 20, kind = "mission"): MissionView[] {
    this.ensure();
    return this.rows(`SELECT * FROM dm_missions WHERE kind = ? ORDER BY created_at DESC LIMIT ?`, kind, Math.min(100, limit)).map((m) =>
      viewOf(m, this.interruptedOf(String(m.id)))
    );
  }

  lessons(limit = 20) {
    this.ensure();
    return this.rows(`SELECT * FROM dm_lessons ORDER BY at DESC LIMIT ?`, Math.min(100, limit));
  }

  private interruptedOf(id: string): number {
    return Number(this.rows(`SELECT COUNT(*) AS n FROM dm_tasks WHERE mission_id = ? AND status = 'interrupted'`, id)[0]?.n ?? 0);
  }

  stats() {
    this.ensure();
    return {
      missions: this.rows(`SELECT status, COUNT(*) AS n FROM dm_missions GROUP BY status`),
      tasks: this.rows(`SELECT status, COUNT(*) AS n FROM dm_tasks GROUP BY status`),
      wakes: this.rows(`SELECT * FROM dm_wakes ORDER BY at DESC LIMIT 10`),
      receipts: Number(this.rows(`SELECT COUNT(*) AS n FROM dm_receipts`)[0]?.n ?? 0),
      search_usage: this.rows(`SELECT day, exa, ceramic FROM dm_search_usage ORDER BY day DESC LIMIT 7`),
      inflight: [...this.inflight],
      build: ENGINE_BUILD,
    };
  }

  /** Alarm callback body. Safe to call any number of times. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.wake("alarm");
        for (let guard = 0; guard < 50; guard++) {
          const now = Date.now();
          const [due] = this.rows(
            `SELECT id FROM dm_missions WHERE kind = 'mission' AND owner_mission_id IS NULL
               AND (status = 'running' OR (status IN ('queued','scheduled','retry') AND run_at <= ?)) ORDER BY run_at LIMIT 1`,
            now + DUE_SLACK_MS
          );
          const [dueSearch] = due ? [due] : this.rows(`SELECT id FROM dm_missions WHERE kind = 'history_search' AND owner_mission_id IS NULL AND (status = 'running' OR (status IN ('queued','retry') AND run_at <= ?)) LIMIT 1`, now + DUE_SLACK_MS);
          if (!dueSearch) {
            // Finished but never reviewed (evicted between finish and review): review now. Idempotent.
            const [unreviewed] = this.rows(`SELECT id FROM dm_missions WHERE kind = 'mission' AND status IN ('done','failed') AND review IS NULL ORDER BY finished_at LIMIT 1`);
            if (!unreviewed || this.inflight.has(String(unreviewed.id))) break;
            await this.reviewOf(String(unreviewed.id));
            continue;
          }
          const id = String(dueSearch.id);
          if (this.inflight.has(id)) break;
          await this.run(id);
        }
      } finally {
        this.ticking = null;
        await this.rearm();
      }
    })();
    return this.ticking;
  }

  /** Run one mission to a terminal state (or a backoff). Re-entrant safe per mission id. */
  async run(id: string): Promise<MissionView | null> {
    if (this.inflight.has(id)) return this.get(id, false);
    this.inflight.add(id);
    try {
      const now = Date.now();
      this.sql.exec(`UPDATE dm_missions SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status NOT IN ('done','failed')`, now, id);
      await this.rearm(); // recovery alarm while in progress: an eviction now still resumes
      for (let step = 0; step < MAX_RUN_LOOP; step++) {
        const [m] = this.rows(`SELECT * FROM dm_missions WHERE id = ?`, id);
        if (!m || m.status === "done" || m.status === "failed") break;
        const delay = Number(m.debug_delay_ms || 0);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const tasks = this.tasksOf(id);
        const lessons = String(m.kind) === "mission" ? this.rows(`SELECT lesson FROM dm_lessons ORDER BY at DESC LIMIT 5`).map((r) => String(r.lesson)) : [];
        const memory = String(m.kind) === "mission" ? await this.recallOnce(id, m) : [];
        const plan = durablePlan({ goal: String(m.objective), kind: String(m.kind), tasks, tenant_label: String(m.tenant), lessons, memory, owner: Number(m.owner) === 1 });
        if (plan.action === "finish") {
          this.sql.exec(
            `UPDATE dm_missions SET status = 'done', answer = ?, evidence = ?, uncited = ?, finished_at = ? WHERE id = ?`,
            plan.answer.slice(0, 12000), (plan.evidence || "").slice(0, 4000), JSON.stringify(plan.uncited ?? []), Date.now(), id
          );
          if (String(m.kind) === "mission") await this.reviewOf(id);
          break;
        }
        if (plan.action === "fail") {
          this.sql.exec(`UPDATE dm_missions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, plan.reason.slice(0, 2000), Date.now(), id);
          if (String(m.kind) === "mission") await this.reviewOf(id);
          break;
        }
        let taskId: string;
        if (plan.action === "resume") {
          taskId = plan.task_id;
        } else {
          const seq = tasks.length ? Math.max(...tasks.map((t) => t.seq)) + 1 : 1;
          taskId = `${id}:${seq}`;
          const name = plan.action === "call_model" ? "model" : plan.name;
          const input = plan.action === "call_model" ? { messages: plan.messages, max_tokens: plan.max_tokens } : plan.args;
          const safe = plan.action === "call_model" ? true : plan.replay_safe;
          this.sql.exec(`INSERT INTO dm_tasks (id, mission_id, seq, name, input, status, attempts, replay_safe) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`, taskId, id, seq, name, JSON.stringify(input), safe ? 1 : 0);
        }
        const outcome = await this.exec(taskId, m);
        if (outcome === "backoff") break;
      }
      return this.get(id, false);
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Agent Memory recall, once per mission and persisted (a replay or resume re-uses the same
   * memory, so the plan stays deterministic). Rust shapes it to a token budget; only those ids
   * may be cited (mem:<id>). A missing binding or a failed recall is recorded, never silent.
   */
  private async recallOnce(id: string, m: Row): Promise<Array<{ id: string; summary: string }>> {
    if (m.memory != null) return JSON.parse(String(m.memory)) as Array<{ id: string; summary: string }>;
    let items: Array<{ id: string; summary: string }> = [];
    let status: string;
    try {
      const confidence = Object.fromEntries(this.rows(`SELECT id, confidence FROM dm_mem_confidence`).map((c) => [String(c.id), Number(c.confidence)]));
      const r = await recallFor(this.h.env, String(m.tenant), String(m.objective), 600, new Date(), false, confidence);
      items = r.items.map((x) => ({ id: x.id, summary: x.summary }));
      status = `recalled ${items.length}/${r.count} (${r.tokens} tokens)`;
    } catch (err) {
      status = `recall unavailable: ${(err as Error).message}`.slice(0, 300);
    }
    this.sql.exec(`UPDATE dm_missions SET memory = ?, memory_status = ? WHERE id = ?`, JSON.stringify(items), status, id);
    return items;
  }

  private tasksOf(missionId: string): DurableTask[] {
    return this.rows(`SELECT id, seq, name, input, output, status, attempts FROM dm_tasks WHERE mission_id = ? ORDER BY seq`, missionId).map(taskOf);
  }

  /**
   * Clef review + lessons, same gate as Pi missions: Clef mission-done gate, every gateway log
   * of the mission's model calls, tool outcomes, interrupted steps and unread citations go into
   * the Rust review. Only `lessonOk` (pass + evidence + nothing interrupted) teaches.
   */
  async reviewOf(id: string): Promise<ReviewResult | null> {
    const [m] = this.rows(`SELECT * FROM dm_missions WHERE id = ?`, id);
    if (!m || m.review != null) return m?.review ? (JSON.parse(String(m.review)) as ReviewResult) : null;
    const tasks = this.rows(`SELECT name, input, status, log_id FROM dm_tasks WHERE mission_id = ? ORDER BY seq`, id);
    const tools = tasks.filter((t) => t.name !== "model");
    const events = tools
      .filter((t) => t.status !== "interrupted")
      .map((t) => ({ mission_id: id, tool: String(t.name), args_hash: hashOf(String(t.input ?? "")), ok: t.status === "done", blocked: null, ms: 0, at: 0 }));
    const interrupted = tools.filter((t) => t.status === "interrupted").length;
    const logIds = tasks.map((t) => (t.log_id == null ? "" : String(t.log_id))).filter(Boolean).slice(0, 20);
    const logs: GatewayLogSummary[] = [];
    let pending = logIds;
    const gw = this.h.env.AI.gateway(gatewayId(this.h.env));
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
      const retry: string[] = [];
      for (const lid of pending) {
        try {
          logs.push(summarizeLog(await gw.getLog(lid)));
        } catch {
          retry.push(lid);
        }
      }
      pending = retry;
    }
    const status = String(m.status);
    const answer = String(m.answer ?? "");
    const evidence = m.evidence == null || String(m.evidence).trim() === "" ? null : String(m.evidence);
    let clefDone: DoneDecision | "unavailable" | undefined;
    if (status === "done") {
      try {
        const out = await runClef(this.h.env, { state: doneState(String(m.objective), answer, evidence), questions: doneQuestions() });
        clefDone = decideDone(out.answers);
      } catch (err) {
        console.error(`durable clef done gate failed: ${(err as Error).message}`);
        clefDone = "unavailable";
      }
    }
    const review = reviewMission({
      missionId: id,
      status,
      finalText: answer,
      events,
      logs,
      missingLogs: pending.length,
      evidence,
      requireEvidence: Number(m.require_evidence) === 1,
      clefDone,
      escalation: null,
      interrupted,
      uncited: JSON.parse(String(m.uncited ?? "[]")) as string[],
    });
    this.sql.exec(`UPDATE dm_missions SET verdict = ?, review = ? WHERE id = ?`, review.verdict, JSON.stringify(review), id);
    if (review.lessonOk) {
      const lesson =
        `${String(m.objective).slice(0, 160)} → done in ${review.totals.requests} model call(s), ` +
        `${review.totals.tool_calls} tool call(s) (${tools.map((t) => t.name).join(", ") || "no tools"}) via ${review.models.join("/") || DEEPSEEK_FLASH}.`;
      this.sql.exec(`INSERT OR REPLACE INTO dm_lessons VALUES (?, ?, ?, ?)`, `lesson:${id}`, id, lesson, Date.now());
    }
    // Store gate + what to remember are Rust (memory.rs): only pass + evidence + nothing interrupted.
    const plan = memoryStorePlan({
      mission_id: id,
      objective: String(m.objective),
      answer,
      evidence,
      lesson_ok: Boolean(review.lessonOk),
      verdict: String(review.verdict),
      interrupted,
      tools: tools.map((t) => String(t.name)),
    });
    let memStatus = `not stored: ${plan.reason}`;
    if (plan.store) {
      try {
        await (await kingdom(this.h.env, String(m.tenant))).ingest(plan.messages, { sessionId: plan.session_id });
        memStatus = `stored (session ${plan.session_id})`;
      } catch (err) {
        memStatus = `store failed: ${(err as Error).message}`.slice(0, 300);
        console.error(`durable memory store failed for ${id}: ${memStatus}`);
      }
    }
    const prev = this.rows(`SELECT memory_status FROM dm_missions WHERE id = ?`, id)[0]?.memory_status;
    this.sql.exec(`UPDATE dm_missions SET memory_status = ? WHERE id = ?`, `${prev ? `${String(prev)}; ` : ""}${memStatus}`, id);
    this.updateConfidence(id, m, answer, evidence, String(review.verdict));
    // Weekly consolidation runs lazily: the first review of a new ISO week writes last week's summary.
    await this.consolidate(String(m.tenant), false).catch((err) => console.error(`weekly consolidation failed: ${(err as Error).message}`));
    return review;
  }

  /** Opinion confidence (Rust): recalled memories this mission cited gain a pass or a fail. */
  private updateConfidence(id: string, m: Row, answer: string, evidence: string | null, verdict: string): void {
    const recalled = (JSON.parse(String(m.memory ?? "[]")) as Array<{ id: string }>).map((x) => x.id);
    if (!recalled.length) return;
    const ph = recalled.map(() => "?").join(",");
    const prior = this.rows(`SELECT id, pass, fail FROM dm_mem_confidence WHERE id IN (${ph})`, ...recalled).map((r) => ({ id: String(r.id), pass: Number(r.pass), fail: Number(r.fail) }));
    const u = memoryOp<{ updates: Array<{ id: string; pass: number; fail: number; confidence: number }> }>("confidence", { recalled, text: `${answer}\n${evidence ?? ""}`, verdict, prior });
    for (const x of u.updates)
      this.sql.exec(`INSERT OR REPLACE INTO dm_mem_confidence VALUES (?, ?, ?, ?, ?, ?)`, x.id, x.pass, x.fail, x.confidence, id, Date.now());
  }

  /**
   * Weekly consolidation (Rust builds it from passing, stored missions of the last 7 days; no model).
   * One memory per ISO week, session weekly-<week>: a re-run replaces it. force = run now.
   */
  async consolidate(tenant: string, force: boolean): Promise<{ week: string; status: string; id?: string; count?: number; content?: string; version?: string }> {
    this.ensure();
    const now = Date.now();
    const last = this.rows(`SELECT v FROM dm_meta WHERE k = 'weekly_week'`)[0]?.v;
    const since = now - 7 * 86_400_000;
    const missions = this.rows(
      `SELECT objective, answer, evidence, verdict, memory_status FROM dm_missions WHERE kind = 'mission' AND finished_at >= ? ORDER BY finished_at DESC LIMIT 50`,
      since
    );
    const confidence = this.rows(`SELECT id, confidence FROM dm_mem_confidence WHERE confidence <= 0.3`).map((c) => ({ id: String(c.id), confidence: Number(c.confidence) }));
    const plan = memoryOp<{ store: boolean; reason: string; session_id: string; week: string; count?: number; content?: string }>("consolidate", { now, missions, confidence });
    if (!force && last === plan.week) return { week: plan.week, status: "already done this week" };
    let status = `not stored: ${plan.reason}`;
    let memId: string | undefined;
    if (plan.store && plan.content) {
      const p = await kingdom(this.h.env, tenant);
      await p.deleteSession(plan.session_id);
      memId = (await p.remember({ content: plan.content, sessionId: plan.session_id })).id;
      status = `stored ${plan.count} mission(s) as ${memId} (session ${plan.session_id})`;
    }
    this.sql.exec(`INSERT OR REPLACE INTO dm_meta VALUES ('weekly_week', ?)`, plan.week);
    this.sql.exec(`INSERT OR REPLACE INTO dm_meta VALUES ('weekly_status', ?)`, `${new Date(now).toISOString()} ${status}`);
    return { week: plan.week, status, id: memId, count: plan.count, content: plan.content, version: this.version() };
  }

  memoryHealth() {
    this.ensure();
    return {
      confidence: this.rows(`SELECT id, pass, fail, confidence, last_mission FROM dm_mem_confidence ORDER BY updated_at DESC LIMIT 50`),
      weekly: Object.fromEntries(this.rows(`SELECT k, v FROM dm_meta WHERE k LIKE 'weekly_%'`).map((r) => [String(r.k), String(r.v)])),
    };
  }

  /** Execute one stored task. The row is marked running BEFORE any side effect. */
  private async exec(taskId: string, mission: Row): Promise<"ok" | "backoff"> {
    const [t] = this.rows(`SELECT * FROM dm_tasks WHERE id = ?`, taskId);
    if (!t) return "ok";
    const name = String(t.name);
    const input = JSON.parse(String(t.input || "{}")) as Record<string, unknown>;
    const missionId = String(mission.id);
    if (name === "model" && !deepseekLimiter.take()) {
      this.sql.exec(`UPDATE dm_missions SET status = 'retry', run_at = ? WHERE id = ?`, Date.now() + MODEL_RETRY_MS, missionId);
      return "backoff";
    }
    this.sql.exec(`UPDATE dm_tasks SET status = 'running', attempts = attempts + 1, started_at = ?, started_version = ? WHERE id = ?`, Date.now(), this.version(), taskId);
    this.currentTask = taskId;
    // Owner debug window: hold a non-replay-safe tool in `running` so an eviction can land inside it.
    const debug = Number(mission.debug_delay_ms || 0);
    if (debug > 0 && Number(t.replay_safe) === 0) await new Promise((r) => setTimeout(r, debug));
    try {
      const output = await this.runTool(name, input, taskId, mission);
      this.sql.exec(`UPDATE dm_tasks SET status = 'done', output = ?, finished_at = ?, finished_version = ? WHERE id = ?`, output.slice(0, 16000), Date.now(), this.version(), taskId);
      return "ok";
    } catch (err) {
      const msg = String((err as Error)?.message || err).slice(0, 1000);
      if (name === "model") {
        const attempts = Number(t.attempts || 0) + 1;
        if (attempts >= 3) {
          this.sql.exec(`UPDATE dm_tasks SET status = 'failed', output = ?, finished_at = ? WHERE id = ?`, msg, Date.now(), taskId);
          return "ok";
        }
        this.h.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE dm_tasks SET status = 'pending', output = ? WHERE id = ?`, msg, taskId);
          this.sql.exec(`UPDATE dm_missions SET status = 'retry', run_at = ? WHERE id = ?`, Date.now() + MODEL_RETRY_MS * attempts, missionId);
        });
        return "backoff";
      }
      this.sql.exec(`UPDATE dm_tasks SET status = 'failed', output = ?, finished_at = ? WHERE id = ?`, msg, Date.now(), taskId);
      return "ok";
    }
  }

  private async runTool(name: string, input: Record<string, unknown>, taskId: string, mission: Row): Promise<string> {
    const owner = Number(mission.owner) === 1;
    // Defense in depth: the planner already refuses these, the executor refuses them again.
    if (name !== "model" && name !== "history_rank" && !durableOp<{ ok: boolean }>("tool_ok", { name, owner }).ok) throw new Error(`tool ${name} not available here`);
    const tenant = String(mission.tenant);
    const out = (v: unknown) => JSON.stringify(v).slice(0, 12000);
    switch (name) {
      case "tool_load":
        return durableOp<{ text: string }>("tool_load", { names: Array.isArray(input.names) ? input.names : [input.name].filter(Boolean), owner }).text;
      case "cf_docs_search":
        return cfDocsSearch(String(input.query || ""));
      case "memory_recall": {
        const query = String(input.query || "").trim().slice(0, 1000);
        if (query.length < 3) throw new Error("query required");
        const r = await (await kingdom(this.h.env, tenant)).recall(query, { responseLength: "short" } as never);
        return (r as { count?: number; answer?: string }).count ? String((r as { answer?: string }).answer ?? "") : "No matching memories.";
      }
      case "memory_remember": {
        const content = String(input.content || "").trim().slice(0, 4000);
        if (!content) throw new Error("content required");
        const m = await (await kingdom(this.h.env, tenant)).remember({ content, sessionId: String(mission.id).slice(0, 64) });
        return `remembered ${m.id}`;
      }
      case "kg_search":
        return out((await kg.searchRecords(this.kgDb(), String(input.query || "").slice(0, 300), Math.min(50, Number(input.limit) || 20))).map((r) => ({ id: r.id, type: r.type, title: r.title, status: r.status })));
      case "kg_get":
        return out((await kg.getRecord(this.kgDb(), String(input.id || ""))) ?? { error: "not found" });
      case "kg_create": {
        const r = await kg.createRecord(this.kgDb(), { type: String(input.type || "note") as never, title: String(input.title || "").slice(0, 300), content: input.content == null ? null : String(input.content).slice(0, 20000) });
        return out({ id: r.id, type: r.type, title: r.title });
      }
      case "kg_link":
        return out(await kg.createEdge(this.kgDb(), String(input.source_id || ""), String(input.target_id || ""), String(input.relation || "references").slice(0, 60)));
      case "kg_observe":
        return out(await kg.createObservation(this.kgDb(), { record_id: String(input.record_id || ""), signal: String(input.signal || "").slice(0, 2000), source: "alfred", confidence: 1 }));
      case "model":
        return this.callModel(input, String(mission.id));
      case "web_search": {
        const query = String(input.query || "").trim().slice(0, 400);
        if (query.length < 2) throw new Error("query required");
        const route: string[] = [];
        const res = await this.search(owner, tenant, route).search({ query, limit: 6 } as never, {} as never);
        const items = res.items.slice(0, 6).map((i, n) => `${n + 1}. ${i.title}\n   ${i.url}\n   ${(i.description ?? "").slice(0, 300)}`);
        return `Search results via ${route.join("; ") || "search"} (leads only: open with web_fetch before citing):\n${items.join("\n") || "(no results)"}`;
      }
      case "web_fetch": {
        const fetched = await fetchPublicPage(String(input.url || ""));
        // First line stays "HTTP <status> <url>" (the citation check reads it); the page is fenced as data.
        const page = untrustedWrap(fetched.url, fetched.status, durableHtmlText(fetched.body, 4000), 4000);
        return `HTTP ${fetched.status} ${fetched.url}\n${page.text}`;
      }
      case "note_save": {
        const text = String(input.text || "").trim().slice(0, 2000);
        if (!text) throw new Error("text required");
        this.sql.exec(`INSERT OR REPLACE INTO dm_notes VALUES (?, ?, ?, ?)`, taskId, String(mission.id), text, Date.now());
        return `saved note ${taskId}`;
      }
      case "history_search":
        return this.historySubagent(String(input.query || ""), taskId, mission);
      case "history_rank": {
        const query = String(input.query || "");
        const exclude = [String(mission.id), String(mission.owner_mission_id || "")].filter(Boolean);
        const candidates = this.rows(
          `SELECT id, objective, answer, kind, status, created_at FROM dm_missions WHERE tenant = ? AND status = 'done' ORDER BY created_at DESC LIMIT 400`,
          String(mission.tenant)
        ).map((c) => ({ id: String(c.id), goal: String(c.objective), answer: c.answer == null ? null : String(c.answer), kind: String(c.kind), status: String(c.status), created_at: Number(c.created_at) }));
        const r = durableRank({ query, exclude, candidates, limit: 5 });
        return JSON.stringify({ ids: r.items.map((i) => i.id) }) + "\n" + r.text;
      }
    }
    throw new Error(`unknown tool ${name}`);
  }

  /**
   * history_search as a child task: a child mission owned by this tool task. Idempotent by
   * the task id, so a replay after eviction continues the same child instead of starting another.
   * Only the child's final answer goes back to the parent.
   */
  private async historySubagent(query: string, parentTaskId: string, parent: Row): Promise<string> {
    if (query.trim().length < 3) throw new Error("query required");
    const childId = `${String(parent.id)}~h${parentTaskId.split(":").pop()}`;
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO dm_missions (id, tenant, objective, kind, source, status, parent_task_id, owner_mission_id, run_at, created_at)
       VALUES (?, ?, ?, 'history_search', 'subagent', 'queued', ?, ?, ?, ?)`,
      childId, String(parent.tenant), query.slice(0, 1000), parentTaskId, String(parent.id), now, now
    );
    const v = (await this.run(childId)) ?? this.get(childId, false);
    if (!v || v.status !== "done") throw new Error(`history search ${v?.status ?? "missing"}: ${v?.error ?? ""}`);
    return v.answer ?? "";
  }

  /** Standalone history search (The Report / MCP): durable, receipt-idempotent, returns the answer. */
  async history(tenant: string, query: string, requestId?: string | null): Promise<MissionView & { used: string[] }> {
    const c = await this.create({ tenant, objective: query, requestId, fallback: ["history", query, String(Math.floor(Date.now() / 60_000))], source: "web", kind: "history_search" });
    const v = (await this.run(c.missionId)) ?? this.get(c.missionId, false)!;
    const [rank] = this.rows(`SELECT output FROM dm_tasks WHERE mission_id = ? AND name = 'history_rank' AND status = 'done'`, c.missionId);
    let used: string[] = [];
    try {
      used = (JSON.parse(String(rank?.output || "").split("\n")[0]) as { ids: string[] }).ids;
    } catch {
      used = [];
    }
    await this.rearm();
    return { ...this.get(c.missionId, false)!, used, status: v.status };
  }

  /**
   * The front door (web chat, ORAL, MCP ask): one durable mission run inline to its end, then
   * returned. Same loop, tools, fencing, citation check and Clef review as every other mission;
   * receipt-idempotent, and if this isolate dies the alarm finishes it.
   */
  async ask(a: CreateArgs, waitMs = 110_000): Promise<MissionView> {
    const c = await this.create(a);
    const run = this.run(c.missionId);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), waitMs));
    await Promise.race([run, timeout]);
    await this.rearm();
    return this.get(c.missionId, false)!;
  }

  /** One-time move of retired Pi-harness missions + lessons into this engine (idempotent). */
  importLegacy(tenant: string, missions: Array<Record<string, unknown>>, lessons: Array<Record<string, unknown>>): { imported: number; skipped: number; lessons: number } {
    this.ensure();
    const r = durableOp<{ rows: Array<Record<string, SqlStorageValue>>; skipped: number }>("legacy", { tenant, missions });
    let imported = 0;
    let lessonsIn = 0;
    this.h.ctx.storage.transactionSync(() => {
      for (const x of r.rows) {
        const before = this.rows(`SELECT 1 FROM dm_missions WHERE id = ?`, x.id as string).length;
        if (before) continue;
        this.sql.exec(
          `INSERT OR IGNORE INTO dm_receipts VALUES (?, ?, ?, ?, ?)`, tenant, x.request_id, x.id, "pi-import", x.created_at
        );
        this.sql.exec(
          `INSERT OR IGNORE INTO dm_missions (id, tenant, objective, kind, source, status, answer, error, request_id, run_at, created_at, started_at, finished_at, verdict, review, memory, memory_status)
           VALUES (?, ?, ?, 'mission', 'pi-import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'imported from the Pi engine')`,
          x.id, tenant, x.objective, x.status, x.answer ?? null, x.error ?? null, x.request_id, x.run_at, x.created_at, x.started_at, x.finished_at,
          x.verdict ?? (x.status === "done" ? "unreviewed" : "fail"),
          typeof x.review === "string" ? x.review : x.review == null ? JSON.stringify({ verdict: x.verdict ?? "unreviewed", flags: ["imported from the Pi engine"] }) : JSON.stringify(x.review)
        );
        imported++;
      }
      for (const l of lessons) {
        const id = String(l.id ?? "");
        if (!id) continue;
        this.sql.exec(`INSERT OR IGNORE INTO dm_lessons VALUES (?, ?, ?, ?)`, `pi:${id}`.slice(0, 80), String(l.mission_id ?? ""), String(l.lesson ?? "").slice(0, 600), Number(l.at ?? 0));
        lessonsIn++;
      }
    });
    return { imported, skipped: r.skipped + (r.rows.length - imported), lessons: lessonsIn };
  }

  /** Owner: drop the lesson a mission produced (keeps a bad run out of self-improvement). */
  forgetLesson(missionId: string): { deleted: number } {
    this.ensure();
    const n = Number(this.rows(`SELECT COUNT(*) AS n FROM dm_lessons WHERE mission_id = ?`, missionId)[0]?.n ?? 0);
    this.sql.exec(`DELETE FROM dm_lessons WHERE mission_id = ?`, missionId);
    return { deleted: n };
  }

  private async callModel(input: Record<string, unknown>, missionId: string): Promise<string> {
    const r = await this.h.env.AI.run(
      DEEPSEEK_FLASH as never,
      { messages: input.messages, max_tokens: Number(input.max_tokens) || 2400 } as never,
      { gateway: { id: gatewayId(this.h.env), metadata: { app: "alfred-report", engine: "durable", mission: missionId } } } as never
    );
    const logId = (this.h.env.AI as unknown as { aiGatewayLogId?: string | null }).aiGatewayLogId ?? null;
    if (logId) this.sql.exec(`UPDATE dm_tasks SET log_id = ? WHERE id = ?`, logId, this.currentTask);
    const { text } = modelsText(r);
    if (!text.trim()) throw new Error("empty model reply");
    return text;
  }

  private kgDb(): D1Database {
    if (!this.h.env.DB) throw new Error("knowledge graph unavailable");
    return this.h.env.DB;
  }

  private currentTask = "";

  /** Same router as the web Worker: Ceramic, then Exa Lite (gateway custom provider), then Exa auto; 10 rps. */
  version(): string {
    return this.h.env.CF_VERSION_METADATA?.id ?? "unknown";
  }

  /**
   * web_search: Ceramic and Exa (Lite via the gateway `exa` custom provider, else Exa auto) in
   * parallel, fused by RRF in Rust. Exa is metered per kingdom (this object is one kingdom): the
   * owner kingdom is unlimited, others get SEARCH_EXA_KINGDOM_DAILY per UTC day, then Ceramic only.
   * Usage per kingdom and day is stored in dm_search_usage and logged.
   */
  private search(owner: boolean, tenant: string, route: string[] = []): WebSearchSource {
    const env = this.h.env;
    const gateway = gatewayId(env);
    const alias = (env.EXA_KEY_ALIAS || "").trim();
    const cap = Number.parseInt(env.SEARCH_EXA_KINGDOM_DAILY || "", 10);
    const day = () => new Date().toISOString().slice(0, 10);
    const budget: ExaBudget = {
      used: () => Number(this.rows(`SELECT exa FROM dm_search_usage WHERE day = ?`, day())[0]?.exa ?? 0),
      spend: () => {
        this.sql.exec(`INSERT INTO dm_search_usage (day, exa, ceramic) VALUES (?, 1, 0) ON CONFLICT(day) DO UPDATE SET exa = exa + 1`, day());
      },
      ceramic: () => {
        this.sql.exec(`INSERT INTO dm_search_usage (day, exa, ceramic) VALUES (?, 0, 1) ON CONFLICT(day) DO UPDATE SET ceramic = ceramic + 1`, day());
      },
    };
    const lite =
      alias && env.CLOUDFLARE_ACCOUNT_ID && env.CF_AIG_TOKEN
        ? createExaLiteSearch({ accountId: env.CLOUDFLARE_ACCOUNT_ID, gateway, slug: (env.EXA_CUSTOM_PROVIDER || "exa").trim(), alias, gatewayToken: env.CF_AIG_TOKEN })
        : undefined;
    return createParallelSearch({
      ceramic: createAIWebSearch({ binding: env.AI, gateway, provider: "ceramic" }),
      exaLite: lite,
      exa: alias ? createAIWebSearch({ binding: env.AI, gateway, provider: "exa", byokAlias: alias }) : undefined,
      budget,
      owner,
      kingdomCap: Number.isFinite(cap) && cap >= 0 ? cap : null,
      onRoute: (r) => {
        const p = r.providers.map((x) => `${x.provider}(${x.ok ? x.count : `failed: ${x.error}`})`).join(" + ");
        route.push(`${p} -> ${r.merged} merged; exa ${r.exa.allowed ? "on" : "off"}: ${r.exa.reason}`);
        console.log(JSON.stringify({ event: "web_search", kingdom: tenant, owner, providers: r.providers, merged: r.merged, exa: r.exa }));
      },
    });
  }
}

/** Same public endpoint the `cf docs search` CLI calls (no login). Results limited to developers.cloudflare.com. */
export const CF_DOCS_SEARCH_URL = "https://ai-search.developers.cloudflare.com/api/ai-search/search";
export async function cfDocsSearch(query: string, doFetch: typeof fetch = fetch): Promise<string> {
  const q = query.trim().slice(0, 512);
  if (q.length < 2) throw new Error("query required");
  const res = await doFetch(CF_DOCS_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }], stream: false, ai_search_options: { retrieval: { metadata_only: true, max_num_results: 5 } } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`cf docs search failed (HTTP ${res.status})`);
  const body = (await res.json()) as { result?: { chunks?: Array<{ item?: { key?: string; metadata?: { title?: string; description?: string } } }> } };
  const items = (body.result?.chunks || [])
    .slice(0, 5)
    .map((c) => ({ title: c.item?.metadata?.title || "Untitled", url: new URL(c.item?.key || "", "https://developers.cloudflare.com/").href, description: (c.item?.metadata?.description || "").slice(0, 300) }))
    .filter((r) => r.url.startsWith("https://developers.cloudflare.com/"));
  return `Cloudflare docs results (leads only: open with web_fetch before citing):\n${items.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n") || "(no results)"}`;
}

function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

function taskOf(r: Row): DurableTask {
  let input: unknown = {};
  try {
    input = r.input == null ? {} : JSON.parse(String(r.input));
  } catch {
    input = {};
  }
  return {
    id: String(r.id),
    input,
    seq: Number(r.seq),
    name: String(r.name),
    output: r.output == null ? null : String(r.output),
    status: String(r.status),
    attempts: Number(r.attempts || 0),
  };
}

function viewOf(m: Row, interrupted = 0): MissionView {
  const n = (v: SqlStorageValue) => (v == null ? null : Number(v));
  return {
    id: String(m.id),
    tenant: String(m.tenant),
    objective: String(m.objective),
    kind: String(m.kind),
    source: String(m.source ?? ""),
    status: String(m.status),
    answer: m.answer == null ? null : String(m.answer),
    error: m.error == null ? null : String(m.error),
    request_id: String(m.request_id ?? ""),
    run_at: Number(m.run_at),
    created_at: Number(m.created_at),
    started_at: n(m.started_at),
    finished_at: n(m.finished_at),
    wakes: Number(m.wakes || 0),
    evidence: m.evidence == null ? null : String(m.evidence),
    verdict: m.verdict == null ? null : String(m.verdict),
    review: m.review == null ? null : (JSON.parse(String(m.review)) as ReviewResult),
    interrupted,
    memory_ids: m.memory == null ? [] : (JSON.parse(String(m.memory)) as Array<{ id: string }>).map((x) => x.id),
    memory_status: m.memory_status == null ? null : String(m.memory_status),
  };
}
