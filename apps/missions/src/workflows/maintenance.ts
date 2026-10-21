import { primeSecrets } from "../lib/secrets";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../workers/curator";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { JANITOR_SYSTEM, DISTILLER_SYSTEM, FARMER_SYSTEM } from "../prompts";
import { buildMaintenancePrompt } from "../prompts";

/**
 * MaintenanceWorkflow — durable nightly maintenance.
 * Triggered by cron at 0 2 * * * (2am UTC).
 *
 * Steps:
 * 1. Janitor: clean broken edges, find orphans, archive stale records
 * 2. Distiller: extract knowledge from the day's observations
 * 3. Farmer: scan for overnight growth opportunities
 * 4. Store maintenance report as a daybook record
 */
export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, { date?: string }> {
  async run(event: Readonly<WorkflowEvent<{ date?: string }>>, step: WorkflowStep) {
    await primeSecrets(this.env);
    const date = event.payload?.date ?? new Date().toISOString().split("T")[0];

    // Step 1: Janitor — clean broken edges
    const janitorResult = await step.do("janitor-clean", async () => {
      const brokenEdges = await db.findBrokenEdges(this.env.DB);
      let edgesCleaned = 0;
      for (const edge of brokenEdges) {
        try {
          await db.deleteEdge(this.env.DB, edge.id);
          edgesCleaned++;
        } catch {
          // Continue on error
        }
      }
      return { broken_links: brokenEdges.length, edges_cleaned: edgesCleaned };
    });

    // Step 2: Janitor — find orphans and stale records, use the model router for decisions
    const cleanupResult = await step.do("janitor-archive", async () => {
      const orphans = await db.findOrphanRecords(this.env.DB);
      const stale = await db.findStaleRecords(this.env.DB, 90);

      let archived = 0;
      if (orphans.length > 0 || stale.length > 0) {
        const llm = createChatClient(this.env);
        try {
          const plan = await llm.chatJSON<{
            archive_ids: string[];
            create_edges: Array<{ source_id: string; target_id: string; relation: string }>;
            reasoning: string;
          }>(
            [
              { role: "system", content: JANITOR_SYSTEM },
              {
                role: "user",
                content: buildMaintenancePrompt(orphans.length, janitorResult.broken_links, stale.length),
              },
            ],
            { temperature: 0.2 }
          );

          for (const id of plan.archive_ids ?? []) {
            await db.updateRecord(this.env.DB, id, { status: "archived" });
            archived++;
            await db.createObservation(this.env.DB, {
              record_id: id,
              signal: `MaintenanceWorkflow archived: ${plan.reasoning}`,
              source: "janitor",
              confidence: 0.85,
            });
          }

          for (const edge of plan.create_edges ?? []) {
            await db.createEdge(this.env.DB, edge.source_id, edge.target_id, edge.relation);
          }
        } catch {
          // If the model call fails, just log and continue
        }
      }

      return {
        orphan_records: orphans.length,
        stale_records: stale.length,
        archived,
      };
    });

    // Step 3: Distiller — extract knowledge
    const distillerResult = await step.do("distiller-extract", async () => {
      const since24h = Date.now() - 86400000;
      const observations = await db.getObservationsSince(this.env.DB, since24h);

      if (observations.length < 5) {
        return { insights_generated: 0, observations_analyzed: observations.length };
      }

      const matters = await db.getRecordsByType(this.env.DB, "matter", 50);
      const tasks = await db.getRecordsByType(this.env.DB, "task", 50);
      const llm = createChatClient(this.env);

      const insights = await llm.chatJSON<{
        instincts: Array<{ title: string; content: string }>;
        decisions: Array<{ title: string; content: string }>;
      }>(
        [
          { role: "system", content: DISTILLER_SYSTEM },
          {
            role: "user",
            content: `Analyze and extract insights from ${observations.length} observations.

Observations:
${observations.map((o) => `- [${o.source}] ${o.signal}`).join("\n")}

Active matters: ${matters.map((m) => m.title).join(", ")}
Active tasks: ${tasks.map((t) => t.title).join(", ")}

Return JSON:
{
  "instincts": [{ "title": "...", "content": "..." }],
  "decisions": [{ "title": "...", "content": "..." }]
}`,
          },
        ],
        { temperature: 0.5, max_tokens: 4096 }
      );

      let created = 0;
      for (const inst of insights.instincts ?? []) {
        await db.createRecord(this.env.DB, {
          type: "instinct",
          title: inst.title,
          content: inst.content,
        });
        created++;
      }
      for (const dec of insights.decisions ?? []) {
        await db.createRecord(this.env.DB, {
          type: "decision",
          title: dec.title,
          content: dec.content,
        });
        created++;
      }

      return { insights_generated: created, observations_analyzed: observations.length };
    });

    // Step 4: Farmer — overnight opportunity scan
    const farmerResult = await step.do("farmer-scan", async () => {
      const matters = await db.getRecordsByType(this.env.DB, "matter", 50);
      const orgs = await db.getRecordsByType(this.env.DB, "org", 50);
      const llm = createChatClient(this.env);

      const analysis = await llm.chatJSON<{
        leads: Array<{ org_name: string; reason: string; priority: string }>;
        outreach: Array<{ target_org: string; channel: string; message_draft: string }>;
      }>(
        [
          { role: "system", content: FARMER_SYSTEM },
          {
            role: "user",
            content: `Scan for growth opportunities.

Active matters: ${matters.length}
Organizations: ${orgs.length}

Return JSON:
{
  "leads": [{ "org_name": "...", "reason": "...", "priority": "high|medium|low" }],
  "outreach": [{ "target_org": "...", "channel": "email|linkedin|phone", "message_draft": "..." }]
}`,
          },
        ],
        { temperature: 0.6, max_tokens: 4096 }
      );

      let created = 0;
      for (const lead of analysis.leads ?? []) {
        await db.createRecord(this.env.DB, {
          type: "note",
          title: `Lead: ${lead.org_name}`,
          content: lead.reason,
          metadata: { category: "lead", priority: lead.priority },
        });
        created++;
      }
      for (const outreach of analysis.outreach ?? []) {
        await db.createRecord(this.env.DB, {
          type: "commitment",
          title: `Outreach: ${outreach.target_org}`,
          content: outreach.message_draft,
          metadata: { channel: outreach.channel },
        });
        created++;
      }

      return { leads: analysis.leads?.length ?? 0, outreach: analysis.outreach?.length ?? 0, records_created: created };
    });

    // Step 5: Store maintenance report
    const reportResult = await step.do("store-report", async () => {
      const report = `# Nightly Maintenance Report — ${date}

## Janitor
- Broken links found: ${janitorResult.broken_links}
- Edges cleaned: ${janitorResult.edges_cleaned}
- Orphan records: ${cleanupResult.orphan_records}
- Stale records: ${cleanupResult.stale_records}
- Archived: ${cleanupResult.archived}

## Distiller
- Observations analyzed: ${distillerResult.observations_analyzed}
- Insights generated: ${distillerResult.insights_generated}

## Farmer
- Leads found: ${farmerResult.leads}
- Outreach actions: ${farmerResult.outreach}
- Records created: ${farmerResult.records_created}
`;

      const record = await db.createRecord(this.env.DB, {
        type: "daybook",
        title: `Maintenance — ${date}`,
        content: report,
        metadata: {
          janitor: { ...janitorResult, ...cleanupResult },
          distiller: distillerResult,
          farmer: farmerResult,
        },
      });

      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `MaintenanceWorkflow completed nightly maintenance for ${date}`,
        source: "orchestrator",
        confidence: 1.0,
      });

      return { record_id: record.id };
    });

    return {
      date,
      record_id: reportResult.record_id,
      janitor: { ...janitorResult, ...cleanupResult },
      distiller: distillerResult,
      farmer: farmerResult,
    };
  }
}
