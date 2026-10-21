/**
 * Alfred's MCP for public and private agents (mcp.<DOMAIN>/mcp, also <DOMAIN>/mcp behind Access).
 * Streamable HTTP, JSON responses. Every call is authenticated (index.ts): Access JWT, the owner
 * ops/agent token, or a per-tenant scoped agent token (lib/agent-tokens.ts). The tenant always comes
 * from that identity, never from the request. Tools are filtered and enforced by scope.
 */

import { mcpAllow, mcpProtocol, mcpScopes, mcpTools } from "../alfred/core.ts";
import type { Env } from "../lib/env";
import type { VerifiedIdentity } from "../lib/access";
import type { AgentScope } from "../lib/agent-tokens.ts";

export interface MCPIdentity extends VerifiedIdentity {
  scopes: readonly AgentScope[];
  tokenId?: string;
}

/** Access users and owner tokens hold every scope; agent tokens hold what they were minted with. */
export function fullScopes(): readonly AgentScope[] {
  return mcpScopes() as AgentScope[];
}

/** The tenant Durable Object methods the MCP uses (typed narrowly; RPC stub types are too deep). */
interface AlfredRpc {
  bind(tenantId: string, isOwner: boolean): Promise<void>;
  getMission(id: string): Promise<unknown>;
  startMission(objective: string, opts: { requireEvidence?: boolean }): Promise<{ missionId: string }>;
  consumeQuota(kind: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }>;
  ask(prompt: string): Promise<unknown>;
  report(limit?: number): Promise<{ items: unknown[] }>;
}

export function getMCPTools(who: MCPIdentity): Array<Record<string, unknown>> {
  return mcpTools(who.scopes, who.isOwner);
}

function quota(v: string | undefined): number {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export async function executeMCPTool(name: string, args: Record<string, unknown>, env: Env, who: MCPIdentity): Promise<unknown> {
  mcpAllow(name, who.scopes, who.isOwner);
  const bound = async (): Promise<AlfredRpc> => {
    const s = env.ALFRED.getByName(who.tenant_id) as unknown as AlfredRpc;
    await s.bind(who.tenant_id, who.isOwner);
    return s;
  };
  const { actMission, getSpendToday, listMissions, NEURON_CAP, recallMemory } = await import("../lib/kiss");
  switch (name) {
    case "mission_list":
      return { missions: await listMissions(env, who.tenant_id), alfred: (await (await bound()).report(20)).items };
    case "mission_get": {
      const id = String(args.id || "");
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error("invalid id");
      return (await (await bound()).getMission(id)) ?? { error: "not found" };
    }
    case "mission_create": {
      const objective = String(args.objective || "").trim().slice(0, 4000);
      if (objective.length < 3) throw new Error("objective required");
      return (await bound()).startMission(objective, { requireEvidence: Boolean(args.requireEvidence) });
    }
    case "mission_act":
      return actMission(env, who.tenant_id, String(args.id || ""), String(args.act || "open"));
    case "ask": {
      const prompt = String(args.prompt || "").trim().slice(0, 8000);
      if (!prompt) throw new Error("prompt required");
      const s = await bound();
      const q = await s.consumeQuota("ask", quota(env.SANDBOX_ASKS_PER_DAY));
      if (!q.ok) throw new Error(`quota: ${q.used}/${q.limit} asks today`);
      return s.ask(prompt);
    }
    case "report":
      return (await bound()).report();
    case "spend":
      return { neurons_today: await getSpendToday(env, who.tenant_id), daily_cap: NEURON_CAP, gateway: env.CLOUDFLARE_GATEWAY_ID };
    case "memory_recall":
      return { rows: await recallMemory(env, who.tenant_id, Math.min(50, Math.max(1, Number(args.limit) || 10))) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

type RpcId = number | string | null;
interface Rpc {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMCP(req: Request, env: Env, who: MCPIdentity): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Rpc | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return mcpError(null, -32700, "Parse error");
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return mcpError(body.id ?? null, -32600, "Invalid Request");
  // Notifications (no id) get 202 and no body.
  if (body.id === undefined || body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
  const id = body.id;
  switch (body.method) {
    case "initialize": {
      const asked = String(body.params?.protocolVersion || "");
      return mcpResult(id, {
        protocolVersion: mcpProtocol(asked),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "alfred-report", version: "2.0.0" },
        instructions: `Alfred MCP for tenant ${who.tenant_id}. Scopes: ${who.scopes.join(", ")}.`,
      });
    }
    case "ping":
      return mcpResult(id, {});
    case "tools/list":
      return mcpResult(id, { tools: getMCPTools(who) });
    case "tools/call": {
      const name = String(body.params?.name || "");
      const args = (body.params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await executeMCPTool(name, args, env, who);
        return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return mcpResult(id, { content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
      }
    }
    default:
      return mcpError(id, -32601, `Method not found: ${body.method}`);
  }
}

function mcpResult(id: RpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

export function mcpError(id: RpcId, code: number, message: string, status = 200, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers });
}
