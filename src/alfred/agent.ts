/**
 * Alfred - the agent. A Pi Durable harness running in the `Alfred` Durable Object
 * (one object per tenant, addressed by tenant id).
 *
 * Persistence: Pi stores transcripts/inbox/tasks in this object's SQLite (pi_* tables);
 * Alfred adds alfred_* tables (missions, tool events, reviews, lessons). Long-term memory
 * lives in Cloudflare Agent Memory (binding MEMORY, profile = tenant).
 *
 * Mission loop: new Pi session per mission -> tools behind loop guards -> end-of-mission
 * review against AI Gateway logs -> only passing runs become lessons (shown to future
 * sessions via the "lessons" prompt section; Harness²-style persistent improvement store).
 */
import { Agent } from "agents";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import type { Env } from "../lib/env";
import { createAlfredModels } from "./models";
import { guardTool, type GuardStore, type ToolEvent } from "./guards";
import { collectLogIds, reviewMission, summarizeLog, type GatewayLogSummary, type ReviewResult } from "./review";
import { webTools } from "./extensions/web";
import { memoryTools } from "./extensions/memory";
import { missionTools } from "./extensions/missions";
import { knowledgeTools } from "./extensions/knowledge";
import { clefExtension, clefGates } from "./extensions/clef";
import { clairicExtension } from "./extensions/clairic";
import type { DoneDecision, RouteDecision } from "./clef";
import { extractMission, type IntakeSource } from "./clairic";
import { buildReport, REPORT_LIMIT, type MissionRow, type TheReport } from "./report";
import { instanceBrand } from "../brand";
import { durableCreate, durableGet, durableLessons, durableList, durableReportRow, isDurableId, type DurableCreateIn } from "../lib/durable-client";

export interface AlfredState {
  tenantId: string | null;
  isOwner: boolean;
  missionsRun: number;
  lastMissionAt: number;
}

const PREAMBLE = `You are Alfred, the owner's operator on Cloudflare. Be brief and concrete.
Rules: evidence before done (close missions only with mission_complete and real evidence);
never reveal secrets; use web_search to find pages and web_fetch to read them; use cf_docs_search for anything
Cloudflare; do not repeat a tool call that already returned a result; when blocked, say so.`;

const MAX_LOGS_PER_REVIEW = 60;
const LESSONS_IN_PROMPT = 8;

export interface AlfredDump {
  missions: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  lessons: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

export class Alfred extends Agent<Env, AlfredState> {
  initialState: AlfredState = { tenantId: null, isOwner: false, missionsRun: 0, lastMissionAt: 0 };

  private activeMission = "chat";
  private evidence = new Map<string, string>();
  private escalations = new Map<string, string>();
  private missionQueue: Promise<unknown> = Promise.resolve();

  private routing = createAlfredModels(this.env);
  private gates = clefGates(this.env);
  registry = createRegistry();

  harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.ensureTables();
      const tenant = this.state?.tenantId || "default";
      const guard = this.guardStore();
      const tools: ToolRegistration[] = [
        ...webTools(this.env, this.exaBudget()),
        // Prune tools that cannot work here: fewer tool schemas per request = smaller, stable prefix.
        ...(this.env.MEMORY ? memoryTools(this.env, tenant, () => this.activeMission) : []),
        ...missionTools(this.env, tenant, (id, ev) => this.evidence.set(this.activeMission, `${id}: ${ev}`)),
        ...(this.state?.isOwner ? knowledgeTools(this.env.DB) : []),
      ].map((t) => guardTool(t, guard));

      this.registry.install({
        name: "alfred",
        sections: [
          { key: "preamble", render: () => PREAMBLE, tag: false },
          { key: "today", render: () => new Date().toISOString().slice(0, 10) },
          { key: "lessons", render: () => this.lessonsText() },
        ],
        tools,
      });
      // Clef decision gates and Clairic extraction, each its own extension (loop guards apply too).
      for (const ext of [
        clefExtension(this.env, { onEscalate: (action, reason) => this.escalations.set(this.activeMission, `${reason}: ${action.slice(0, 300)}`) }, this.gates),
        clairicExtension(this.env),
      ]) {
        this.registry.install({ ...ext, tools: (ext.tools ?? []).map((t) => guardTool(t, guard)) });
      }
      return Harness.open(storage, { models: this.routing.models, registry: this.registry }, context);
    },
    defaults: { model: this.routing.missionModel, thinkingLevel: "low" },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  // ─── Setup ──────────────────────────────────────────────────────

