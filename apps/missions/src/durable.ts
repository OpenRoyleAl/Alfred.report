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
  durableRank,
  durableRecover,
  durableFetchCheck,
  untrustedWrap,
  durableHtmlText,
  modelsText,
  type DurableTask,
} from "../../../src/alfred/core.ts";
import { DEEPSEEK_FLASH, deepseekLimiter, gatewayId } from "../../../src/alfred/models";
import { reviewMission, summarizeLog, type GatewayLogSummary, type ReviewResult } from "../../../src/alfred/review";
import { decideDone, doneQuestions, doneState, runClef, type DoneDecision } from "../../../src/alfred/clef";
import { createRoutedSearch, type ExaBudget } from "../../../src/alfred/search";
import { createExaLiteSearch } from "../../../src/alfred/exa-lite";
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
  SEARCH_EXA_DAILY_LIMIT?: string;
  CF_AIG_TOKEN?: SecretValue;
  /** HMAC key for derived mission ids (Secrets Store). */
  ALFRED_RECEIPT_KEY?: SecretValue;
  /** Version metadata binding: the Worker version id this isolate runs (recorded on every task). */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  MEMORY?: AMNamespace;
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
  /** Owner debug only: "force-exa" treats Ceramic and Exa Lite results as thin so every tier runs. */
  debugSearch?: "force-exa" | null;
  /** Owner debug only: sleep before each step so an eviction can land mid-mission. */
  debugStepDelayMs?: number;
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
const ENGINE_BUILD = "durable-2026-10-23c";
const MODEL_RETRY_MS = 5_000;
/** Work due within this window runs now (alarm clock skew / 1 s schedule resolution). */
const DUE_SLACK_MS = 1_000;

export class DurableEngine {
  private recovered = false;
  private inflight = new Set<string>();
  private ticking: Promise<void> | null = null;

  constructor(private h: DurableHost) {}

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
    ] as const)
      if (!m.has(c)) this.sql.exec(`ALTER TABLE dm_missions ADD COLUMN ${c} ${ddl}`);
    const t = cols("dm_tasks");
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
        `INSERT INTO dm_missions (id, tenant, objective, kind, source, status, request_id, run_at, created_at, debug_delay_ms, require_evidence, debug_search)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.mission_id, a.tenant, c.objective, c.kind, c.source, c.status, c.request_id, c.run_at, now, debug, a.requireEvidence ? 1 : 0,
        a.debugSearch === "force-exa" ? "force-exa" : null
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
        const plan = durablePlan({ goal: String(m.objective), kind: String(m.kind), tasks, tenant_label: String(m.tenant), lessons, memory });
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
      const r = await recallFor(this.h.env, String(m.tenant), String(m.objective), 600, new Date());
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
    return review;
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
    switch (name) {
      case "model":
        return this.callModel(input, String(mission.id));
      case "web_search": {
        const query = String(input.query || "").trim().slice(0, 400);
        if (query.length < 2) throw new Error("query required");
        const route: string[] = [];
        const res = await this.search(mission.debug_search === "force-exa", route).search({ query, limit: 6 } as never, {} as never);
        const items = res.items.slice(0, 6).map((i, n) => `${n + 1}. ${i.title}\n   ${i.url}\n   ${(i.description ?? "").slice(0, 300)}`);
        return `Search results via ${route.join(" -> ") || "router"} (leads only: open with web_fetch before citing):\n${items.join("\n") || "(no results)"}`;
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

  private currentTask = "";
  private searchSource: WebSearchSource | null = null;

  /** Same router as the web Worker: Ceramic, then Exa Lite (gateway custom provider), then Exa auto; 10 rps. */
  version(): string {
    return this.h.env.CF_VERSION_METADATA?.id ?? "unknown";
  }

  /**
   * Same router as the web Worker: Ceramic, then Exa Lite (gateway custom provider), then Exa auto; 10 rps.
   * Owner debug `force-exa` (per mission, set at create): the real Ceramic and Exa Lite calls still run
   * (and are logged on the gateway), but their results are handed to the Rust router as empty, so it
   * escalates through every tier. Normal missions never take this path.
   */
  private search(forceExa = false, route: string[] = []): WebSearchSource {
    if (!forceExa && this.searchSource) return this.searchSource;
    const env = this.h.env;
    const gateway = gatewayId(env);
    const alias = (env.EXA_KEY_ALIAS || "").trim();
    const limit = Number.parseInt(env.SEARCH_EXA_DAILY_LIMIT || "200", 10);
    const day = () => new Date().toISOString().slice(0, 10);
    const budget: ExaBudget = {
      used: () => Number(this.rows(`SELECT exa FROM dm_search_usage WHERE day = ?`, day())[0]?.exa ?? 0),
      spend: () => {
        this.sql.exec(`INSERT INTO dm_search_usage VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET exa = exa + 1`, day());
      },
    };
    const thin = (name: string, src: WebSearchSource): WebSearchSource => ({
      async search(req, call) {
        const r = await src.search(req, call);
        route.push(`${name}(${r.items.length} results, debug: treated as thin)`);
        return { ...r, items: [] };
      },
    });
    const ceramic = createAIWebSearch({ binding: env.AI, gateway, provider: "ceramic" });
    const lite =
      alias && env.CLOUDFLARE_ACCOUNT_ID && env.CF_AIG_TOKEN
        ? createExaLiteSearch({ accountId: env.CLOUDFLARE_ACCOUNT_ID, gateway, slug: (env.EXA_CUSTOM_PROVIDER || "exa").trim(), alias, gatewayToken: env.CF_AIG_TOKEN })
        : undefined;
    const source = createRoutedSearch({
      ceramic: forceExa ? thin("ceramic", ceramic) : ceramic,
      exaLite: lite && forceExa ? thin("exa-lite", lite) : lite,
      exa: alias ? createAIWebSearch({ binding: env.AI, gateway, provider: "exa", byokAlias: alias }) : undefined,
      budget,
      exaDailyLimit: Number.isFinite(limit) ? limit : 200,
      onRoute: (r) => {
        route.push(`${r.provider}: ${r.reason}`);
        console.log(`durable web_search ${r.provider}: ${r.reason}`);
      },
    });
    if (!forceExa) this.searchSource = source;
    return source;
  }
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
