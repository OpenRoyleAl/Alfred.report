/**
 * Agent sign-up for the MCP (auth.md, WorkOS agent-auth "service_auth" shape):
 *
 *   POST mcp.<DOMAIN>/agent/identity {type:"service_auth", login_hint, api_key_name?, client_name?, scope?}
 *     -> { claim: { user_code, verification_uri, verification_uri_complete, expires_in, interval }, claim_token }
 *   the king signs in on <DOMAIN>/connect, enters the code, approves scopes for their own kingdom
 *   POST mcp.<DOMAIN>/oauth2/token grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=...
 *     -> authorization_pending | slow_down | expired_token | access_denied | { access_token, scope }
 *   POST mcp.<DOMAIN>/oauth2/revoke token=<access_token>
 *
 * Decisions are Rust (agent_auth.rs). Stored: SHA-256 of the claim token and of the user code, never
 * the values; the issued key is a normal per-agent token (agent-tokens.ts, hashed, scoped, revocable).
 */
import { agentOp } from "../alfred/core.ts";
import { mintAgentToken, type AgentScope } from "./agent-tokens.ts";
import { noticeAgent } from "./owner-notices.ts";

type Env = { DB: D1Database; DOMAIN?: string };
const T = "alfred_report_agent_claims";
const TRIES = "alfred_report_agent_code_tries";
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ready = new WeakSet<D1Database>();
async function ensure(db: D1Database) {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ${T} (
      id TEXT PRIMARY KEY, claim_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL UNIQUE, login_hint TEXT NOT NULL,
      api_key_name TEXT NOT NULL, client_name TEXT NOT NULL, scopes TEXT NOT NULL, ip_hash TEXT NOT NULL,
      status TEXT NOT NULL, tenant_id TEXT, approved_by TEXT, granted TEXT, token_id TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_poll_at INTEGER)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ${T}_ip ON ${T}(ip_hash, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ${T}_hint ON ${T}(login_hint, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${TRIES} (who TEXT NOT NULL, at INTEGER NOT NULL)`),
  ]);
  ready.add(db);
}

const limits = () => agentOp<{ ttl: number; interval: number; code_tries: number }>("limits", {});

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RegisterOut {
  status: number;
  body: Record<string, unknown>;
}

export async function registerAgent(env: Env, body: unknown, ip: string): Promise<RegisterOut> {
  await ensure(env.DB);
  let r: { login_hint: string; api_key_name: string; client_name: string; scopes: string[] };
  try {
    r = agentOp("register", body ?? {});
  } catch (e) {
    const m = String((e as Error).message).replace(/^alfred-core agent_op: /, "");
    return { status: 400, body: { error: m.startsWith("unsupported") ? "unsupported_identity_type" : "invalid_request", error_description: m } };
  }
  const now = Date.now();
  const ipHash = await sha(`ip:${ip}`);
  const hour = now - 3_600_000;
  const [a, b] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE ip_hash = ? AND created_at >= ?`).bind(ipHash, hour),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE login_hint = ? AND created_at >= ?`).bind(r.login_hint, hour),
  ]);
  const rate = agentOp<{ ok: boolean; retry_after: number }>("rate", {
    ip_hour: Number((a.results?.[0] as { n?: number })?.n ?? 0),
    hint_hour: Number((b.results?.[0] as { n?: number })?.n ?? 0),
  });
  if (!rate.ok) return { status: 429, body: { error: "rate_limit_exceeded", error_description: "too many registrations for this email or network; stop and tell the user", retry_after: rate.retry_after } };
  const { ttl, interval } = limits();
  const userCode = agentOp<{ code: string }>("user_code", { bytes: [...crypto.getRandomValues(new Uint8Array(32))] }).code;
  const claimToken = `clm_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const normalized = agentOp<{ code: string | null }>("normalize", { code: userCode }).code!;
  await env.DB.prepare(
    `INSERT INTO ${T} (id, claim_hash, code_hash, login_hint, api_key_name, client_name, scopes, ip_hash, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
    .bind(crypto.randomUUID(), await sha(claimToken), await sha(`code:${normalized}`), r.login_hint, r.api_key_name, r.client_name, r.scopes.join(" "), ipHash, now, now + ttl * 1000)
    .run();
  const verify = `https://${env.DOMAIN}/connect`;
  return {
    status: 201,
    body: {
      type: "service_auth",
      api_key_name: r.api_key_name,
      scope: r.scopes.join(" "),
      claim: { user_code: userCode, verification_uri: verify, verification_uri_complete: `${verify}?code=${userCode}`, expires_in: ttl, interval },
      claim_token: claimToken,
      token_endpoint: `https://mcp.${env.DOMAIN}/oauth2/token`,
    },
  };
}

export async function pollToken(env: Env, claimToken: string): Promise<RegisterOut> {
  await ensure(env.DB);
  const now = Date.now();
  const row = claimToken
    ? await env.DB.prepare(`SELECT * FROM ${T} WHERE claim_hash = ?`).bind(await sha(claimToken)).first<Record<string, unknown>>()
    : null;
  const d = agentOp<{ action: string; code?: string; detail?: string; touch?: boolean }>("poll", {
    status: row ? String(row.status) : "missing",
    expires_at: Number(row?.expires_at ?? 0),
    last_poll_at: row?.last_poll_at == null ? null : Number(row.last_poll_at),
    now,
  });
  if (row && d.touch) await env.DB.prepare(`UPDATE ${T} SET last_poll_at = ? WHERE id = ?`).bind(now, row.id).run();
  if (d.action !== "issue" || !row) return { status: 400, body: { error: d.code, error_description: d.detail } };
  // Exactly one poll wins the approved -> issued transition (a racing poll gets invalid_grant).
  const won = await env.DB.prepare(`UPDATE ${T} SET status = 'issued' WHERE id = ? AND status = 'approved'`).bind(row.id).run();
  if (!won.meta.changes) return { status: 400, body: { error: "invalid_grant", error_description: "this claim was already exchanged" } };
  const scopes = String(row.granted || "").split(" ").filter(Boolean) as AgentScope[];
  const minted = await mintAgentToken(env, { tenant_id: String(row.tenant_id), name: String(row.api_key_name), scopes, created_by: `agent-signup:${String(row.approved_by)}` });
  await env.DB.prepare(`UPDATE ${T} SET token_id = ? WHERE id = ?`).bind(minted.id, row.id).run();
  await noticeAgent(env.DB, { tenant_id: String(row.tenant_id), api_key_name: String(row.api_key_name), client_name: String(row.client_name), scopes });
  return { status: 200, body: { access_token: minted.token, token_type: "Bearer", expires_in: 0, scope: scopes.join(" "), resource: `https://mcp.${env.DOMAIN}/mcp` } };
}

/** What the king sees before approving (no secrets). Counts a wrong code as a try. */
export async function lookupClaim(env: Env, who: string, code: string): Promise<RegisterOut> {
  await ensure(env.DB);
  const now = Date.now();
  const { code_tries } = limits();
  const tries = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${TRIES} WHERE who = ? AND at >= ?`).bind(who, now - 600_000).first<{ n: number }>();
  if (Number(tries?.n ?? 0) >= code_tries) return { status: 429, body: { error: "too many wrong codes; wait 10 minutes" } };
  const normalized = agentOp<{ code: string | null }>("normalize", { code }).code;
  const row = normalized
    ? await env.DB.prepare(`SELECT id, login_hint, api_key_name, client_name, scopes, status, created_at, expires_at FROM ${T} WHERE code_hash = ?`).bind(await sha(`code:${normalized}`)).first<Record<string, unknown>>()
    : null;
  if (!row || row.status !== "pending" || Number(row.expires_at) <= now) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ${TRIES} VALUES (?, ?)`).bind(who, now),
      env.DB.prepare(`DELETE FROM ${TRIES} WHERE at < ?`).bind(now - 3_600_000),
    ]);
    return { status: 404, body: { error: "code not found or expired" } };
  }
  return { status: 200, body: { id: row.id, login_hint: row.login_hint, api_key_name: row.api_key_name, client_name: row.client_name, scopes: String(row.scopes).split(" "), expires_at: row.expires_at, created_at: row.created_at } };
}

