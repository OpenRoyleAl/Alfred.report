import { Agent } from "agents";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { DISTILLER_SYSTEM } from "../prompts";
import type { WorkerResult } from "../types";
import type { Env } from "./curator";

export interface DistillerState {
  lastRunAt: number;
  totalRuns: number;
  insightsGenerated: number;
}

// ─── Distiller Agent ────────────────────────────────────────────

export class Distiller extends Agent<Env, DistillerState> {
  initialState = { lastRunAt: 0, totalRuns: 0, insightsGenerated: 0 };

  /**
   * Extract insights from recent records and observations.
   * Creates 'instinct' and 'decision' records, plus Vectorize embeddings.
   */
  async extractKnowledge(): Promise<WorkerResult> {
    const start = Date.now();
    const errors: string[] = [];
    let recordsCreated = 0;

    // Get recent observations (last 24h)
    const since24h = Date.now() - 86400000;
    const observations = await db.getObservationsSince(this.env.DB, since24h);

    if (observations.length < 5) {
      return {
        worker: "distiller",
        success: true,
        summary: "Not enough observations (need 5+) to distill insights",
        duration_ms: Date.now() - start,
      };
    }

    // Get active matters and tasks for context
    const matters = await db.getRecordsByType(this.env.DB, "matter", 50);
    const tasks = await db.getRecordsByType(this.env.DB, "task", 50);

    const llm = createChatClient(this.env);

    const insights = await llm.chatJSON<{
      instincts: Array<{ title: string; content: string; metadata?: Record<string, unknown> }>;
      decisions: Array<{ title: string; content: string; metadata?: Record<string, unknown> }>;
      connections: Array<{ source_title: string; target_title: string; relation: string }>;
    }>(
      [
        { role: "system", content: DISTILLER_SYSTEM },
        {
          role: "user",
          content: `Analyze the following data and extract insights.

Recent observations (${observations.length}):
${observations.map((o) => `- [${o.source}] ${o.signal}`).join("\n")}

Active matters (${matters.length}):
${matters.map((m) => `- ${m.title}`).join("\n")}

Active tasks (${tasks.length}):
${tasks.map((t) => `- ${t.title}`).join("\n")}

Return JSON:
{
  "instincts": [{ "title": "...", "content": "..." }],
  "decisions": [{ "title": "...", "content": "..." }],
  "connections": [{ "source_title": "...", "target_title": "...", "relation": "..." }]
}`,
        },
      ],
      { temperature: 0.5, max_tokens: 4096 }
    );

    // Create instinct records
    for (const inst of insights.instincts ?? []) {
      const record = await db.createRecord(this.env.DB, {
        type: "instinct",
        title: inst.title,
        content: inst.content,
        metadata: inst.metadata,
      });
      recordsCreated++;
      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `Distiller created instinct: ${inst.title}`,
        source: "distiller",
        confidence: 0.8,
      });
    }

    // Create decision records
    for (const dec of insights.decisions ?? []) {
      const record = await db.createRecord(this.env.DB, {
        type: "decision",
        title: dec.title,
        content: dec.content,
        metadata: dec.metadata,
      });
      recordsCreated++;
      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `Distiller created decision: ${dec.title}`,
        source: "distiller",
        confidence: 0.85,
      });
    }

    // Create edges for discovered connections
    for (const conn of insights.connections ?? []) {
      const sourceResults = await db.searchRecords(this.env.DB, conn.source_title, 1);
      const targetResults = await db.searchRecords(this.env.DB, conn.target_title, 1);
      if (sourceResults.length > 0 && targetResults.length > 0) {
        await db.createEdge(this.env.DB, sourceResults[0].id, targetResults[0].id, conn.relation);
      }
    }

    // Index new records in Vectorize
    await this.indexRecentRecords();

    this.setState({
      lastRunAt: Date.now(),
      totalRuns: this.state.totalRuns + 1,
      insightsGenerated: this.state.insightsGenerated + recordsCreated,
    });

    return {
      worker: "distiller",
      success: errors.length === 0,
      summary: `Generated ${recordsCreated} insight records from ${observations.length} observations`,
      recordsCreated,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Index recently created/updated records into Vectorize for semantic search.
   */
  async indexRecentRecords(): Promise<void> {
    try {
      const since = Date.now() - 3600000;
      const rows = await this.env.DB
        .prepare(
          `SELECT id, type, title, content FROM records WHERE updated_at >= ? AND status = 'active' LIMIT 100`
        )
        .bind(since)
        .all<{ id: string; type: string; title: string; content: string | null }>();

      if (!rows.results || rows.results.length === 0) return;

      const texts = rows.results.map(
        (r) => `${r.type}: ${r.title}${r.content ? ` - ${r.content.slice(0, 500)}` : ""}`
      );
      const embeddings = (await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: texts,
      })) as { data: number[][] };

      const vectors = rows.results.map((r, i) => ({
        id: r.id,
        values: embeddings.data[i],
        metadata: { type: r.type, title: r.title },
      }));

      await this.env.VECTORIZE.upsert(vectors);
    } catch (err) {
      console.error("[distiller] Vectorize indexing failed:", err);
    }
  }
}
