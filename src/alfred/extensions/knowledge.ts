/**
 * Knowledge-graph tools over the Missions knowledge graph (D1), as Pi tools.
 * Owner-only: records are not tenant-scoped, so these are installed only in the owner's DO.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import * as kg from "../../../apps/missions/src/lib/db";

const RECORD_TYPES = [
  "matter", "task", "note", "person", "org", "place",
  "asset", "chore", "instinct", "decision", "briefing", "daybook", "commitment",
] as const;

const CreateParams = Type.Object({
  type: Type.Union(RECORD_TYPES.map((t) => Type.Literal(t))),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  content: Type.Optional(Type.String({ maxLength: 20000 })),
});
const IdParams = Type.Object({ id: Type.String() });
const SearchParams = Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) });
const LinkParams = Type.Object({ source_id: Type.String(), target_id: Type.String(), relation: Type.String() });
const ObserveParams = Type.Object({ record_id: Type.String(), signal: Type.String() });

const text = (v: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function knowledgeTools(db: D1Database): ToolRegistration[] {
  const D = db as never;
  const tools: ToolRegistration[] = [
    {
      name: "kg_create",
      description: "Create a knowledge-graph record (matter, task, note, person, org, decision, ...).",
      parameters: CreateParams,
      replay: "unsafe",
      async execute(a: { type: (typeof RECORD_TYPES)[number]; title: string; content?: string }) {
        const r = await kg.createRecord(D, { type: a.type, title: a.title, content: a.content });
        return text({ id: r.id, type: r.type, title: r.title });
      },
    },
    {
      name: "kg_get",
      description: "Get a knowledge-graph record by id.",
      parameters: IdParams,
      replay: "safe",
      async execute(a: { id: string }) {
        return text((await kg.getRecord(D, a.id)) ?? { error: "not found" });
      },
    },
    {
      name: "kg_search",
      description: "Keyword search over knowledge-graph records.",
      parameters: SearchParams,
      replay: "safe",
      async execute(a: { query: string; limit?: number }) {
        const rows = await kg.searchRecords(D, a.query, a.limit ?? 20);
        return text(rows.map((r) => ({ id: r.id, type: r.type, title: r.title, status: r.status })));
      },
    },
    {
      name: "kg_link",
      description: "Link two records with a typed relation (assigned_to, part_of, references, ...).",
      parameters: LinkParams,
      replay: "unsafe",
      async execute(a: { source_id: string; target_id: string; relation: string }) {
        return text(await kg.createEdge(D, a.source_id, a.target_id, a.relation));
      },
    },
    {
      name: "kg_observe",
      description: "Log an observation about a record (audit trail).",
      parameters: ObserveParams,
      replay: "unsafe",
      async execute(a: { record_id: string; signal: string }) {
        return text(await kg.createObservation(D, { record_id: a.record_id, signal: a.signal, source: "alfred", confidence: 1 } as never));
      },
    },
  ] as unknown as ToolRegistration[];
  return tools;
}
