import { Agent } from "agents";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { buildMaintenancePrompt, JANITOR_SYSTEM } from "../prompts";
import type { WorkerResult, MaintenanceReport } from "../types";
import type { Env } from "./curator";

export interface JanitorState {
  lastRunAt: number;
  totalRuns: number;
}

// ─── Janitor Agent ─────────────────────────────────────────────

export class Janitor extends Agent<Env, JanitorState> {
  initialState = { lastRunAt: 0, totalRuns: 0 };

  /**
   * Full maintenance run: find and fix broken edges, orphans, stale records.
   */
  async runMaintenance(): Promise<WorkerResult & { report: MaintenanceReport }> {
    const start = Date.now();
    const errors: string[] = [];

    // 1. Find broken edges
    const brokenEdges = await db.findBrokenEdges(this.env.DB);
    let edgesCleaned = 0;
    for (const edge of brokenEdges) {
      try {
        await db.deleteEdge(this.env.DB, edge.id);
        edgesCleaned++;
      } catch (err) {
        errors.push(`Failed to delete edge ${edge.id}: ${err}`);
      }
    }

    // 2. Find orphan records
    const orphans = await db.findOrphanRecords(this.env.DB);

    // 3. Find stale records
    const stale = await db.findStaleRecords(this.env.DB, 90);

    // 4. Use the model router to decide what to archive/delete
    let archived = 0;
    if (orphans.length > 0 || stale.length > 0) {
      const llm = createChatClient(this.env);
      try {
        const plan = await llm.chatJSON<{
          archive_ids: string[];
          delete_edge_ids: string[];
          create_edges: Array<{ source_id: string; target_id: string; relation: string }>;
          reasoning: string;
        }>(
          [
            { role: "system", content: JANITOR_SYSTEM },
            { role: "user", content: buildMaintenancePrompt(orphans.length, brokenEdges.length, stale.length) },
          ],
          { temperature: 0.2 }
        );

        // Archive recommended records
        for (const id of plan.archive_ids ?? []) {
          await db.updateRecord(this.env.DB, id, { status: "archived" });
          archived++;
          await db.createObservation(this.env.DB, {
            record_id: id,
            signal: `Janitor archived record: ${plan.reasoning}`,
            source: "janitor",
            confidence: 0.85,
          });
        }

        // Create suggested edges
        for (const edge of plan.create_edges ?? []) {
          await db.createEdge(this.env.DB, edge.source_id, edge.target_id, edge.relation);
        }
      } catch (err) {
        errors.push(`maintenance planning failed: ${err}`);
      }
    }

    // 5. Log observations
    await db.createObservation(this.env.DB, {
      signal: `Janitor maintenance run: ${brokenEdges.length} broken edges, ${orphans.length} orphans, ${stale.length} stale, ${archived} archived`,
      source: "janitor",
      confidence: 1.0,
    });

    this.setState({ lastRunAt: Date.now(), totalRuns: this.state.totalRuns + 1 });

    const report: MaintenanceReport = {
      broken_links: brokenEdges.length,
      orphan_records: orphans.length,
      stale_records: stale.length,
      archived,
      edges_cleaned: edgesCleaned,
      observations_logged: 1,
      duration_ms: Date.now() - start,
    };

    return {
      worker: "janitor",
      success: errors.length === 0,
      summary: `Cleaned ${edgesCleaned} edges, archived ${archived} records, found ${orphans.length} orphans`,
      recordsUpdated: archived,
      recordsDeleted: edgesCleaned,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: Date.now() - start,
      report,
    };
  }

  /**
   * Quick cleanup: just remove broken edges without LLM.
   */
  async quickClean(): Promise<{ edgesRemoved: number }> {
    const brokenEdges = await db.findBrokenEdges(this.env.DB);
    for (const edge of brokenEdges) {
      await db.deleteEdge(this.env.DB, edge.id);
    }
    return { edgesRemoved: brokenEdges.length };
  }
}
