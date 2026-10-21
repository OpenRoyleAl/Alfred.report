import { primeSecrets } from "../lib/secrets";
import { Agent } from "agents";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { buildTriagePrompt, CURATOR_SYSTEM } from "../prompts";
import type { WorkerResult, InboxItem, RecordType } from "../types";

// ─── Environment ────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  VECTORIZE: VectorizeIndex;
  CONFIG: KVNamespace;
  AI: Ai;
  CLOUDFLARE_GATEWAY_ID?: string;
  AUTO_ALLOWED_MODELS?: string;
  AUTO_ALLOWED_PROVIDERS?: string;
  WORKERS_AI_FLOOR?: string;
}

export interface CuratorState {
  lastProcessedAt: number;
  totalProcessed: number;
}

// ─── Curator Agent ─────────────────────────────────────────────

export class Curator extends Agent<Env, CuratorState> {
  async onStart() {
    await primeSecrets(this.env);
  }

  initialState = { lastProcessedAt: 0, totalProcessed: 0 };

  /**
   * Process all unprocessed inbox items into structured records.
   */
  async processInbox(): Promise<WorkerResult> {
    const start = Date.now();
    const errors: string[] = [];
    let recordsCreated = 0;

    const items = await db.getUnprocessedInbox(this.env.DB, 50);
    if (items.length === 0) {
      return {
        worker: "curator",
        success: true,
        summary: "No unprocessed inbox items",
        recordsCreated: 0,
        duration_ms: Date.now() - start,
      };
    }

    const llm = createChatClient(this.env);

    for (const item of items) {
      try {
        const records = await this.triageAndCreate(item, llm);
        recordsCreated += records;
        await db.markInboxProcessed(this.env.DB, item.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Inbox item ${item.id}: ${msg}`);
      }
    }

    this.setState({
      lastProcessedAt: Date.now(),
      totalProcessed: this.state.totalProcessed + items.length,
    });

    return {
      worker: "curator",
      success: errors.length === 0,
      summary: `Processed ${items.length} inbox items, created ${recordsCreated} records`,
      recordsCreated,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Process a single inbox item: use the model router to triage, then create records.
   */
  async triageAndCreate(
    item: InboxItem,
    llm: ReturnType<typeof createChatClient>
  ): Promise<number> {
    const prompt = buildTriagePrompt(item.raw_content);

    const response = await llm.chatJSON<{
      records: Array<{
        type: RecordType;
        title: string;
        content?: string;
        metadata?: Record<string, unknown>;
        edges?: Array<{ relation: string; target_title: string }>;
      }>;
    }>(
      [
        { role: "system", content: CURATOR_SYSTEM },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3 }
    );

    let created = 0;
    const titleToId = new Map<string, string>();

    for (const rec of response.records ?? []) {
      // Store large content in R2
      let contentR2Key: string | null = null;
      if (rec.content && rec.content.length > 5000) {
        contentR2Key = `content/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
        await this.env.CONTENT.put(contentR2Key, rec.content, {
          httpMetadata: { contentType: "text/markdown" },
        });
      }

      const record = await db.createRecord(this.env.DB, {
        type: rec.type,
        title: rec.title,
        content: rec.content && rec.content.length <= 5000 ? rec.content : null,
        content_r2_key: contentR2Key,
        metadata: { ...rec.metadata, source: item.source, inbox_id: item.id },
      });
      titleToId.set(rec.title, record.id);
      created++;

      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `Curator created ${rec.type} record from ${item.source} inbox item`,
        source: "curator",
        confidence: 0.9,
      });
    }

    // Create edges after all records exist
    for (const rec of response.records ?? []) {
      if (!rec.edges) continue;
      const sourceId = titleToId.get(rec.title);
      if (!sourceId) continue;
      for (const edge of rec.edges) {
        const targetId = titleToId.get(edge.target_title);
        if (targetId) {
          await db.createEdge(this.env.DB, sourceId, targetId, edge.relation);
        }
      }
    }

    return created;
  }

  /**
   * Add an item to the inbox manually.
   */
  async addToInbox(
    source: string,
    rawContent: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const item = await db.addToInbox(this.env.DB, { source, raw_content: rawContent, metadata });
    return item.id;
  }
}
