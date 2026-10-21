/**
 * Mission tools (KISS D1 missions, tenant-scoped) — the same rows the board and MCP show.
 * Completion is gated: `mission_complete` requires evidence, and the end-of-mission review
 * (src/alfred/review.ts) decides whether the run may teach lessons.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Env } from "../../lib/env";
import { actMission, createMission, listMissions } from "../../lib/kiss";

const CreateParams = Type.Object({ objective: Type.String({ minLength: 3, maxLength: 2000 }) });
const ActParams = Type.Object({
  id: Type.String(),
  act: Type.Union([Type.Literal("open"), Type.Literal("archive")]),
});
const CompleteParams = Type.Object({
  id: Type.String(),
  evidence: Type.String({ minLength: 10, maxLength: 4000, description: "What was done and how it was verified (links, outputs, ids)." }),
});

export function missionTools(env: Env, tenantId: string, onEvidence: (id: string, evidence: string) => void): ToolRegistration[] {
  const list: ToolRegistration = {
    name: "mission_list",
    description: "List the owner's missions (id, objective, status).",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      return { output: [{ type: "text", text: JSON.stringify(await listMissions(env, tenantId)) }] };
    },
  };
  const create: ToolRegistration<typeof CreateParams> = {
    name: "mission_create",
    description: "Create a new mission with a clear objective.",
    parameters: CreateParams,
    replay: "unsafe",
    async execute({ objective }) {
      return { output: [{ type: "text", text: JSON.stringify(await createMission(env, tenantId, objective)) }] };
    },
  };
  const act: ToolRegistration<typeof ActParams> = {
    name: "mission_act",
    description: "Re-open or archive a mission. To close one, use mission_complete with evidence.",
    parameters: ActParams,
    replay: "safe",
    async execute({ id, act }) {
      return { output: [{ type: "text", text: JSON.stringify(await actMission(env, tenantId, id, act)) }] };
    },
  };
  const complete: ToolRegistration<typeof CompleteParams> = {
    name: "mission_complete",
    description: "Close a mission. Evidence before done: state what was done and how it was verified.",
    parameters: CompleteParams,
    replay: "safe",
    async execute({ id, evidence }) {
      onEvidence(id, evidence);
      return { output: [{ type: "text", text: JSON.stringify(await actMission(env, tenantId, id, "close")) }] };
    },
  };
  return [list, create, act, complete] as unknown as ToolRegistration[];
}
