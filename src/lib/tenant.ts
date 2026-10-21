/**
 * Multi-tenancy helpers.
 *
 * The tenant is derived ONLY from a verified identity (Cloudflare Access JWT or the
 * owner ops token). Hostnames, headers (X-Tenant-ID) and query params are never used:
 * they are attacker-controlled.
 */
import type { VerifiedIdentity } from "./access";

export function getTenantId(identity: VerifiedIdentity | null): string | null {
  return identity?.tenant_id ?? null;
}

export function getTenantPrefix(tenantId: string): string {
  return `tenant:${tenantId}:`;
}

export function getR2Key(tenantId: string, path: string): string {
  return `${getTenantPrefix(tenantId)}${path}`;
}

export function getD1Filter(tenantId: string): Record<string, unknown> {
  return { tenant_id: tenantId };
}
