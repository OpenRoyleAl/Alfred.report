/**
 * ORAL identity: the same verified Cloudflare Access sign-in as the web Worker. The voice agent
 * instance is named by the caller's tenant, so a socket can only reach its own tenant's ORAL and
 * Alfred objects. Owners (OWNER_EMAILS) may start missions; everyone else is a sandbox tenant.
 */
import { isOwnerEmail, ownerEmails, tenantFromEmail, verifyAccessEmail, type AccessEnv } from "../../../src/lib/access.ts";

export interface OralIdentity {
  email: string;
  tenant: string;
  isOwner: boolean;
}

export async function identify(req: Request, env: AccessEnv): Promise<OralIdentity | null> {
  const email = await verifyAccessEmail(req, env);
  if (!email) return null;
  return { email, tenant: tenantFromEmail(email), isOwner: isOwnerEmail(env, email) };
}

/** Owner check for an agent instance from its name alone (the Worker only routes verified tenants). */
export function isOwnerTenant(env: AccessEnv, tenant: string): boolean {
  return ownerEmails(env).some((e) => tenantFromEmail(e) === tenant);
}

/** `/agents/<class>/<name>`: the instance name must be the caller's own tenant. */
export function agentNameAllowed(routeName: string, id: OralIdentity): boolean {
  return routeName === id.tenant;
}
