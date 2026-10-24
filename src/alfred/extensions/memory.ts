/**
 * Memory tools backed by Cloudflare Agent Memory (binding MEMORY, profile = tenant).
 * Falls back to the D1 KISS memory rows when the binding is absent (local dev).
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Env } from "../../lib/env";
import { recallMemory, remember } from "../../lib/kiss";
import { kingdom } from "../../lib/agent-memory.ts";

const RememberParams = Type.Object({ content: Type.String({ minLength: 1, maxLength: 4000 }) });
const RecallParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }) });

export function memoryTools(env: Env, tenantId: string, sessionId: () => string): ToolRegistration[] {
  const rememberTool: ToolRegistration<typeof RememberParams> = {
    name: "memory_remember",
    description: "Store one durable fact, decision or instruction about the owner or their work.",
    parameters: RememberParams,
    replay: "unsafe",
    async execute({ content }) {
      if (env.MEMORY) {
        const profile = await kingdom(env, tenantId);
        const m = await profile.remember({ content, sessionId: sessionId() });
        return { output: [{ type: "text", text: `remembered ${m.id}: ${m.summary}` }] };
      }
      await remember(env, tenantId, content);
      return { output: [{ type: "text", text: "remembered (d1)" }] };
    },
  };
  const recallTool: ToolRegistration<typeof RecallParams> = {
    name: "memory_recall",
    description: "Recall what is known about a topic from long-term memory. Returns a grounded answer.",
    parameters: RecallParams,
    replay: "safe",
    async execute({ query }) {
      if (env.MEMORY) {
        const profile = await kingdom(env, tenantId);
        const r = await profile.recall(query, { responseLength: "short" });
        return { output: [{ type: "text", text: r.count ? r.answer : "No matching memories." }] };
      }
      const rows = await recallMemory(env, tenantId, 10);
      return { output: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  };
  return [rememberTool as unknown as ToolRegistration, recallTool as unknown as ToolRegistration];
}
