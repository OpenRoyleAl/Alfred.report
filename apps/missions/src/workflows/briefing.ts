import { primeSecrets } from "../lib/secrets";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../workers/curator";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { MISSIONS_SYSTEM } from "../prompts";

/**
 * BriefingWorkflow — durable daily briefing generation.
 * Triggered by cron at 0 8 * * * (8am UTC).
 *
 * Steps:
 * 2. Run Curator to process overnight inbox
 * 3. Run Distiller to extract insights
 * 4. Gather stats and generate briefing via the model router
 * 5. Store briefing as a record + R2 content
 */
export class BriefingWorkflow extends WorkflowEntrypoint<Env, { date?: string }> {
  async run(event: Readonly<WorkflowEvent<{ date?: string }>>, step: WorkflowStep) {
    await primeSecrets(this.env);
    const date = event.payload?.date ?? new Date().toISOString().split("T")[0];

    // Step 1: Process overnight inbox
    const curatorResult = await step.do(
      "process-inbox",
      async () => {
        const items = await db.getUnprocessedInbox(this.env.DB, 50);
        let processed = 0;
        const llm = createChatClient(this.env);

        for (const item of items) {
          try {
            // Simple triage: create a note record for each unprocessed item
            const record = await db.createRecord(this.env.DB, {
              type: "note",
              title: `Inbox: ${item.source} — ${item.raw_content.slice(0, 80)}`,
              content: item.raw_content,
              metadata: { source: item.source, inbox_id: item.id },
            });
            await db.createObservation(this.env.DB, {
              record_id: record.id,
              signal: `BriefingWorkflow processed inbox item from ${item.source}`,
              source: "curator",
              confidence: 0.8,
            });
            await db.markInboxProcessed(this.env.DB, item.id);
            processed++;
          } catch {
            // Continue on error — don't fail the whole workflow
          }
        }
        return { processed, total: items.length };
      }
    );

    // Step 2: Gather stats
    const stats = await step.do("gather-stats", async () => {
      const mattersActive = await db.countRecords(this.env.DB, "matter");
      const tasks = await db.getRecordsByType(this.env.DB, "task", 200);
      const tasksPending = tasks.filter((t) => t.status === "active").length;
      const tasksCompleted = tasks.filter((t) => t.status === "completed").length;
      const since24h = Date.now() - 86400000;
      const observations = await db.getObservationsSince(this.env.DB, since24h);
      return {
        matters_active: mattersActive,
        tasks_pending: tasksPending,
        tasks_completed: tasksCompleted,
        observations_24h: observations.length,
        recent_observations: observations.slice(0, 20).map((o) => o.signal),
      };
    });

    // Step 3: Generate briefing via the model router
    const briefing = await step.do("generate-briefing", async () => {
      const llm = createChatClient(this.env);
      const result = await llm.chatJSON<{ insights: string[]; priorities: string[] }>(
        [
          { role: "system", content: MISSIONS_SYSTEM },
          {
            role: "user",
            content: `Generate the owner's daily briefing for ${date}.

Current stats:
- Active matters: ${stats.matters_active}
- Pending tasks: ${stats.tasks_pending}
- Completed tasks (24h): ${stats.tasks_completed}
- Observations (24h): ${stats.observations_24h}

Recent observations:
${stats.recent_observations.map((o, i) => `${i + 1}. ${o}`).join("\n")}

Return JSON:
{
  "insights": ["<insight 1>", "<insight 2>", ...],
  "priorities": ["<priority 1>", "<priority 2>", ...]
}`,
          },
        ],
        { temperature: 0.5 }
      );
      return result;
    });

    // Step 4: Store briefing
    const briefingContent = await step.do("store-briefing", async () => {
      const content = `# Daily Briefing — ${date}

## Stats
- Active matters: ${stats.matters_active}
- Pending tasks: ${stats.tasks_pending}
- Completed tasks (24h): ${stats.tasks_completed}
- Observations (24h): ${stats.observations_24h}
- Inbox processed: ${curatorResult.processed}/${curatorResult.total}

## Insights
${briefing.insights.map((i) => `- ${i}`).join("\n")}

## Priorities
${briefing.priorities.map((p) => `- ${p}`).join("\n")}
`;
      const r2Key = `briefings/${date}.md`;
      await this.env.CONTENT.put(r2Key, content, {
        httpMetadata: { contentType: "text/markdown" },
      });

      const record = await db.createRecord(this.env.DB, {
        type: "briefing",
        title: `Daily Briefing — ${date}`,
        content,
        content_r2_key: r2Key,
        metadata: {
          matters_active: stats.matters_active,
          tasks_pending: stats.tasks_pending,
          tasks_completed: stats.tasks_completed,
          observations_24h: stats.observations_24h,
          inbox_processed: curatorResult.processed,
        },
      });

      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `BriefingWorkflow generated daily briefing for ${date}`,
        source: "orchestrator",
        confidence: 1.0,
      });

      return { record_id: record.id, r2_key: r2Key, content };
    });

    return {
      date,
      record_id: briefingContent.record_id,
      insights: briefing.insights.length,
      priorities: briefing.priorities.length,
      inbox_processed: curatorResult.processed,
    };
  }
}
