/**
 * Per-tenant scoped bearer tokens for agents that call Alfred's MCP (mcp.<DOMAIN>).
 * Only a SHA-256 hash is stored (D1); the token is shown once at mint time.
 * Tokens are accepted by the MCP endpoint and (scope `voice`) by ORAL, never by the rest of the API.
 */
import { mcpParseScopes, mcpTokenOk } from "../alfred/core.ts";
/** Only the D1 binding is needed (keeps this importable from the ORAL Worker). */
type Env = { DB: D1Database };

export const AGENT_SCOPES = [
  "missions:read",
  "missions:write",
  "ask",
  "report:read",
  "spend:read",
  "memory:read",
  "memory:write",
  "voice", // ORAL (oral.<DOMAIN>): devices/agents/Siri Shortcuts; not accepted by MCP tools
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export const TOKEN_PREFIX = "art_";
const TABLE = "alfred_report_agent_tokens";

export interface AgentTokenRow {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const ready = new WeakSet<D1Database>();
async function ensure(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, revoked_at TEXT)`
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS ${TABLE}_tenant ON ${TABLE}(tenant_id)`),
  ]);
  ready.add(db);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return TOKEN_PREFIX + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseScopes(input: unknown): AgentScope[] {
  return mcpParseScopes(input) as AgentScope[];
}

export async function mintAgentToken(
  env: Env,
  o: { tenant_id: string; name: string; scopes: AgentScope[]; created_by: string }
): Promise<{ id: string; token: string; tenant_id: string; name: string; scopes: AgentScope[] }> {
  await ensure(env.DB);
  if (!o.scopes.length) throw new Error("at least one scope required");
  const id = crypto.randomUUID();
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO ${TABLE} (id, tenant_id, name, token_hash, scopes, created_by) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, o.tenant_id, o.name.slice(0, 80), await sha256Hex(token), o.scopes.join(","), o.created_by)
    .run();
  return { id, token, tenant_id: o.tenant_id, name: o.name, scopes: o.scopes };
}

export async function verifyAgentToken(
  env: Env,
  bearer: string
): Promise<{ id: string; tenant_id: string; name: string; scopes: AgentScope[] } | null> {
  if (!mcpTokenOk(bearer)) return null;
  await ensure(env.DB);
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, name, scopes FROM ${TABLE} WHERE token_hash = ? AND revoked_at IS NULL`
  )
    .bind(await sha256Hex(bearer))
    .first<{ id: string; tenant_id: string; name: string; scopes: string }>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE ${TABLE} SET last_used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
  return { ...row, scopes: parseScopes(row.scopes) };
}

export async function listAgentTokens(env: Env, tenant_id?: string): Promise<AgentTokenRow[]> {
  await ensure(env.DB);
  const sql = `SELECT id, tenant_id, name, scopes, created_by, created_at, last_used_at, revoked_at FROM ${TABLE}`;
  const r = tenant_id
    ? await env.DB.prepare(`${sql} WHERE tenant_id = ? ORDER BY created_at DESC`).bind(tenant_id).all<AgentTokenRow>()
    : await env.DB.prepare(`${sql} ORDER BY created_at DESC`).all<AgentTokenRow>();
  return r.results;
}

export async function revokeAgentToken(env: Env, id: string, tenant_id?: string): Promise<boolean> {
  await ensure(env.DB);
  const r = tenant_id
    ? await env.DB.prepare(`UPDATE ${TABLE} SET revoked_at = datetime('now') WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`).bind(id, tenant_id).run()
    : await env.DB.prepare(`UPDATE ${TABLE} SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

/** RFC 7009 revoke by the token value itself (the agent revoking its own key). */
export async function revokeAgentTokenValue(env: Env, token: string): Promise<boolean> {
  if (!mcpTokenOk(token)) return false;
  await ensure(env.DB);
  const r = await env.DB.prepare(`UPDATE ${TABLE} SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`).bind(await sha256Hex(token)).run();
  return (r.meta.changes ?? 0) > 0;
}
