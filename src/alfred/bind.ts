/**
 * Per-request bind rules for the tenant Alfred Durable Object.
 * Tenant is sticky. isOwner on persisted state is monotonic (never downgraded by a
 * narrower caller such as a scoped agent token). Callers still pass their own
 * privilege for quota / owner-only RPCs via a request-local flag.
 */
export function nextBindState(
  current: { tenantId: string | null; isOwner: boolean },
  tenantId: string,
  isOwner: boolean
): { tenantId: string; isOwner: boolean } {
  const t = tenantId.trim();
  if (!t) throw new Error("tenant required");
  if (current.tenantId && current.tenantId !== t) throw new Error("tenant mismatch");
  return { tenantId: t, isOwner: Boolean(current.isOwner || isOwner) };
}
