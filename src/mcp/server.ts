/**
 * Thin MCP for mouths pointed at alfred.report — not mcp.cloudflare.com.
 * Tools: mission_list, mission_act, spend, memory_recall.
 * Frozen: farmer / curator / distiller / janitor / builder.
 */

import type { Env } from "../lib/env";
import {
  actMission,
  getSpendToday,
  listMissions,
  NEURON_CAP,
  readSession,
  recallMemory,
} from "../lib/kiss";

export function getMCPTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "mission_list",
      description: "List KISS missions for the signed-in tenant",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "mission_act",
      description: "Act on a mission (close | archive | open)",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          act: { type: "string", enum: ["close", "archive", "open"] },
        },
        required: ["id", "act"],
      },
    },
    {
      name: "spend",
      description: "Today's neuron spend vs KISS cap (no secrets)",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "memory_recall",
      description: "Recall D1 memory rows for this tenant",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
  ];
}

export async function executeMCPTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  req: Request
): Promise<Record<string, unknown>> {
  const user = await readSession(req, env);
  if (!user) throw new Error("Unauthorized — Bearer session or alfred_kiss cookie");

  switch (name) {
    case "mission_list":
      return { missions: await listMissions(env, user.tenant_id) };
    case "mission_act":
      return actMission(env, user.tenant_id, String(args.id || ""), String(args.act || "open"));
    case "spend": {
      const neurons = await getSpendToday(env, user.tenant_id);
      return { neurons_today: neurons, daily_cap: NEURON_CAP, gateway: "alfred" };
    }
    case "memory_recall":
      return { adapter: "d1", rows: await recallMemory(env, user.tenant_id, Number(args.limit) || 10) };
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

export async function handleMCP(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    jsonrpc: string;
    method: string;
    params?: Record<string, unknown>;
    id: number | string;
  };

  if (body.jsonrpc !== "2.0") {
    return mcpError(body.id, -32600, "Invalid JSON-RPC version");
  }

  switch (body.method) {
    case "initialize":
      return mcpResult(body.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "alfred-report", version: "1.1.0" },
      });

    case "tools/list":
      return mcpResult(body.id, { tools: getMCPTools() });

    case "tools/call": {
      const toolName = body.params?.name as string;
      const toolArgs = (body.params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await executeMCPTool(toolName, toolArgs, env, req);
        return mcpResult(body.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (error) {
        return mcpResult(body.id, {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        });
      }
    }

    default:
      return mcpError(body.id, -32601, `Method not found: ${body.method}`);
  }
}

function mcpResult(id: number | string, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function mcpError(id: number | string, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
