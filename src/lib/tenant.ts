/**
 * Verified email -> tenant id, one rule for every sign-in path (Access, Google/KISS session, owner
 * token, ORAL). Owners (OWNER_EMAILS, any of them) share ONE owner tenant: the tenant already
 * registered for an owner email in kiss_users (where the owner's existing data lives), else the
 * encoded first owner email. Everyone else: their kiss_users tenant if registered, else the
 * injective encoded email (tenantFromEmail). Read-only: never creates or moves tenant rows.
 */
import { isOwnerEmail, ownerEmails, tenantFromEmail, type AccessEnv } from "./access.ts";

export interface TenantEnv extends AccessEnv {
  DB?: D1Database;
}

let ownerCache: { key: string; tenant: string; at: number } | null = null;

async function kissTenant(db: D1Database | undefined, emails: string[]): Promise<string | null> {
  if (!db || !emails.length) return null;
  try {
    const row = await db
      .prepare(`SELECT tenant_id FROM kiss_users WHERE email IN (${emails.map(() => "?").join(",")}) ORDER BY created_at ASC LIMIT 1`)
      .bind(...emails)
      .first<{ tenant_id: string }>();
    return row?.tenant_id || null;
  } catch {
    return null; // table not created yet on a fresh instance
  }
}

/** Owner tenant cache TTL: short, and only a D1-backed answer is cached (a fallback is re-read). */
export const OWNER_CACHE_MS = 30_000;

/** Drop the cached owner tenant (call after writing kiss_users). */
export function invalidateOwnerCache(): void {
  ownerCache = null;
}

/** The single owner tenant (cached OWNER_CACHE_MS per isolate). */
export async function ownerTenant(env: TenantEnv): Promise<string> {
  const owners = ownerEmails(env);
  const key = owners.join(",");
  if (ownerCache && ownerCache.key === key && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache.tenant;
  const fromDb = await kissTenant(env.DB, owners);
  const tenant = fromDb || (owners[0] ? tenantFromEmail(owners[0]) : "default");
  ownerCache = fromDb ? { key, tenant, at: Date.now() } : null;
  return tenant;
}

export async function resolveTenant(env: TenantEnv, email: string): Promise<string> {
  const e = email.trim().toLowerCase();
  if (isOwnerEmail(env, e)) return ownerTenant(env);
  return (await kissTenant(env.DB, [e])) || tenantFromEmail(e);
}

export async function isOwnerTenantId(env: TenantEnv, tenant: string): Promise<boolean> {
  return ownerEmails(env).length > 0 && tenant === (await ownerTenant(env));
}

/**
 * Where a Google sign-in lands. Owner -> owner dashboard (Missions board at /). Only a genuinely
 * NEW, unpaid account goes to signup; existing accounts go where they asked (default /home).
 */
export function postLoginPath(o: { owner: boolean; created: boolean; paid: boolean; cb: string; tenant: string }): string {
  const plain = o.cb === "/home" || o.cb === "/";
  if (o.owner) return plain || o.cb.startsWith("/signup") ? "/" : o.cb;
  if (o.created && !o.paid && plain) return `/signup?handle=${encodeURIComponent(o.tenant)}`;
  return o.cb;
}

/** Tests only. */
export function _resetOwnerCache(): void {
  ownerCache = null;
}
