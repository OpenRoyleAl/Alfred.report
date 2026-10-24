import { recentNotices } from "../lib/owner-notices.ts";
import { isOwnerTenantId } from "../lib/tenant.ts";
/**
 * Alfred - the tenant's front door, one `Alfred` Durable Object per tenant (addressed by tenant id).
 *
 * There is one agent loop: the durable engine in the Missions Worker (crates/alfred-core/src/durable.rs
 * + apps/missions/src/durable.ts). Web chat, ORAL, MCP, email and voice missions all run there. This
 * object only binds the verified tenant, meters sandbox asks, runs the Clef front-door gates (route,
 * ops escalate) and Clairic intake, and builds The Report from durable missions.
 *
 * Subagents kept on purpose: the Clef review (verification, after every mission) and history_search
 * (a parallel, throwaway child that returns one answer). Everything else is a tool in the one loop.
 */
import { Agent } from "agents";
import type { Env } from "../lib/env";
import { clefGates } from "./clef";
import type { RouteDecision } from "./clef";
import { extractMission, type IntakeSource } from "./clairic";
import { buildReport, REPORT_LIMIT, type TheReport } from "./report";
import { instanceBrand } from "../brand";
import {
  durableAsk,
  durableCreate,
  durableForgetLesson,
  durableGet,
  durableImportLegacy,
  durableLessons,
  durableList,
  durableReportRow,
  type DurableCreateIn,
} from "../lib/durable-client";
import { nextBindState } from "./bind";

export interface AlfredState {
  tenantId: string | null;
  isOwner: boolean;
  missionsRun: number;
  lastMissionAt: number;
  /** Retired Pi-harness missions in this object were moved to the durable engine (once). */
  legacyMoved?: boolean;
}

export interface AskResult {
  text: string;
  status: string;
  route: RouteDecision;
  missionId?: string;
  verdict?: string | null;
  escalation?: string;
}

export class Alfred extends Agent<Env, AlfredState> {
  initialState: AlfredState = { tenantId: null, isOwner: false, missionsRun: 0, lastMissionAt: 0 };

  /** Privilege of the caller that last bound this isolate (not persisted). */
  private callerIsOwner = false;
  private gates = clefGates(this.env);

  /** Bind this object to a verified tenant (called by the Worker after auth). Idempotent. */
  async bind(tenantId: string, isOwner: boolean): Promise<void> {
    const next = nextBindState(this.state, tenantId, isOwner);
    this.callerIsOwner = isOwner;
    if (this.state.tenantId !== next.tenantId || this.state.isOwner !== next.isOwner) this.setState({ ...this.state, ...next });
    if (!this.state.legacyMoved) await this.moveLegacy();
  }