  /** Bind this object to a verified tenant (called by the Worker after auth). Idempotent. */
  async bind(tenantId: string, isOwner: boolean): Promise<void> {
    if (this.state.tenantId === tenantId && this.state.isOwner === isOwner) return;
    if (this.state.tenantId && this.state.tenantId !== tenantId) throw new Error("tenant mismatch");
    this.setState({ ...this.state, tenantId, isOwner });
  }

  /** Owner-tenant consolidation: everything needed to copy this object's missions elsewhere. */
  async exportMissions(): Promise<AlfredDump> {
    this.ensureTables();
    return {
      missions: this.sql<Record<string, unknown>>`SELECT * FROM alfred_missions`,
      reviews: this.sql<Record<string, unknown>>`SELECT * FROM alfred_reviews`,
      lessons: this.sql<Record<string, unknown>>`SELECT * FROM alfred_lessons`,
      events: this.sql<Record<string, unknown>>`SELECT * FROM alfred_tool_events`,
    };
  }

  /** Copy missions in (idempotent: a mission id already here is skipped with its events). Owner only. */
  async importMissions(d: AlfredDump): Promise<{ missions: number; skipped: number }> {
    if (!this.state.isOwner) throw new Error("owner only");
    this.ensureTables();
    const have = new Set(this.sql<{ id: string }>`SELECT id FROM alfred_missions`.map((r) => r.id));
    const fresh = new Set<string>();
    for (const m of d.missions) {
      const id = String(m.id);
      if (have.has(id)) continue;
      fresh.add(id);
      this.sql`INSERT INTO alfred_missions (id, session, objective, status, final_text, verdict, started_at, finished_at)
        VALUES (${id}, ${m.session as string}, ${m.objective as string}, ${m.status as string}, ${m.final_text as string}, ${m.verdict as string}, ${m.started_at as number}, ${m.finished_at as number})`;
    }
    for (const r of d.reviews) if (fresh.has(String(r.mission_id)))
      this.sql`INSERT OR IGNORE INTO alfred_reviews VALUES (${r.mission_id as string}, ${r.verdict as string}, ${r.review as string}, ${r.at as number})`;
    for (const l of d.lessons) if (fresh.has(String(l.mission_id)))
      this.sql`INSERT OR IGNORE INTO alfred_lessons VALUES (${l.id as string}, ${l.mission_id as string}, ${l.lesson as string}, ${l.at as number})`;
    for (const e of d.events) if (fresh.has(String(e.mission_id)))
      this.sql`INSERT INTO alfred_tool_events VALUES (${e.mission_id as string}, ${e.tool as string}, ${e.args_hash as string}, ${e.ok as number}, ${e.blocked as string}, ${e.ms as number}, ${e.at as number})`;
    return { missions: fresh.size, skipped: d.missions.length - fresh.size };
  }

  private ensureTables() {
    this.sql`CREATE TABLE IF NOT EXISTS alfred_missions (
      id TEXT PRIMARY KEY, session TEXT, objective TEXT, status TEXT,
      final_text TEXT, verdict TEXT, started_at INTEGER, finished_at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS alfred_tool_events (
      mission_id TEXT, tool TEXT, args_hash TEXT, ok INTEGER, blocked TEXT, ms INTEGER, at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS alfred_reviews (mission_id TEXT PRIMARY KEY, verdict TEXT, review TEXT, at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS alfred_lessons (id TEXT PRIMARY KEY, mission_id TEXT, lesson TEXT, at INTEGER)`;
  }

