/**
 * Secrets Store bridge for the Missions Worker.
 *
 * Secrets are Secrets Store bindings (objects with async get()). Legacy
 * code reads `env.X` synchronously as a string, so each entry point primes the env
 * once: every secret binding is resolved and replaced by its string value.
 * Call primeSecrets(env) at the top of fetch/scheduled, Workflow run(), and Agent onStart().
 */
export const SECRET_KEYS = ["ALFRED_OPS_TOKEN", "CF_AIG_TOKEN", "A2A_BEARER_TOKEN", "OWNER_WAKE_URL", "OWNER_WAKE_AUTH"] as const;

type SecretBinding = { get(): Promise<string> };

function isBinding(v: unknown): v is SecretBinding {
  return !!v && typeof v === "object" && typeof (v as SecretBinding).get === "function";
}

export async function primeSecrets(env: object): Promise<void> {
  const e = env as Record<string, unknown>;
  await Promise.all(
    SECRET_KEYS.map(async (k) => {
      const v = e[k];
      if (!isBinding(v)) return;
      let resolved = "";
      try {
        resolved = ((await v.get()) ?? "").toString().trim();
      } catch {
        resolved = "";
      }
      try {
        e[k] = resolved;
      } catch {
        Object.defineProperty(e, k, { value: resolved, configurable: true });
      }
    })
  );
}
