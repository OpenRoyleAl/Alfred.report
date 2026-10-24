# Configuration

<!-- Generated from config/schema.ts by `npm run config:docs`. Do not edit by hand. -->

One typed schema (`config/schema.ts`) declares every value an instance needs. Values resolve in
this order: environment / Workers Builds variables, then `alfred.config.json` at the repo root
(gitignored; start from `alfred.config.example.json`), then the schema default. Unknown keys in
`alfred.config.json` are an error. Secrets never go in that file: `scripts/setup.sh` writes them
to the account's Secrets Store from environment variables.

Apps: `web` = deploy/web (src/index.ts), `missions` = apps/missions, `oral` = apps/oral.

## Deploy-time values

| Key | Apps | Required | Default | Description |
|---|---|---|---|---|
| `SECRETS_STORE_ID` | web, missions, oral | yes |  | Secrets Store holding every `secret` below. |
| `SECRET_NAMES` | web, missions, oral |  |  | Optional map of secret key -> Secrets Store secret name, for stores that already use other names. |
| `SECRETS_ABSENT` | web, missions, oral |  |  | Comma list of optional secrets this account does not have (not bound; the feature that needs one stays off). |
| `ZONE_NAME` | web, oral |  |  | Zone that holds DOMAIN, when it differs from DOMAIN. |
| `MISSIONS_DO_PHASE` | missions |  | `live` | Durable Object cutover from the old Command Worker: "receive" (take AlfredCommand from LEGACY_COMMAND_WORKER_NAME), "transfer-out" (deploys the old Worker with the transferred tombstone), "rename" (AlfredCommand -> AlfredMissions), "live" (fresh installs and after cutover). See apps/missions/MIGRATION.md. |
| `LEGACY_COMMAND_WORKER_NAME` | missions |  | `alfred-report-command` | Old Command Worker that still owns the AlfredCommand namespace (used only by MISSIONS_DO_PHASE=receive and transfer-out). |

## Variables (plain Worker vars)

| Key | Apps | Required | Default | Description |
|---|---|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | web, missions, oral | yes |  | Cloudflare account that owns this instance (also used for the AI Gateway URL). |
| `DOMAIN` | web, oral | yes |  | The customer's paid domain. Display brand is `<domain>!` (whatever.report!). |
| `OWNER_EMAILS` | web, missions, oral | yes |  | Comma-separated owner emails. Owners forward email and start missions; every other signed-in user gets a limited sandbox tenant. |
| `ACCESS_TEAM_DOMAIN` | web, oral | yes |  | Cloudflare Access team domain used to verify sign-in JWTs. |
| `ACCESS_AUD` | web, oral | yes |  | AUD tag of the Access application in front of the instance. |
| `CLOUDFLARE_GATEWAY_ID` | web, missions |  | `alfred-report` | AI Gateway id. Every model and search call goes through it; provider keys (Exa, BYOK LLMs) live on the gateway. |
| `AUTO_ALLOWED_MODELS` | web, missions |  |  | Auto Router candidate models (cf-aig-allowed-models). Default: the Workers AI pool in src/alfred/models.ts. |
| `AUTO_ALLOWED_PROVIDERS` | web, missions |  |  | Auto Router providers (cf-aig-allowed-providers). |
| `WORKERS_AI_FLOOR` | web, missions |  |  | Comma list of @cf/ models tried when the routed call fails. |
| `EXA_KEY_ALIAS` | web, missions |  |  | Alias of the Exa key in AI Gateway Provider Keys. Set it to let the search router escalate to Exa; unset means Ceramic only. |
| `EXA_CUSTOM_PROVIDER` | web, missions |  | `exa` | Slug of the AI Gateway custom provider for Exa's own API (base_url https://api.exa.ai, BYOK alias EXA_KEY_ALIAS). Enables the Exa Lite tier ($4/1k) between Ceramic and Exa auto. |
| `SEARCH_EXA_DAILY_LIMIT` | web, missions |  | `200` | Max Exa escalations per day per instance; past it the router stays on Ceramic. |
| `MISSIONS_MODEL` | web, missions |  |  | Primary mission/coding model (Workers AI id) tried before Auto Router. Default DeepSeek V4.1 Flash; "auto" = Auto Router only. |
| `CLEF_MODEL` | web, missions |  | `clef` | Clef model for the route/escalate/done gates: clef, clef-flash or clef-omni (audio/video input always uses clef-omni). |
| `SANDBOX_ASKS_PER_DAY` | web, oral |  | `30` | Asks per day for a non-owner sandbox tenant (typed asks and ORAL voice turns share it). |
| `HOLD_NEW_MISSIONS` | missions |  | `0` | "1" refuses new missions (ops override header X-Alfred-Override: metering-bootstrap). |
| `STRIPE_PRICE_USD_99` | web |  |  | Stripe price id, USD plan. |
| `STRIPE_PRICE_GBP_99` | web |  |  | Stripe price id, GBP plan. |
| `GBP_SUBJECT` | web |  |  | Google Business Profile user to impersonate (only when GBP is used). |

