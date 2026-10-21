import { primeSecrets } from "../lib/secrets";
import { Agent } from "agents";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { BUILDER_SYSTEM } from "../prompts";
import type { WorkerResult } from "../types";
import type { Env } from "./curator";

export interface BuilderState {
  lastRunAt: number;
  totalBuilds: number;
  totalDeploys: number;
}

export interface BuildSpec {
  name: string;
  type: "worker" | "static-site" | "d1-schema" | "api-route";
  description: string;
  requirements: string[];
  bindings?: string[];
}

// ─── Builder Agent ──────────────────────────────────────────────

export class Builder extends Agent<Env, BuilderState> {
  async onStart() {
    await primeSecrets(this.env);
  }

  initialState = { lastRunAt: 0, totalBuilds: 0, totalDeploys: 0 };

  /**
   * Generate code for a build spec using the model router.
   */
  async generateCode(spec: BuildSpec): Promise<WorkerResult & { code: string }> {
    const start = Date.now();
    const llm = createChatClient(this.env);

    const code = await llm.chat(
      [
        { role: "system", content: BUILDER_SYSTEM },
        {
          role: "user",
          content: `Generate code for the following spec.

Name: ${spec.name}
Type: ${spec.type}
Description: ${spec.description}
Requirements:
${spec.requirements.map((r) => `- ${r}`).join("\n")}
${spec.bindings ? `Bindings: ${spec.bindings.join(", ")}` : ""}

Return only the code, no explanation. Use TypeScript and Cloudflare Workers conventions.
For Workers: export default { async fetch(req, env, ctx) { ... } }
For D1 schemas: return SQL CREATE TABLE statements.
For static sites: return HTML/CSS/JS.
For API routes: return a Hono-style route handler.`,
        },
      ],
      { temperature: 0.2, max_tokens: 8192 }
    );

    // Store generated code in R2
    const r2Key = `builds/${Date.now()}-${spec.name}.ts`;
    await this.env.CONTENT.put(r2Key, code, {
      httpMetadata: { contentType: "text/typescript" },
    });

    // Create an asset record
    const record = await db.createRecord(this.env.DB, {
      type: "asset",
      title: `Build: ${spec.name}`,
      content: spec.description,
      content_r2_key: r2Key,
      metadata: {
        build_type: spec.type,
        requirements: spec.requirements,
        bindings: spec.bindings,
        status: "generated",
      },
    });

    await db.createObservation(this.env.DB, {
      record_id: record.id,
      signal: `Builder generated ${spec.type} code for ${spec.name} (${code.length} chars)`,
      source: "builder",
      confidence: 0.95,
    });

    this.setState({
      lastRunAt: Date.now(),
      totalBuilds: this.state.totalBuilds + 1,
      totalDeploys: this.state.totalDeploys,
    });

    return {
      worker: "builder",
      success: true,
      summary: `Generated ${spec.type} code for ${spec.name}, stored at ${r2Key}`,
      recordsCreated: 1,
      duration_ms: Date.now() - start,
      code,
    };
  }

  /**
   * Generate a D1 schema from a natural language description.
   */
  async generateSchema(description: string): Promise<string> {
    const llm = createChatClient(this.env);
    const sql = await llm.chat(
      [
        { role: "system", content: BUILDER_SYSTEM },
        {
          role: "user",
          content: `Generate a D1-compatible SQLite schema for: ${description}

Return only SQL CREATE TABLE statements with proper indexes. Use INTEGER for timestamps (epoch ms), TEXT for IDs, and JSON for flexible metadata.`,
        },
      ],
      { temperature: 0.1, max_tokens: 4096 }
    );

    return sql.trim();
  }

  /**
   * Optimize an existing Worker's code.
   */
  async optimizeCode(currentCode: string, issues: string[]): Promise<string> {
    const llm = createChatClient(this.env);
    const optimized = await llm.chat(
      [
        { role: "system", content: BUILDER_SYSTEM },
        {
          role: "user",
          content: `Optimize the following Cloudflare Worker code.

Issues to fix:
${issues.map((i) => `- ${i}`).join("\n")}

Current code:
\`\`\`typescript
${currentCode}
\`\`\`

Return only the optimized code, no explanation. Focus on:
- Reducing D1 row reads (add indexes, batch queries)
- Minimizing Worker CPU time
- Using ctx.waitUntil() for non-critical async work
- Caching with Cache API where appropriate`,
        },
      ],
      { temperature: 0.2, max_tokens: 8192 }
    );

    return optimized.trim();
  }
}
