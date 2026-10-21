import { primeSecrets } from "./lib/secrets";
import { Agent } from "agents";
import { Curator } from "./workers/curator";
import { Janitor } from "./workers/janitor";
import { Distiller } from "./workers/distiller";
import { Farmer } from "./workers/farmer";
import { Builder } from "./workers/builder";
import type { Env } from "./workers/curator";
import { MISSIONS_SYSTEM } from "./prompts";
import * as db from "./lib/db";
import { createChatClient } from "./lib/llm";
import type { WorkerResult } from "./types";

// ─── AlfredMissions State ────────────────────────────────────────

export interface OrchestratorState {
  lastBriefingAt: number;
  lastMaintenanceAt: number;
  totalDelegations: number;
}

// ─── AlfredMissions (Think Agent) ────────────────────────────────

export class AlfredMissions extends Agent<Env, OrchestratorState> {
  async onStart() {
    await primeSecrets(this.env);
  }

  initialState = {
    lastBriefingAt: 0,
    lastMaintenanceAt: 0,
    totalDelegations: 0,
  };

  // ─── Sub-Agent Delegation ────────────────────────────────────

  async delegateToCurator(): Promise<WorkerResult> {
    const curator = await this.subAgent(Curator, "curator");
    const result = await curator.processInbox();
    this.state.totalDelegations++;
    return result;
  }

  async delegateToJanitor(): Promise<WorkerResult> {
    const janitor = await this.subAgent(Janitor, "janitor");
    const result = await janitor.runMaintenance();
    this.state.totalDelegations++;
    return result;
  }

  async delegateToDistiller(): Promise<WorkerResult> {
    const distiller = await this.subAgent(Distiller, "distiller");
    const result = await distiller.extractKnowledge();
    this.state.totalDelegations++;
    return result;
  }

  async delegateToFarmer(): Promise<WorkerResult> {
    const farmer = await this.subAgent(Farmer, "farmer");
    const result = await farmer.scanForOpportunities();
    this.state.totalDelegations++;
    return result;
  }

  async delegateToBuilder(
    spec: import("./workers/builder").BuildSpec
  ): Promise<WorkerResult & { code: string }> {
    const builder = await this.subAgent(Builder, "builder");
    const result = await builder.generateCode(spec);
    this.state.totalDelegations++;
    return result;
  }

  // ─── Inbox Processing ────────────────────────────────────────

  async processInboxItem(source: string, content: string, metadata?: Record<string, unknown>): Promise<WorkerResult> {
    // Store in D1 as pending inbox item
    const record = await db.createRecord(this.env.DB, {
      type: "note",
      title: `[${source}] ${content.substring(0, 80)}...`,
      content,
      metadata: { source, ...metadata, status: "pending_review" },
    });

    await db.createObservation(this.env.DB, {
      record_id: record.id,
      signal: `Inbox item from ${source} stored for review (not auto-processed)`,
      source: "orchestrator",
      confidence: 1.0,
    });

    return {
      worker: "curator",
      success: true,
      duration_ms: 0,
      summary: `Inbox item stored as ${record.id}. Use /curate to process pending items.`,
      record_id: record.id,
    };
  }

  // ─── Briefing Generation ─────────────────────────────────────

  async generateBriefing(): Promise<string> {
    const start = Date.now();

    // Gather stats (don't auto-curate — user wants control)
    const mattersActive = await db.countRecords(this.env.DB, "matter");
    const tasks = await db.getRecordsByType(this.env.DB, "task", 200);
    const tasksPending = tasks.filter((t) => t.status === "active").length;
    const tasksCompleted = tasks.filter((t) => t.status === "completed").length;

    const since24h = Date.now() - 86400000;
    const observations = await db.getObservationsSince(this.env.DB, since24h);
    const recentObs = observations.slice(0, 20).map((o) => o.signal);

    // Use the model router to generate the briefing
    const llm = createChatClient(this.env);
    const briefing = await llm.chatJSON<{ insights: string[]; priorities: string[] }>(
      [
        { role: "system", content: MISSIONS_SYSTEM },
        {
          role: "user",
          content: `Generate a daily briefing for Agent Alfred Media.

Current stats:
- Active matters: ${mattersActive}
- Pending tasks: ${tasksPending}
- Completed tasks (24h): ${tasksCompleted}
- Observations (24h): ${observations.length}

Recent observations:
${recentObs.map((o, i) => `${i + 1}. ${o}`).join("\n")}

Return JSON:
{
  "insights": ["<insight 1>", "<insight 2>", ...],
  "priorities": ["<priority 1>", "<priority 2>", ...]
}`,
        },
      ],
      { temperature: 0.5 }
    );

    // Create a briefing record
    const briefingContent = `# Daily Briefing — ${new Date().toISOString().split("T")[0]}

## Stats
- Active matters: ${mattersActive}
- Pending tasks: ${tasksPending}
- Completed tasks (24h): ${tasksCompleted}
- Observations (24h): ${observations.length}

## Insights
${briefing.insights.map((i) => `- ${i}`).join("\n")}

## Priorities
${briefing.priorities.map((p) => `- ${p}`).join("\n")}
`;

    // Store in R2
    const r2Key = `briefings/${new Date().toISOString().split("T")[0]}.md`;
    await this.env.CONTENT.put(r2Key, briefingContent, {
      httpMetadata: { contentType: "text/markdown" },
    });

    const record = await db.createRecord(this.env.DB, {
      type: "briefing",
      title: `Daily Briefing — ${new Date().toISOString().split("T")[0]}`,
      content: briefingContent,
      content_r2_key: r2Key,
      metadata: {
        matters_active: mattersActive,
        tasks_pending: tasksPending,
        tasks_completed: tasksCompleted,
        observations_24h: observations.length,
        generated_in_ms: Date.now() - start,
      },
    });

    await db.createObservation(this.env.DB, {
      record_id: record.id,
      signal: `AlfredMissions generated daily briefing with ${briefing.insights.length} insights and ${briefing.priorities.length} priorities`,
      source: "orchestrator",
      confidence: 1.0,
    });

    this.state.lastBriefingAt = Date.now();

    return briefingContent;
  }