/** The king approves (into their own kingdom) or denies. */
export async function decideClaim(env: Env, who: { tenant_id: string; email: string }, code: string, approve: boolean, approved: unknown): Promise<RegisterOut> {
  const l = await lookupClaim(env, who.email, code);
  if (l.status !== 200) return l;
  const id = String(l.body.id);
  if (!approve) {
    await env.DB.prepare(`UPDATE ${T} SET status = 'denied', approved_by = ? WHERE id = ? AND status = 'pending'`).bind(who.email, id).run();
    return { status: 200, body: { denied: true } };
  }
  let scopes: string[];
  try {
    scopes = agentOp<{ scopes: string[] }>("grant", { requested: l.body.scopes, approved: Array.isArray(approved) ? approved : l.body.scopes }).scopes;
  } catch (e) {
    return { status: 400, body: { error: String((e as Error).message).replace(/^alfred-core agent_op: /, "") } };
  }
  const r = await env.DB.prepare(`UPDATE ${T} SET status = 'approved', tenant_id = ?, approved_by = ?, granted = ? WHERE id = ? AND status = 'pending'`)
    .bind(who.tenant_id, who.email, scopes.join(" "), id)
    .run();
  if (!r.meta.changes) return { status: 409, body: { error: "claim already decided" } };
  return { status: 200, body: { approved: true, scopes, api_key_name: l.body.api_key_name } };
}

