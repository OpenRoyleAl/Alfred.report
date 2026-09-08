// src/do/mission-state.ts — Per-mission state authority Durable Object (v2)
// Mission lifecycle: intent → contract → execution → evidence → gate →
// durable state → voice report → completed (server-derived)

import { DurableObject } from "cloudflare:workers";
import type { Env, MissionStatus } from "../types";
import { recordCop } from "../cop/cop";

export class MissionStateDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();
    switch (action) {
      case "start": return this.startMission();
      case "pause": return this.pauseMission();
      case "resume": return this.resumeMission();
      case "complete": return this.completeMission(request);
      case "cancel": return this.cancelMission();
      case "status": return this.getStatus();
      case "add-directive": return this.addDirective(request);
      case "evidence": return this.addEvidence(request);
      case "gate": return this.runGate();
      case "budget": return this.getBudget();
      default: return new Response("Not found", { status: 404 });
    }
  }

  async startMission(): Promise<Response> {
    const state = (await this.ctx.storage.get("state")) as MissionStatus | undefined;
    if (state === "active") return Response.json({ error: "Mission already active" }, { status: 409 });
    const budget = (await this.ctx.storage.get("budgetUsd")) as number | undefined;
    if (budget !== undefined) { await this.env.DB.prepare(`UPDATE missions SET budget_usd = ? WHERE id = ?`).bind(budget, this.missionId).run(); }
    await this.ctx.storage.put("state", "active");
    await this.ctx.storage.put("phase", "execution");
    await this.ctx.storage.put("startedAt", new Date().toISOString());
    await this.env.DB.prepare(`UPDATE missions SET status = 'active', started_at = ? WHERE id = ?`).bind(new Date().toISOString(), this.missionId).run();
    await this.logEvent("started", "system", { phase: "execution" });
    this.ctx.storage.setAlarm(new Date(Date.now() + 30 * 60 * 1000));
    return Response.json({ status: "active", phase: "execution" });
  }

  async pauseMission(): Promise<Response> {
    await this.ctx.storage.put("state", "paused");
    await this.ctx.storage.put("phase", "paused");
    await this.env.DB.prepare(`UPDATE missions SET status = 'paused' WHERE id = ?`).bind(this.missionId).run();
    await this.logEvent("paused", "system");
    return Response.json({ status: "paused" });
  }

  async resumeMission(): Promise<Response> {
    const state = (await this.ctx.storage.get("state")) as MissionStatus | undefined;
    if (state !== "paused") return Response.json({ error: "Mission must be paused to resume" }, { status: 409 });
    await this.ctx.storage.put("state", "active");
    await this.ctx.storage.put("phase", "execution");
    await this.env.DB.prepare(`UPDATE missions SET status = 'active' WHERE id = ?`).bind(this.missionId).run();
    await this.logEvent("resumed", "system");
    this.ctx.storage.setAlarm(new Date(Date.now() + 30 * 60 * 1000));
    return Response.json({ status: "active" });
  }

  async completeMission(request: Request): Promise<Response> {
    const body = await request.json<{ result?: any; evidence?: any[] }>();
    const evidence = body.evidence || (await this.ctx.storage.get("evidence")) || [];
    await this.ctx.storage.put("evidence", evidence);
    await this.ctx.storage.put("phase", "evidence");
    await this.logEvent("result_updated", "system", { evidenceCount: evidence.length });
    const gateResult = await this.runGateInternal(evidence);
    await this.ctx.storage.put("gateResult", gateResult);
    await this.ctx.storage.put("phase", "gate");
    await this.logEvent("status_changed", "gate", gateResult);
    if (!gateResult.passed) {
      await this.ctx.storage.put("state", "failed");
      await this.env.DB.prepare(`UPDATE missions SET status = 'failed' WHERE id = ?`).bind(this.missionId).run();
      await this.logEvent("failed", "gate", { reason: gateResult.reason });
      return Response.json({ status: "failed", gate: gateResult });
    }
    const result = body.result || {};
    await this.ctx.storage.put("state", "completed");
    await this.ctx.storage.put("result", result);
    await this.ctx.storage.put("completedAt", new Date().toISOString());
    await this.ctx.storage.put("phase", "durable_state");
    await this.env.DB.prepare(`UPDATE missions SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`).bind(JSON.stringify(result), new Date().toISOString(), this.missionId).run();
    await this.logEvent("completed", "system", { gate: gateResult });
    let voiceReport = null;
    try {
      const summary = `Mission ${this.missionId} completed successfully. ${gateResult.summary || ""}`;
      voiceReport = await this.env.AI.run("@cf/deepgram/aura-2-en", { text: summary }) as ArrayBuffer;
      await this.ctx.storage.put("voiceReport", true);
      await this.ctx.storage.put("phase", "voice_report");
      await this.logEvent("voice_session_ended", "system", { report: true });
    } catch {}
    this.ctx.storage.deleteAlarm();
    recordCop(this.env, { userId: await this.getUserId(), missionId: this.missionId, agent: "mission-state", provider: "workers-ai", model: "mission-lifecycle", eventType: "tool", tokensIn: 0, tokensOut: 0 });
    return Response.json({ status: "completed", gate: gateResult, voiceReport: !!voiceReport });
  }

  async cancelMission(): Promise<Response> {
    await this.ctx.storage.put("state", "cancelled");
    await this.ctx.storage.put("phase", "cancelled");
    await this.env.DB.prepare(`UPDATE missions SET status = 'cancelled' WHERE id = ?`).bind(this.missionId).run();
    await this.logEvent("cancelled", "system");
    this.ctx.storage.deleteAlarm();
    return Response.json({ status: "cancelled" });
  }

  async addEvidence(request: Request): Promise<Response> {
    const { evidence } = await request.json<{ evidence: any }>();
    const all = (await this.ctx.storage.get("evidence")) as any[] || [];
    all.push({ ...evidence, timestamp: new Date().toISOString() });
    await this.ctx.storage.put("evidence", all);
    await this.logEvent("result_updated", "system", { evidenceType: evidence.type });
    return Response.json({ evidenceCount: all.length });
  }

  async runGate(): Promise<Response> {
    const evidence = (await this.ctx.storage.get("evidence")) as any[] || [];
    const result = await this.runGateInternal(evidence);
    return Response.json(result);
  }

  private async runGateInternal(evidence: any[]): Promise<{ passed: boolean; reason?: string; summary?: string }> {
    if (!evidence || evidence.length === 0) return { passed: false, reason: "No evidence collected" };
    const budget = (await this.ctx.storage.get("budgetUsd")) as number | undefined;
    if (budget !== undefined) {
      const spent = await this.env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM cost_events WHERE mission_id = ?`).bind(this.missionId).first<{ spent: number }>();
      if (spent && spent.spent > budget) return { passed: false, reason: `Budget exceeded: ${spent.spent.toFixed(4)} > ${budget}` };
    }
    return { passed: true, summary: `Verified ${evidence.length} evidence item(s).` };
  }

  async getBudget(): Promise<Response> {
    const budget = (await this.ctx.storage.get("budgetUsd")) as number | undefined;
    const spent = await this.env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM cost_events WHERE mission_id = ?`).bind(this.missionId).first<{ spent: number }>();
    return Response.json({ budget: budget ?? null, spent: spent?.spent ?? 0 });
  }

  async getStatus(): Promise<Response> {
    return Response.json({
      missionId: this.missionId, state: await this.ctx.storage.get("state"), phase: await this.ctx.storage.get("phase"),
      startedAt: await this.ctx.storage.get("startedAt"), completedAt: await this.ctx.storage.get("completedAt"),
      evidence: await this.ctx.storage.get("evidence"), gateResult: await this.ctx.storage.get("gateResult"), result: await this.ctx.storage.get("result"),
    });
  }

  async addDirective(request: Request): Promise<Response> {
    const { directive } = await request.json<{ directive: string }>();
    const directives = (await this.ctx.storage.get("directives")) as string[] || [];
    directives.push(directive);
    await this.ctx.storage.put("directives", directives);
    await this.env.DB.prepare(`UPDATE missions SET oral_directives = ? WHERE id = ?`).bind(JSON.stringify(directives), this.missionId).run();
    await this.logEvent("directive_added", "oral_operator", { directive });
    return Response.json({ directives });
  }

  async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get("state")) as MissionStatus | undefined;
    if (state === "active") {
      await this.ctx.storage.put("state", "failed");
      await this.ctx.storage.put("phase", "failed");
      await this.env.DB.prepare(`UPDATE missions SET status = 'failed' WHERE id = ?`).bind(this.missionId).run();
      await this.logEvent("error", "system", { reason: "timeout" });
    }
  }

  private async getUserId(): Promise<string> {
    const mission = await this.env.DB.prepare(`SELECT user_id FROM missions WHERE id = ?`).bind(this.missionId).first<{ user_id: string }>();
    return mission?.user_id || "unknown";
  }

  private async logEvent(eventType: string, actor: string, data?: Record<string, unknown>): Promise<void> {
    await this.env.DB.prepare(`INSERT INTO mission_events (mission_id, event_type, actor, event_data) VALUES (?, ?, ?, ?)`).bind(this.missionId, eventType, actor, data ? JSON.stringify(data) : null).run();
  }

  private get missionId(): string { return this.ctx.name || "unknown"; }
}