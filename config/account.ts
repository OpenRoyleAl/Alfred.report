/**
 * Resolves config/schema.ts values for one account:
 *   process.env (CI / Workers Builds variables) -> alfred.config.json (gitignored) -> schema default.
 * ALFRED_CONFIG_CHECK=1 (the gate's `cf deploy --dry-run`) substitutes "__CHECK__" for missing
 * required values so the templates validate without an account.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, keysFor, type App, type ConfigKey, type ConfigName } from "./schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = join(ROOT, "alfred.config.json");

export interface Account {
  get(k: ConfigName): string | undefined;
  req(k: ConfigName): string;
  /** Plain vars of this app; unset optional vars are omitted. */
  vars(app: App): Record<string, string>;
  /** Secret names of this app (binding name = secret name). */
  secrets(app: App): ConfigName[];
  /** Throws listing every missing required key (no-op in check mode). */
  done(): void;
}

export function loadAccount(env: Record<string, string | undefined> = process.env): Account {
  const file: Record<string, unknown> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  for (const k of Object.keys(file)) {
    if (!(k in SCHEMA)) throw new Error(`alfred.config.json: unknown key ${k} (see docs/CONFIG.md)`);
  }
  const check = env.ALFRED_CONFIG_CHECK === "1";
  const missing = new Set<string>();
  const get = (k: ConfigName): string | undefined => {
    const d: ConfigKey = SCHEMA[k];
    const v = env[k] ?? file[k] ?? d.default;
    return v === undefined || v === null || v === "" ? undefined : String(v);
  };
  const req = (k: ConfigName): string => {
    const v = get(k);
    if (v !== undefined) return v;
    missing.add(k);
    return "__CHECK__";
  };
  return {
    get,
    req,
    vars(app) {
      const out: Record<string, string> = {};
      for (const k of keysFor(app, "var")) {
        const d: ConfigKey = SCHEMA[k];
        const v = d.required ? req(k) : get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    secrets: (app) => keysFor(app, "secret"),
    done() {
      if (missing.size && !check) {
        throw new Error(`alfred config: missing required values: ${[...missing].join(", ")} (see docs/CONFIG.md)`);
      }
    },
  };
}
