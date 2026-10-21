import { test } from "node:test";
import assert from "node:assert/strict";
import { getMCPTools, handleMCP, type MCPIdentity } from "./server.ts";
import { parseScopes } from "../lib/agent-tokens.ts";

const agent = (scopes: string[], isOwner = false): MCPIdentity =>
  ({ email: "agent:t", tenant_id: "t1", isOwner, via: "agent_token", scopes: parseScopes(scopes) }) as MCPIdentity;

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) =>
  new Request("https://mcp.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

test("tools are filtered by scope; mission_create is owner-only", () => {
  const names = (who: MCPIdentity) => getMCPTools(who).map((t) => t.name);
  assert.deepEqual(names(agent(["report:read"])), ["report"]);
  assert.ok(!names(agent(["missions:write", "missions:read"])).includes("mission_create"));
  assert.ok(names(agent(["missions:write"], true)).includes("mission_create"));
});

test("unknown scopes are rejected", () => {
  assert.throws(() => parseScopes(["admin"]), /unknown scope/);
});

test("calling a tool outside the token's scopes is refused", async () => {
  const res = await handleMCP(rpc("tools/call", { name: "spend", arguments: {} }), {} as never, agent(["report:read"]));
  const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /forbidden/);
});

test("initialize negotiates protocol; notifications get 202", async () => {
  const res = await handleMCP(rpc("initialize", { protocolVersion: "2025-03-26" }), {} as never, agent(["ask"]));
  assert.equal(((await res.json()) as { result: { protocolVersion: string } }).result.protocolVersion, "2025-03-26");
  const n = await handleMCP(rpc("notifications/initialized", {}, undefined), {} as never, agent(["ask"]));
  assert.equal(n.status, 202);
});