  private guardStore(): GuardStore {
    return {
      missionId: () => this.activeMission,
      record: (e: ToolEvent) => {
        this.sql`INSERT INTO alfred_tool_events VALUES (${e.mission_id}, ${e.tool}, ${e.args_hash}, ${e.ok ? 1 : 0}, ${e.blocked}, ${e.ms}, ${e.at})`;
      },
      events: (missionId: string, tool?: string) => {
        const rows = tool
          ? this.sql<Record<string, unknown>>`SELECT * FROM alfred_tool_events WHERE mission_id = ${missionId} AND tool = ${tool} ORDER BY at`
          : this.sql<Record<string, unknown>>`SELECT * FROM alfred_tool_events WHERE mission_id = ${missionId} ORDER BY at`;
        return rows.map((r) => ({
          mission_id: String(r.mission_id),
          tool: String(r.tool),
          args_hash: String(r.args_hash),
          ok: Number(r.ok) === 1,
          blocked: (r.blocked as string | null) ?? null,
          ms: Number(r.ms),
          at: Number(r.at),
        }));
      },
    };
  }

  /** Daily Exa escalation counter persisted in this object's SQLite. */
  private exaBudget() {
    const day = () => new Date().toISOString().slice(0, 10);
    return {
      used: () => {
        this.sql`CREATE TABLE IF NOT EXISTS alfred_search_usage (day TEXT PRIMARY KEY, exa INTEGER)`;
        const [r] = this.sql<{ exa: number }>`SELECT exa FROM alfred_search_usage WHERE day = ${day()}`;
        return r ? Number(r.exa) : 0;
      },
      spend: () => {
        this.sql`CREATE TABLE IF NOT EXISTS alfred_search_usage (day TEXT PRIMARY KEY, exa INTEGER)`;
        this.sql`INSERT INTO alfred_search_usage VALUES (${day()}, 1) ON CONFLICT(day) DO UPDATE SET exa = exa + 1`;
      },
    };
  }

  private lessonsText(): string | undefined {
    this.ensureTables();
    const rows = this.sql<{ lesson: string }>`SELECT lesson FROM alfred_lessons ORDER BY at DESC LIMIT ${LESSONS_IN_PROMPT}`;
    if (!rows.length) return undefined;
    return rows.map((r) => `- ${r.lesson}`).join("\n");
  }

  // ─── Missions ───────────────────────────────────────────────────