## Secrets (Secrets Store; binding name = secret name)

| Key | Apps | Required | Default | Description |
|---|---|---|---|---|
| `ALFRED_OPS_TOKEN` | web, missions |  |  | Ops bearer for automation; acts as the first OWNER_EMAILS entry. |
| `ALFRED_AGENT_TOKEN` | web |  |  | Second owner bearer for the owner's own agents (deploy smoke tests). Revocable separately from ALFRED_OPS_TOKEN. |
| `CF_AIG_TOKEN` | web, missions |  |  | AI Gateway token (cf-aig-authorization) for an authenticated gateway. |
| `A2A_BEARER_TOKEN` | missions |  |  | Bearer for external field agents on /a2a/*. |
| `OWNER_WAKE_URL` | missions |  |  | Optional webhook that wakes the owner (mission complete / needs owner). |
| `OWNER_WAKE_AUTH` | missions |  |  | Bearer sent to OWNER_WAKE_URL. |
| `JWT_SECRET` | web |  |  | Signs web session cookies. |
| `GOOGLE_CLIENT_ID` | web |  |  | Google OAuth client id (Google sign-in). |
| `GOOGLE_CLIENT_SECRET` | web |  |  | Google OAuth client secret. |
| `GOOGLE_SA_KEY` | web |  |  | Google service-account JSON (only when GBP is used). |
| `STRIPE_KEY` | web |  |  | Stripe secret key. |
| `STRIPE_WEBHOOK_SECRET` | web |  |  | Stripe webhook signing secret. |
| `REGISTRAR_API_TOKEN` | web |  |  | Cloudflare API token with Registrar Read (domain availability). |

## Resources (names/ids behind bindings; an unset id lets `cf deploy` provision it)

| Key | Apps | Required | Default | Description |
|---|---|---|---|---|
| `WEB_WORKER_NAME` | web, oral |  | `alfred-report` | Web Worker name (ORAL binds its Alfred Durable Object). |
| `MISSIONS_WORKER_NAME` | web, missions |  | `alfred-report-missions` | Missions Worker name (bound into web as MISSIONS). |
| `ORAL_WORKER_NAME` | oral |  | `alfred-report-oral` | ORAL (voice) Worker name. |
| `AGENT_MEMORY_NAMESPACE` | web, missions |  | `alfred-report` | Agent Memory namespace (owner seed: scripts/seed-memory.mjs). |
| `WEB_D1_NAME` | web, oral |  | `alfred-report` | Web D1 database name. |
| `WEB_D1_ID` | web, oral |  |  | Web D1 database id (pin after the first deploy). |
| `MISSIONS_D1_NAME` | missions |  | `alfred-report-command` | Missions D1 database name. |
| `MISSIONS_D1_ID` | missions |  |  | Missions D1 database id (pin after the first deploy). |
| `MISSIONS_KV_ID` | missions |  |  | Missions KV namespace id (pin after the first deploy). |
| `MISSIONS_R2_BUCKET` | missions |  | `alfred-report-command-content` | Missions R2 bucket. |
| `MISSIONS_VECTORIZE_INDEX` | missions |  | `alfred-report-command-index` | Missions Vectorize index. |
