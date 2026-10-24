// ORAL Worker (voice-listen stage) - cf CLI configuration. Values: ../../config/schema.ts.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import { loadAccount } from "../../config/account.ts";
import { schemaEnv } from "../../config/cf.ts";
import { DURABLE_OBJECTS } from "../../src/brand.ts";

const acct = loadAccount();
const NAME = acct.req("ORAL_WORKER_NAME");
const DOMAIN = acct.req("DOMAIN");
const ZONE = acct.get("ZONE_NAME") ?? DOMAIN;
const DO = DURABLE_OBJECTS.oral;
const ALFRED = DURABLE_OBJECTS.alfred;

const config = defineConfig({
  accountId: acct.req("CLOUDFLARE_ACCOUNT_ID"),
  worker: {
    name: NAME,
    compatibilityDate: "2026-10-20",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    workersDev: false,
    observability: { enabled: true },
    // Worker first: every request (page, assets, agent socket) needs a voice agent token (worker.ts).
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: true },
    triggers: [triggers.fetch({ pattern: `oral.${DOMAIN}/*`, zone: ZONE })],
    env: {
      ...schemaEnv(acct, "oral"),
      AI: bindings.ai({ dev: { remote: true } }),
      ASSETS: bindings.assets(),
      // Web D1: agent tokens (hashed, revocable) and the owner tenant lookup.
      DB: bindings.d1({ name: acct.req("WEB_D1_NAME"), id: acct.get("WEB_D1_ID") }),
      [DO.binding]: bindings.durableObject({ worker: NAME, exportName: DO.className }),
      // The tenant's Alfred agent lives in the web Worker: The Report and voice missions read/write it.
      [ALFRED.binding]: bindings.durableObject({ worker: acct.req("WEB_WORKER_NAME"), exportName: ALFRED.className }),
    },
    exports: {
      [DO.className]: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
acct.done();
export default config;
