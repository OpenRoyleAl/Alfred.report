/**
 * ORAL identity: devices and agents only (Siri Shortcuts, other agents, hardware), never human
 * browser sign-in (humans use voice inside their signed-in web app). Every request must carry a
 * per-tenant agent token with the `voice` scope (minted, hashed and revocable via
 * /api/alfred/agent-tokens on the web Worker). No token -> 401.
 *
 * The ORAL / Alfred instance is named by the token's tenant. A voice token on the owner tenant
 * (only the owner can mint one) carries the owner's voice powers (draft + "Go Max AI!").
 */
import { verifyAgentToken } from "../../../src/lib/agent-tokens.ts";
import { isOwnerTenantId, type TenantEnv } from "../../../src/lib/tenant.ts";

export interface OralIdentity {
  tenant: string;
  isOwner: boolean;
  tokenId: string;
  name: string;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return null;
}

export type OralEnv = TenantEnv & { DB: D1Database };

export async function identify(req: Request, env: OralEnv): Promise<OralIdentity | null> {
  const tok = bearer(req);
  if (!tok) return null;
  // The token table lives in the web D1 (shared binding).
  const row = await verifyAgentToken(env, tok);
  if (!row || !row.scopes.includes("voice")) return null;
  const isOwner = await isOwnerTenantId(env, row.tenant_id);
  return { tenant: row.tenant_id, isOwner, tokenId: row.id, name: row.name };
}

/** `/agents/<class>/<name>`: the instance name must be the caller's own tenant. */
export function agentNameAllowed(routeName: string, id: Pick<OralIdentity, "tenant">): boolean {
  return routeName === id.tenant;
}