export function protectedResourceMetadata(domain: string) {
  return {
    resource: `https://mcp.${domain}/mcp`,
    authorization_servers: [`https://mcp.${domain}`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["missions:read", "missions:write", "ask", "report:read", "spend:read", "memory:read", "memory:write"],
    resource_documentation: `https://mcp.${domain}/auth.md`,
  };
}

export function authorizationServerMetadata(domain: string) {
  const base = `https://mcp.${domain}`;
  return {
    issuer: base,
    agent_identity_endpoint: `${base}/agent/identity`,
    token_endpoint: `${base}/oauth2/token`,
    revocation_endpoint: `${base}/oauth2/revoke`,
    grant_types_supported: [CLAIM_GRANT],
    identity_types_supported: ["service_auth"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: protectedResourceMetadata(domain).scopes_supported,
    service_documentation: `${base}/auth.md`,
  };
}

export function authMd(domain: string, brand: string): string {
  const base = `https://mcp.${domain}`;
  return `# auth.md

You are an agent. ${brand} supports agentic registration: discover -> register -> give the user the setup link and code -> the user approves in their browser -> poll for an access_token -> call the MCP.

## Service

- Resource (MCP, JSON-RPC over HTTP): \`${base}/mcp\`
- Authorization server: \`${base}\`
- Approval page (human only): \`https://${domain}/connect\`

### Scopes

| Scope | Grants |
| --- | --- |
| \`missions:read\` | list and read missions, The Report |
| \`missions:write\` | create missions |
| \`ask\` | ask Alfred (runs one reviewed mission) |
| \`report:read\` | The Report |
| \`spend:read\` | today's spend |
| \`memory:read\` | recall and export this kingdom's memory |
| \`memory:write\` | remember and forget in this kingdom's memory |

Default when you ask for nothing: \`missions:read report:read\`. Ask only for what the task needs; the user can approve fewer.

## Step 1: Discover

    GET ${base}/.well-known/oauth-protected-resource
    GET ${base}/.well-known/oauth-authorization-server

## Step 2: Register

    POST ${base}/agent/identity
    Content-Type: application/json

    {"type":"service_auth","login_hint":"user@example.com","api_key_name":"What this key is for","client_name":"Your agent","scope":"missions:read ask"}

Response: \`claim\` with \`user_code\`, \`verification_uri\`, \`verification_uri_complete\`, \`expires_in\` and \`interval\`, plus \`claim_token\`. Keep \`claim_token\` in memory only.

Errors: \`400 invalid_request\`, \`400 unsupported_identity_type\`, \`429 rate_limit_exceeded\` (stop and tell the user; do not retry in a loop).

## Step 3: Give the user the link and the code (required before polling)

Send the user the full \`claim.verification_uri\` and the full \`claim.user_code\`. Nothing is emailed; if you do not deliver both, setup cannot finish. The code expires in \`expires_in\` seconds.

## Step 4: The user approves (human only)

The user signs in on ${domain}, enters the code, checks the agent name and scopes, and approves for their own kingdom (or denies).

## Step 5: Poll

    POST ${base}/oauth2/token
    Content-Type: application/x-www-form-urlencoded

    grant_type=${CLAIM_GRANT}&claim_token=<clm_...>

Wait \`interval\` seconds between polls. Errors: \`authorization_pending\`, \`slow_down\`, \`access_denied\`, \`expired_token\`, \`invalid_grant\` (stop and report it).
Success: \`{"access_token":"art_...","token_type":"Bearer","expires_in":0,"scope":"..."}\`. The key does not expire; it stops working when revoked. Use it as \`Authorization: Bearer art_...\` on \`${base}/mcp\`.

## Step 6: Revoke

    POST ${base}/oauth2/revoke
    Content-Type: application/x-www-form-urlencoded

    token=<access_token>

The kingdom's owner can also see and revoke every connected agent at https://${domain}/connect.
`;
}
