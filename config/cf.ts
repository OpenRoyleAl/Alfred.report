/** Shared helpers for the cf configs: schema vars + Secrets Store bindings for one app. */
import { bindings } from "cf/config";
import type { Account } from "./account.ts";
import type { App, ConfigName, Kind, SCHEMA } from "./schema.ts";

type Def<N extends ConfigName> = (typeof SCHEMA)[N];
type For<A extends App, K extends Kind> = {
  [N in ConfigName]: Def<N> extends { kind: K; apps: readonly (infer X)[] } ? (A extends X ? N : never) : never;
}[ConfigName];
type Required_<N extends ConfigName> = N extends ConfigName ? (Def<N> extends { required: true } ? N : Def<N> extends { default: string } ? N : never) : never;
type Text = ReturnType<typeof bindings.text>;
type Secret = ReturnType<typeof bindings.secretsStoreSecret>;

/** Typed per app, so `cf workers types` infers every var and secret binding by name. */
export type SchemaEnv<A extends App> = { [N in For<A, "var"> & Required_<For<A, "var">>]: Text } & {
  [N in Exclude<For<A, "var">, Required_<For<A, "var">>>]?: Text;
} & { [N in For<A, "secret">]: Secret };

export function schemaEnv<A extends App>(acct: Account, app: A): SchemaEnv<A> {
  const storeId = acct.req("SECRETS_STORE_ID");
  const env: Record<string, Text | Secret> = {};
  for (const [k, v] of Object.entries(acct.vars(app))) env[k] = bindings.text(v);
  const names = JSON.parse(acct.get("SECRET_NAMES") || "{}") as Record<string, string>;
  const absent = new Set((acct.get("SECRETS_ABSENT") || "").split(",").map((s) => s.trim()).filter(Boolean));
  for (const k of acct.secrets(app)) {
    if (absent.has(k)) continue;
    env[k] = bindings.secretsStoreSecret({ storeId, secretName: names[k] || k });
  }
  return env as SchemaEnv<A>;
}
