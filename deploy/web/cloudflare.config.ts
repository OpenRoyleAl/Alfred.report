// Web Worker (site, sign-in, sandbox tenants, Alfred agent, MCP) - cf CLI configuration.
// Every value comes from ../../config/schema.ts (docs/CONFIG.md).
import { bindings, defineConfig, exports, triggers } from "cf/config";
import { loadAccount } from "../../config/account.ts";
import { schemaEnv } from "../../config/cf.ts";
import { BRAND, DURABLE_OBJECTS } from "../../src/brand.ts";

const acct = loadAccount();
const NAME = acct.req("WEB_WORKER_NAME");
const DOMAIN = acct.req("DOMAIN");
const ZONE = acct.get("ZONE_NAME") ?? DOMAIN;
const AGENT = DURABLE_OBJECTS.alfred;

const config = defineConfig({
  accountId: acct.req("CLOUDFLARE_ACCOUNT_ID"),
  worker: {
    name: NAME,
    compatibilityDate: "2026-10-20",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "../../src/index.ts",
    workersDev: false,
    observability: { enabled: true },
    assets: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: true },
    triggers: [
      triggers.fetch({ pattern: `${DOMAIN}/*`, zone: ZONE }),
      triggers.fetch({ pattern: `www.${DOMAIN}/*`, zone: ZONE }),
      // Alfred's MCP for agents (src/index.ts handleMcpHost).
      triggers.fetch({ pattern: `mcp.${DOMAIN}/*`, zone: ZONE }),
    ],
    env: {
      ...schemaEnv(acct, "web"),
      MEMORY: bindings.agentMemory({ namespace: acct.req("AGENT_MEMORY_NAMESPACE") }),
      DB: bindings.d1({ name: acct.req("WEB_D1_NAME"), id: acct.get("WEB_D1_ID") }),
      MISSIONS: bindings.worker({ worker: acct.req("MISSIONS_WORKER_NAME") }),
      EMAIL: bindings.sendEmail({ allowedSenderAddresses: [`${BRAND.senderLocalPart}@${DOMAIN}`] }),
      [AGENT.binding]: bindings.durableObject({ worker: NAME, exportName: AGENT.className }),
      AI: bindings.ai({ dev: { remote: true } }),
      IMAGES: bindings.images({}),
      ASSETS: bindings.assets(),
    },
    exports: {
      [AGENT.className]: exports.durableObject({ storage: "sqlite" }),
      // Retired classes of the deployed web Worker (kept so existing deployments migrate cleanly).
      AgentSession: exports.durableObject({ state: "deleted" }),
      SignalRouter: exports.durableObject({ state: "deleted" }),
      TenantCoordinator: exports.durableObject({ state: "deleted" }),
    },
  },
});
acct.done();
export default config;
