# Naming and branding

All names live in one module, `src/brand.ts`. Code imports from it; nothing else hard-codes a
brand, Worker, Durable Object, route or resource name. Per-account overrides go through
`config/schema.ts` (see [CONFIG.md](./CONFIG.md)).

## Brands

| Term | Value | Where |
|---|---|---|
| Platform brand | **Alfred.report!** | `BRAND.platformBrand`. The platform and **Sovereign Custodian** behind every instance (`PLATFORM_ROLE`). |
| Instance brand | **`<domain>!`**, e.g. `whatever.report!` | `instanceBrand(DOMAIN)`. Each customer instance is branded by its own paid domain. |
| Wake word | the instance brand | `wakeWord(DOMAIN)`. The owner of alfred.report says "Alfred.report!"; the owner of name.report says "name.report!". |
| Byline | `<instance brand> - by Alfred.report!` | `brandContext(env).byline` |

The `!` is part of display strings only. Identifiers stay clean: `alfred-report`, `AlfredMissions`,
`ALFRED`. There is no role-label setting: an instance is its domain brand, and Alfred.report! is
always the platform and Sovereign Custodian behind it.

## Product flow

| Stage | Meaning |
|---|---|
| **ORAL** | Voice listening (apps/oral). Listens continuously for the wake word. |
| **WAKE** | The wake word was heard (or the owner is woken by a webhook, `OWNER_WAKE_*`). |
| **The Report** | What waking returns: a short voice-first status. Success or fail per recent mission, a one-line synopsis, and what needs attention. Not long mission briefs. |
| **Go Max AI!** | Escalate a mission to a bigger budget. |

## Workers, Durable Objects, routes

| Part | Folder | Worker | Durable Object (class / binding / route) |
|---|---|---|---|
| Web | `deploy/web` (code in `src/`) | `alfred-report` | `Alfred` / `ALFRED` / `alfred` (one per tenant) |
| Missions | `apps/missions` | `alfred-report-missions` | `AlfredMissions` / `MISSIONS_AGENT` / `alfred-missions` |
| ORAL | `apps/oral` | `alfred-report-oral` | `AlfredOral` / `ORAL_AGENT` / `alfred-oral` |

The web Worker reaches Missions over the `MISSIONS` service binding (no public URL).
The ORAL Worker is served on `oral.<DOMAIN>`.

## Resources (defaults; override per account)

| Resource | Default name |
|---|---|
| AI Gateway | `alfred-report` |
| Agent Memory namespace | `alfred-report` (owner profile `owner`) |
| Web D1 | `alfred-report` |
| Missions D1 / R2 / Vectorize (legacy names kept; data resources cannot be renamed in place) | `alfred-report-command` / `alfred-report-command-content` / `alfred-report-command-index` |

Field agents (the agents a mission can be assigned to) are listed in `FIELD_AGENTS`:
`alfred` (this instance) plus the external agents `cursor`, `pi`, `grok-cli`, `openclaw`,
`hermes`, `mimocode`. The old id `oral` maps to `alfred`.

## Retired names

| Old | New |
|---|---|
| `agent-alfred`, "brain", `apps/brain` | Alfred.report Missions, `apps/missions`, `alfred-report-missions` |
| `Orchestrator` DO / `ORCHESTRATOR` | `AlfredMissions` / `MISSIONS_AGENT` |
| `apps/command`, `alfred-report-command`, `AlfredCommand` / `COMMAND_AGENT`, `COMMAND` binding, `/api/command/*` | `apps/missions`, `alfred-report-missions`, `AlfredMissions` / `MISSIONS_AGENT`, `MISSIONS` binding, `/api/missions`, `/api/stats` (DO cutover: `apps/missions/MIGRATION.md`) |
| `alfred-oral` Worker, `apps/voice`, `AlfredOralAgent` | `alfred-report-oral`, `apps/oral`, `AlfredOral` |
| `canon` (client material) | removed from git; owner memory seed from a private dir (`scripts/seed-memory.mjs`) |
| `oracle960` | removed (unused Vectorize binding / old gateway id) |
| `pi-edge` branch | landed on `main` |
| `deploy/report` | `deploy/web` |
| `ORAL_WAKE_URL` / `ORAL_WAKE_AUTH` | `OWNER_WAKE_URL` / `OWNER_WAKE_AUTH` |
| Hermes/MiMo/DeepSeek model ladder | AI Gateway Auto Router (`src/alfred/models.ts`) |
| `EXA_BYOK_ALIAS`, `research_search` | `EXA_KEY_ALIAS`, one `web_search` with automatic routing |
| `STRIPE_SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_*`, `ALFRED_JWT_SECRET`, `ALFRED_GOOGLE_CLIENT_ID` | `STRIPE_KEY`, `GOOGLE_CLIENT_*`, `JWT_SECRET`, `GOOGLE_CLIENT_ID` |