  /**
   * One-time migration: missions the retired Pi harness kept in this object's SQLite (alfred_*)
   * move into the durable engine with their ids, verdicts and lessons, so The Report and old links
   * keep working with one engine. Idempotent on the durable side; retried on the next bind on error.
   */
  private async moveLegacy(): Promise<void> {
    if (!this.state.tenantId || !this.env.MISSIONS) return;
    try {
      const has = (t: string) => this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${t}`[0]?.n;
      let missions: Record<string, unknown>[] = [];
      let lessons: Record<string, unknown>[] = [];
      if (has("alfred_missions")) {
        const reviewed = Boolean(has("alfred_reviews"));
        missions = reviewed
          ? this.sql<Record<string, unknown>>`SELECT m.*, r.review AS review FROM alfred_missions m LEFT JOIN alfred_reviews r ON r.mission_id = m.id`
          : this.sql<Record<string, unknown>>`SELECT * FROM alfred_missions`;
        if (has("alfred_lessons")) lessons = this.sql<Record<string, unknown>>`SELECT * FROM alfred_lessons`;
      }
      if (missions.length || lessons.length) {
        const r = await durableImportLegacy(this.env, this.state.tenantId, missions, lessons);
        console.log(`legacy pi missions moved for ${this.state.tenantId}: ${JSON.stringify(r)} of ${missions.length}`);
      }
      this.setState({ ...this.state, legacyMoved: true });
    } catch (err) {
      console.warn("legacy move failed (retried next bind)", String((err as Error)?.message || err).slice(0, 200));
    }
  }

  private tenant(): string {
    if (!this.state.tenantId) throw new Error("unbound");
    return this.state.tenantId;
  }

  // ─── Missions (all on the durable engine) ───────────────────────

  async startMission(
    objective: string,
    opts: { requireEvidence?: boolean; requestId?: string | null; source?: DurableCreateIn["source"]; fallback?: string[]; delaySeconds?: number | null; runAt?: number | null; debugStepDelayMs?: number } = {}
  ): Promise<{ missionId: string; requestId?: string; duplicate?: boolean; status?: string; engine: "durable"; runAt?: number }> {
    const r = await durableCreate(this.env, this.tenant(), {
      objective,
      requestId: opts.requestId ?? null,
      fallback: opts.requestId ? [] : opts.fallback ?? [opts.source ?? "web", objective, crypto.randomUUID()],
      source: opts.source ?? "web",
      delaySeconds: opts.delaySeconds ?? null,
      runAt: opts.runAt ?? null,
      debugStepDelayMs: this.callerIsOwner ? opts.debugStepDelayMs : 0,
      requireEvidence: opts.requireEvidence ?? false,
      owner: this.callerIsOwner,
    });
    return { ...r, engine: "durable" };
  }

  async getMission(id: string) {
    const d = await durableGet(this.env, this.tenant(), id);
    return d ? { ...d, engine: "durable", final_text: d.answer } : null;
  }

  /** The Report (what WAKE returns): recent durable missions with their review + mission-done gate. */
  async report(limit = REPORT_LIMIT): Promise<TheReport> {
    let rows: ReturnType<typeof durableReportRow>[] = [];
    try {
      rows = (await durableList(this.env, this.tenant(), limit)).map(durableReportRow);
    } catch (err) {
      console.warn("durable list failed", String((err as Error)?.message || err).slice(0, 200));
    }
    const report = buildReport(instanceBrand(this.env.DOMAIN || ""), rows, Date.now(), limit);
    // Kingdom model: only the default king's Report lists who joined (signup metadata only).
    if (await isOwnerTenantId(this.env as never, this.tenant())) {
      try {
        for (const n of await recentNotices(this.env.DB)) report.attention.push(n.text);
      } catch (err) {
        console.warn("owner notices failed", String((err as Error)?.message || err).slice(0, 200));
      }
    }
    return report;
  }

  /** Owner: drop the lesson a mission produced (keeps a bad run out of self-improvement). */
  async forgetLesson(missionId: string): Promise<{ deleted: number }> {
    if (!this.callerIsOwner) throw new Error("owner only");
    return durableForgetLesson(this.env, this.tenant(), missionId);
  }

  /** Clef mission-done gate health from inside this object (null = unavailable). */
  async gateHealth() {
    return this.gates.done("say hi", "hi", "replied hi");
  }

  async listLessons(limit = 20) {
    return (await durableLessons(this.env, this.tenant(), limit)).map((l) => ({ ...l, engine: "durable" }));
  }

  // ─── Front door ─────────────────────────────────────────────────

  route(prompt: string): Promise<RouteDecision> {
    return this.gates.route(prompt);
  }

  /**
   * Web chat, MCP ask and typed asks: Clef routes (and the ops escalate gate stops non-owners), then
   * the one durable loop answers inline. Chat and research run without the evidence requirement.
   */
  async ask(prompt: string, opts: { source?: DurableCreateIn["source"]; requestId?: string | null } = {}): Promise<AskResult> {
    const route = await this.route(prompt);
    if (route.route === "ops") {
      const d = await this.gates.escalate(prompt); // fails closed
      if (d.escalate && !this.callerIsOwner) {
        return { text: "This needs the account owner's approval before Alfred acts.", status: "needs_approval", route, escalation: d.reason };
      }
    }
    const m = await durableAsk(this.env, this.tenant(), {
      objective: prompt.slice(0, 4000),
      requestId: opts.requestId ?? null,
      fallback: opts.requestId ? [] : ["ask", prompt, crypto.randomUUID()],
      source: opts.source ?? "web",
      requireEvidence: route.route === "mission" || route.route === "ops",
      owner: this.callerIsOwner,
    });
    this.setState({ ...this.state, missionsRun: this.state.missionsRun + 1, lastMissionAt: Date.now() });
    const text = m.status === "done" ? m.answer ?? "" : m.status === "failed" ? `I couldn't finish that: ${m.error ?? "unknown error"}` : "Still working on it. Ask for The Report in a moment.";
    return { text, status: m.status, route, missionId: m.id, verdict: m.verdict ?? null };
  }

  /** Sandbox quota: count one use of `kind` today; refuse past `limit` (owners are not limited). */
  async consumeQuota(kind: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }> {
    if (this.callerIsOwner) return { ok: true, used: 0, limit: Infinity };
    this.sql`CREATE TABLE IF NOT EXISTS alfred_quota (day TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, kind))`;
    const day = new Date().toISOString().slice(0, 10);
    const [r] = this.sql<{ n: number }>`SELECT n FROM alfred_quota WHERE day = ${day} AND kind = ${kind}`;
    const used = r ? Number(r.n) : 0;
    if (used >= limit) return { ok: false, used, limit };
    this.sql`INSERT INTO alfred_quota VALUES (${day}, ${kind}, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`;
    return { ok: true, used: used + 1, limit };
  }

  /** Owner email forward -> mission: Clairic extracts the objective, then the mission starts. */
  async missionFromEmail(subject: string, body: string): Promise<{ missionId: string; objective: string }> {
    if (!this.callerIsOwner) throw new Error("owner only");
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

  /** Owner voice command (ORAL) -> mission draft; Clairic flags the uncertain fields. */
  async draftFromVoice(transcript: string): Promise<{ objective: string; needsReview: string[]; due: string | null }> {
    if (!this.callerIsOwner) throw new Error("owner only");
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
    if (!this.callerIsOwner) throw new Error("owner only");
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
