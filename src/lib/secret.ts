/**
 * Resolve a Worker secret that may be a plain string (wrangler secret / .dev.vars)
 * or a Secrets Store binding with async .get().
 */
export type SecretValue = string | { get(): Promise<string> } | undefined | null;

export async function secretGet(value: SecretValue): Promise<string> {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && typeof (value as { get?: unknown }).get === "function") {
    try {
      const v = await (value as { get(): Promise<string> }).get();
      return (v ?? "").toString().trim();
    } catch {
      return "";
    }
  }
  return "";
}