  // ─── Nightly Maintenance ─────────────────────────────────────

  async runNightlyMaintenance(): Promise<string> {
    const start = Date.now();

    // Janitor cleans the graph
    const janitorResult = await this.delegateToJanitor();

    // Distiller extracts knowledge from the day's activity
    const distillerResult = await this.delegateToDistiller();

    // Farmer scans for overnight opportunities
    const farmerResult = await this.delegateToFarmer();

    const report = `# Nightly Maintenance Report — ${new Date().toISOString().split("T")[0]}

## Janitor
- ${janitorResult.summary}

## Distiller
- ${distillerResult.summary}

## Farmer
- ${farmerResult.summary}

## Duration
- Total: ${Date.now() - start}ms
`;

    const record = await db.createRecord(this.env.DB, {
      type: "daybook",
      title: `Maintenance — ${new Date().toISOString().split("T")[0]}`,
      content: report,
      metadata: {
        janitor: janitorResult,
        distiller: distillerResult,
        farmer: farmerResult,
        duration_ms: Date.now() - start,
      },
    });

    await db.createObservation(this.env.DB, {
      record_id: record.id,
      signal: `AlfredMissions completed nightly maintenance in ${Date.now() - start}ms`,
      source: "orchestrator",
      confidence: 1.0,
    });

    this.state.lastMaintenanceAt = Date.now();

    return report;
  }

  // ─── Fetch Handler (Internal API) ────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Inbox endpoint
    if (url.pathname === "/inbox" && req.method === "POST") {
      const body = await req.json() as { source: string; content: string; metadata?: Record<string, unknown> };
      const result = await this.processInboxItem(body.source, body.content, body.metadata);
      return Response.json(result);
    }

    // Stats endpoint
    if (url.pathname === "/stats") {
      const types = [
        "matter", "task", "note", "person", "org", "place",
        "asset", "chore", "instinct", "decision", "briefing", "daybook", "commitment",
      ] as const;
      const counts: Record<string, number> = {};
      for (const t of types) {
        counts[t] = await db.countRecords(this.env.DB, t);
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return Response.json({
        counts,
        total,
        delegations: this.state.totalDelegations,
        lastBriefingAt: this.state.lastBriefingAt,
        lastMaintenanceAt: this.state.lastMaintenanceAt,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── Chat Handler (Think) ────────────────────────────────────

  async onChatMessage(message: string): Promise<string> {
    // Check if this is a command
    const lowerMessage = message.toLowerCase().trim();

    if (lowerMessage.startsWith("/briefing")) {
      return await this.generateBriefing();
    }

    if (lowerMessage.startsWith("/maintenance")) {
      return await this.runNightlyMaintenance();
    }

    if (lowerMessage.startsWith("/curate")) {
      const result = await this.delegateToCurator();
      return result.summary;
    }

    if (lowerMessage.startsWith("/clean")) {
      const result = await this.delegateToJanitor();
      return result.summary;
    }

    if (lowerMessage.startsWith("/distill")) {
      const result = await this.delegateToDistiller();
      return result.summary;
    }

    if (lowerMessage.startsWith("/farm")) {
      const result = await this.delegateToFarmer();
      return result.summary;
    }

    if (lowerMessage.startsWith("/stats")) {
      const types = [
        "matter", "task", "note", "person", "org", "place",
        "asset", "chore", "instinct", "decision", "briefing", "daybook", "commitment",
      ] as const;
      const counts: Record<string, number> = {};
      for (const t of types) {
        counts[t] = await db.countRecords(this.env.DB, t);
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return `Knowledge Graph Stats:\n${Object.entries(counts)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")}\n  Total: ${total}\n  Delegations: ${this.state.totalDelegations}`;
    }

    // Default: use the model router for conversational response with knowledge graph context
    const llm = createChatClient(this.env);
    const recentObs = await db.getRecentObservations(this.env.DB, 10);

    const response = await llm.chat(
      [
        { role: "system", content: MISSIONS_SYSTEM },
        {
          role: "user",
          content: `Recent context from observations:
${recentObs.map((o) => `- [${o.source}] ${o.signal}`).join("\n")}

User message: ${message}

Respond concisely. If the user wants you to take action, describe what you would do and which sub-agent you would delegate to.`,
        },
      ],
      { temperature: 0.6 }
    );

    return response;
  }
}