  /** Run one mission end to end (serialized per tenant) and return its review. */
  async runMission(objective: string, opts: { requireEvidence?: boolean } = {}) {
    const run = this.missionQueue.then(() => this.runMissionInner(objective, opts));
    this.missionQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Start a mission. New missions run on the durable engine in the Missions Worker (receipt-
   * idempotent by requestId, survive eviction, DeepSeek on the alfred-report gateway).
   * `engine: "pi"` keeps the in-object Pi harness path (Clef review + lessons).
   */
  async startMission(
    objective: string,
    opts: { requireEvidence?: boolean; requestId?: string | null; source?: DurableCreateIn["source"]; fallback?: string[]; delaySeconds?: number | null; runAt?: number | null; engine?: "durable" | "pi"; debugStepDelayMs?: number; debugSearch?: "force-exa" | null } = {}
  ): Promise<{ missionId: string; requestId?: string; duplicate?: boolean; status?: string; engine: string; runAt?: number }> {
    if (opts.engine !== "pi" && this.env.MISSIONS) {
      if (!this.state.tenantId) throw new Error("unbound");
      const r = await durableCreate(this.env, this.state.tenantId, {
        objective,
        requestId: opts.requestId ?? null,
        fallback: opts.requestId ? [] : opts.fallback ?? [opts.source ?? "web", objective, crypto.randomUUID()],
        source: opts.source ?? "web",
        delaySeconds: opts.delaySeconds ?? null,
        runAt: opts.runAt ?? null,
        debugStepDelayMs: this.state.isOwner ? opts.debugStepDelayMs : 0,
        requireEvidence: opts.requireEvidence ?? false,
        debugSearch: this.state.isOwner && opts.debugSearch === "force-exa" ? "force-exa" : null,
      });
      return { ...r, engine: "durable" };
    }
    return { ...(await this.startPiMission(objective, opts)), engine: "pi" };
  }

  /** Legacy Pi-harness mission (fire-and-forget). */
  private async startPiMission(objective: string, opts: { requireEvidence?: boolean } = {}): Promise<{ missionId: string }> {
    const missionId = crypto.randomUUID();
    const run = this.missionQueue.then(() => this.runMissionInner(objective, opts, missionId));
    this.missionQueue = run.catch(() => undefined);
    this.ctx.waitUntil(run.catch(() => undefined));
    return { missionId };
  }

  async getMission(id: string) {
    if (isDurableId(id) && this.state.tenantId && this.env.MISSIONS) {
      const d = await durableGet(this.env, this.state.tenantId, id);
      return d ? { ...d, engine: "durable", final_text: d.answer } : null;
    }
    this.ensureTables();
    const [m] = this.sql<Record<string, unknown>>`SELECT * FROM alfred_missions WHERE id = ${id}`;
    const [r] = this.sql<{ review: string }>`SELECT review FROM alfred_reviews WHERE mission_id = ${id}`;
    return m ? { ...m, review: r ? JSON.parse(r.review) : null } : null;
  }

  /** The Report (what WAKE returns): recent missions with their review + mission-done gate. */
  async report(limit = REPORT_LIMIT): Promise<TheReport> {
    this.ensureTables();
    let durable: MissionRow[] = [];
    if (this.state.tenantId && this.env.MISSIONS) {
      try {
        durable = (await durableList(this.env, this.state.tenantId, limit)).map(durableReportRow);
      } catch (err) {
        console.warn("durable list failed", String((err as Error)?.message || err).slice(0, 200));
      }
    }
    const rows = this.sql<Record<string, unknown>>`SELECT m.id, m.objective, m.status, m.verdict, m.started_at, m.finished_at, r.review
      FROM alfred_missions m LEFT JOIN alfred_reviews r ON r.mission_id = m.id ORDER BY m.started_at DESC LIMIT ${limit}`;
    const missions: MissionRow[] = rows.map((r) => ({
      id: String(r.id),
      objective: String(r.objective ?? ""),
      status: String(r.status ?? ""),
      verdict: r.verdict == null ? null : String(r.verdict),
      started_at: Number(r.started_at ?? 0),
      finished_at: r.finished_at == null ? null : Number(r.finished_at),
      review: r.review ? (JSON.parse(String(r.review)) as ReviewResult) : null,
    }));
    const merged = [...missions, ...durable].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
    return buildReport(instanceBrand(this.env.DOMAIN || ""), merged, Date.now(), limit);
  }

  /** Owner: drop the lesson a mission produced (keeps a bad run out of self-improvement). */
  forgetLesson(missionId: string): { deleted: number } {
    this.ensureTables();
    const before = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM alfred_lessons WHERE mission_id = ${missionId}`[0]?.n ?? 0;
    this.sql`DELETE FROM alfred_lessons WHERE mission_id = ${missionId}`;
    return { deleted: Number(before) };
  }

  /** Clef mission-done gate health from inside this object (null = unavailable). */
  async gateHealth() {
    return this.gates.done("say hi", "hi", "replied hi");
  }

  async listLessons(limit = 20) {
    this.ensureTables();
    const pi = this.sql<Record<string, unknown>>`SELECT * FROM alfred_lessons ORDER BY at DESC LIMIT ${limit}`;
    let durable: Array<Record<string, unknown>> = [];
    if (this.state.tenantId && this.env.MISSIONS) {
      try {
        durable = (await durableLessons(this.env, this.state.tenantId, limit)).map((l) => ({ ...l, engine: "durable" }));
      } catch {
        durable = [];
      }
    }
    return [...pi, ...durable].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, limit);
  }

  private async runMissionInner(objective: string, opts: { requireEvidence?: boolean }, missionId = crypto.randomUUID()) {
    this.ensureTables();
    const session = await this.harness.sessions.create();
    // Pin the mission model on every new session (defaults alone do not override a stored host model).
    await session.setModel(this.routing.missionModel);
    const now = Date.now();
    this.sql`INSERT INTO alfred_missions VALUES (${missionId}, ${String(session.id)}, ${objective}, 'running', NULL, NULL, ${now}, NULL)`;
    this.activeMission = missionId;
    let status = "unanswered";
    let finalText = "";
    let messages: unknown = [];
    try {
      const result = await session.prompt(`Mission ${missionId}:\n${objective}`, { operationId: missionId });
      status = result.status;
      finalText = result.text ?? "";
      messages = result.messages;
    } catch (err) {
      finalText = `error: ${(err as Error).message}`;
    } finally {
      this.activeMission = "chat";
    }

    const clefDone = status === "done" ? await this.doneGate(objective, finalText, this.evidence.get(missionId) ?? null) : null;
    const review = await this.review(missionId, status, finalText, messages, opts.requireEvidence ?? false, clefDone);
    this.sql`UPDATE alfred_missions SET status = ${status}, final_text = ${finalText.slice(0, 8000)},
      verdict = ${review.verdict}, finished_at = ${Date.now()} WHERE id = ${missionId}`;
    this.setState({ ...this.state, missionsRun: this.state.missionsRun + 1, lastMissionAt: Date.now() });
    return { missionId, status, text: finalText, review };
  }

  /** Clef mission-done gate (extension "clef"). null = Clef unavailable (non-blocking flag in review). */
  private doneGate(objective: string, finalText: string, evidence: string | null): Promise<DoneDecision | null> {
    return this.gates.done(objective, finalText, evidence);
  }

  private async review(
    missionId: string,
    status: string,
    finalText: string,
    messages: unknown,
    requireEvidence: boolean,
    clefDone: DoneDecision | null = null
  ): Promise<ReviewResult> {
    const logIds = collectLogIds(messages).slice(0, MAX_LOGS_PER_REVIEW);
    const gateway = this.env.AI.gateway(this.routing.gateway);
    const logs: GatewayLogSummary[] = [];
    let missing = 0;
    // Gateway logs land a few seconds after the request: retry the misses before flagging them.
    let pending = logIds;
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
      const retry: string[] = [];
      for (const id of pending) {
        try {
          logs.push(summarizeLog(await gateway.getLog(id)));
        } catch {
          retry.push(id);
        }
      }
      pending = retry;
    }
    missing = pending.length;
    const result = reviewMission({
      missionId,
      status,
      finalText,
      events: this.guardStore().events(missionId),
      logs,
      missingLogs: missing,
      evidence: this.evidence.get(missionId) ?? null,
      requireEvidence,
      clefDone: status === "done" ? (clefDone ?? "unavailable") : undefined,
      escalation: this.escalations.get(missionId) ?? null,
    });
    const hadEvidence = Boolean(this.evidence.get(missionId));
    this.evidence.delete(missionId);
    this.escalations.delete(missionId);
    this.sql`INSERT OR REPLACE INTO alfred_reviews VALUES (${missionId}, ${result.verdict}, ${JSON.stringify(result)}, ${Date.now()})`;

    if (result.lessonOk && hadEvidence) {
      // Only passing runs that closed with real evidence (mission_complete) may teach. Keep the lesson short and factual.
      const [m] = this.sql<{ objective: string }>`SELECT objective FROM alfred_missions WHERE id = ${missionId}`;
      const lesson = `${(m?.objective || "").slice(0, 160)} → done in ${result.totals.requests} model call(s), ` +
        `${result.totals.tool_calls} tool call(s) via ${result.models.join("/") || "auto"}.`;
      this.sql`INSERT OR REPLACE INTO alfred_lessons VALUES (${crypto.randomUUID()}, ${missionId}, ${lesson}, ${Date.now()})`;
      if (this.env.MEMORY && this.state.tenantId) {
        try {
          const profile = await this.env.MEMORY.getProfile(this.state.tenantId);
          await profile.ingest(
            [
              { role: "user", content: `Mission: ${(m?.objective || "").slice(0, 2000)}` },
              { role: "assistant", content: finalText.slice(0, 8000) },
            ],
            { sessionId: missionId.slice(0, 64) }
          );
        } catch {
          /* memory is best-effort; the lesson row is already stored */
        }
      }
    }
    return result;
  }

  // ─── Chat (root session) ────────────────────────────────────────

  /** Clef route gate (extension "clef"). Falls back to "mission" (guarded + reviewed) when Clef is unsure or down. */
  route(prompt: string): Promise<RouteDecision> {
    return this.gates.route(prompt);
  }

  /**
   * Front door: route with Clef; chat answers inline, everything else runs as a reviewed
   * mission. Ops requests pass the Clef escalate gate first and stop if a human must approve.
   */
  async ask(prompt: string): Promise<{ text: string; status: string; route: RouteDecision; missionId?: string; escalation?: string }> {
    const route = await this.route(prompt);
    if (route.route === "chat" && !route.needsWeb) {
      const r = await this.harness.prompt(prompt);
      return { text: r.text ?? "", status: r.status, route };
    }
    if (route.route === "ops") {
      const d = await this.gates.escalate(prompt); // fails closed
      if (d.escalate && !this.state.isOwner) {
        return { text: "This needs the account owner's approval before Alfred acts.", status: "needs_approval", route, escalation: d.reason };
      }
    }
    const m = await this.runMission(prompt, { requireEvidence: route.route !== "research" });
    return { text: m.text, status: m.status, route, missionId: m.missionId };
  }

  /** Sandbox quota: count one use of `kind` today; refuse past `limit` (owners are not limited). */
  async consumeQuota(kind: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }> {
    if (this.state.isOwner) return { ok: true, used: 0, limit: Infinity };
    this.sql`CREATE TABLE IF NOT EXISTS alfred_quota (day TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, kind))`;
    const day = new Date().toISOString().slice(0, 10);
    const [r] = this.sql<{ n: number }>`SELECT n FROM alfred_quota WHERE day = ${day} AND kind = ${kind}`;
    const used = r ? Number(r.n) : 0;
    if (used >= limit) return { ok: false, used, limit };
    this.sql`INSERT INTO alfred_quota VALUES (${day}, ${kind}, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`;
    return { ok: true, used: used + 1, limit };
  }

  /**
   * Owner email forward -> mission: Clairic extracts the objective, then the mission starts.
   * Owner-only (the Worker checks the sender before calling this).
   */
  async missionFromEmail(subject: string, body: string): Promise<{ missionId: string; objective: string }> {
    if (!this.state.isOwner) throw new Error("owner only");
    let objective = "";
    try {
      const x = await extractMission(this.env, { kind: "email", subject, body });
      const v = x.fields.objective?.value;
      if (typeof v === "string") objective = v.trim();
    } catch {
      /* fall back to the subject + body below */
    }
    if (objective.length < 3) objective = `${subject}\n\n${body}`.trim().slice(0, 4000);
    const { missionId } = await this.startMission(`Forwarded email: ${objective}`, { requireEvidence: true, fallback: ["email", objective] });
    return { missionId, objective };
  }

  /**
   * Owner voice command (ORAL) -> mission draft. The objective is the owner's own words; Clairic
   * reads the typed fields so ORAL can read back the uncertain ones before "Go Max AI!" starts it.
   */
  async draftFromVoice(transcript: string): Promise<{ objective: string; needsReview: string[]; due: string | null }> {
    if (!this.state.isOwner) throw new Error("owner only");
    const objective = transcript.trim().slice(0, 4000);
    let needsReview: string[] = [];
    let due: string | null = null;
    try {
      const x = await extractMission(this.env, { kind: "voice", transcript: objective });
      needsReview = x.needsReview;
      const d = x.fields.due_date?.value;
      if (typeof d === "string") due = d;
    } catch {
      /* Clairic unavailable: the draft is still the owner's words */
    }
    return { objective, needsReview, due };
  }

  /** Owner voice "Go Max AI!" -> start the drafted mission (evidence required, like email). */
  async missionFromVoice(objective: string, requestId?: string | null, source: "voice" | "siri" | "oral" = "voice"): Promise<{ missionId: string }> {
    if (!this.state.isOwner) throw new Error("owner only");
    const o = objective.trim().slice(0, 4000);
    if (o.length < 3) throw new Error("objective required");
    // A repeated "Go Max AI!" for the same draft within 10 minutes is the same request (one run).
    const windowKey = String(Math.floor(Date.now() / 600_000));
    return this.startMission(`Voice: ${o}`, { requireEvidence: true, requestId: requestId ?? null, source, fallback: [source, o, windowKey] });
  }

  /** Clairic intake: email / voice / image -> typed mission fields (uncertain ones flagged). */
  async intake(src: IntakeSource) {
    return extractMission(this.env, src);
  }
}
