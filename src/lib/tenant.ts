/**
 * Multi-tenancy support
 * 
 * Each user gets their own isolated Alfred instance.
 * - Durable Object: isolated SQLite per user
 * - R2: partitioned by user prefix
 * - D1: user_id columns
 * - Vectorize: user metadata filters
 */

import type { Env } from "./env";

export interface Tenant {
  id: string;
  name: string;
  domain?: string;
  createdAt: number;
}

export function getTenantId(request: Request): string {
  // Extract tenant ID from request
  // Options:
  // 1. From subdomain: tenant.alfred.report
  // 2. From header: X-Tenant-ID
  // 3. From query param: ?tenant=xxx
  // 4. Default: "default"

  const url = new URL(request.url);
  const hostname = url.hostname;

  // Check for tenant subdomain
  if (hostname.includes(".")) {
    const parts = hostname.split(".");
    if (parts.length > 2) {
      return parts[0];
    }
  }

  // Check for tenant header
  const tenantHeader = request.headers.get("X-Tenant-ID");
  if (tenantHeader) {
    return tenantHeader;
  }

  // Check for tenant query param
  const tenantParam = url.searchParams.get("tenant");
  if (tenantParam) {
    return tenantParam;
  }

  // Default tenant
  return "default";
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
