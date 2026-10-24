// Missions Worker (missions, evidence gates, knowledge graph, scheduled workflows) - cf CLI
// configuration. Every value comes from ../../config/schema.ts (docs/CONFIG.md).
import { bindings, defineConfig, exports, triggers } from "cf/config";
import { loadAccount } from "../../config/account.ts";
import { schemaEnv } from "../../config/cf.ts";
import { DURABLE_OBJECTS } from "../../src/brand.ts";

const acct = loadAccount();
const NAME = acct.req("MISSIONS_WORKER_NAME");
const AGENT = DURABLE_OBJECTS.missions;
const LEGACY_CLASS = "AlfredCommand";

// DO cutover (apps/missions/MIGRATION.md). The Worker was renamed alfred-report-command ->
// alfred-report-missions, so the AlfredCommand namespace must be *transferred* between Workers
// first, then *renamed* inside this Worker. renamed_classes alone cannot cross Workers.
const PHASE = acct.get("MISSIONS_DO_PHASE") ?? "live";
if (!["receive", "transfer-out", "rename", "live"].includes(PHASE)) throw new Error(`MISSIONS_DO_PHASE: unknown phase ${PHASE}`);
const doExports =
  PHASE === "receive"
    ? {
        [LEGACY_CLASS]: exports.durableObject({
          state: "expecting-transfer",
          storage: "sqlite",
          transferFrom: acct.req("LEGACY_COMMAND_WORKER_NAME"),
        }),
      }
    : PHASE === "rename"
      ? {
          [LEGACY_CLASS]: exports.durableObject({ state: "renamed", renamedTo: AGENT.className }),
          [AGENT.className]: exports.durableObject({ storage: "sqlite" }),
        }
      : { [AGENT.className]: exports.durableObject({ storage: "sqlite" }) };
// While receiving, the target must not bind the class yet (Cloudflare does not route it).
const doBinding =
  PHASE === "receive" ? {} : { [AGENT.binding]: bindings.durableObject({ worker: NAME, exportName: AGENT.className }) };

// transfer-out = the OLD Worker's last deploy: a `transferred` tombstone hands AlfredCommand over.
const legacyConfig = () =>
  defineConfig({
    accountId: acct.req("CLOUDFLARE_ACCOUNT_ID"),
    worker: {
      name: acct.req("LEGACY_COMMAND_WORKER_NAME"),
      compatibilityDate: "2026-10-20",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "src/legacy-source.ts",
      workersDev: false,
      exports: {
        [LEGACY_CLASS]: exports.durableObject({ state: "transferred", transferredTo: NAME }),
      },
    },
  });

const config = PHASE === "transfer-out" ? legacyConfig() : defineConfig({
  accountId: acct.req("CLOUDFLARE_ACCOUNT_ID"),
  worker: {
    name: NAME,
    compatibilityDate: "2026-10-20",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    // Reached only through the web Worker's MISSIONS service binding.
    workersDev: false,
    observability: { enabled: true },
    triggers: [
      triggers.scheduled({ schedule: "0 8 * * *" }),
      triggers.scheduled({ schedule: "0 2 * * *" }),
      triggers.scheduled({ schedule: "15 */6 * * *" }),
    ],
    env: {
      ...schemaEnv(acct, "missions"),
      MEMORY: bindings.agentMemory({ namespace: acct.req("AGENT_MEMORY_NAMESPACE") }),
      DB: bindings.d1({ name: acct.req("MISSIONS_D1_NAME"), id: acct.get("MISSIONS_D1_ID") }),
      CONFIG: bindings.kv({ id: acct.get("MISSIONS_KV_ID") }),
      CONTENT: bindings.r2({ name: acct.req("MISSIONS_R2_BUCKET") }),
      VECTORIZE: bindings.vectorize({ name: acct.req("MISSIONS_VECTORIZE_INDEX") }),
      ...doBinding,
      BRIEFING_WORKFLOW: bindings.workflow({ name: `${NAME}-briefing`, worker: NAME, exportName: "BriefingWorkflow" }),
      MAINTENANCE_WORKFLOW: bindings.workflow({ name: `${NAME}-maintenance`, worker: NAME, exportName: "MaintenanceWorkflow" }),
      AI: bindings.ai({}),
      // Version id of the running deploy, recorded on every durable task (proves resume across deploys).
      CF_VERSION_METADATA: bindings.versionMetadata(),
    },
    exports: {
      ...doExports,
      BriefingWorkflow: exports.workflow({ name: `${NAME}-briefing` }),
      MaintenanceWorkflow: exports.workflow({ name: `${NAME}-maintenance` }),
    },
  },
});
acct.done();
export default config;
