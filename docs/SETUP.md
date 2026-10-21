# Setup (one instance per customer account)

Each customer gets a private copy of this template (their own Artifacts git repository) and runs
it in **their own Cloudflare account** under **their own domain**. Nothing account-specific is
committed. Every Worker is configured for the **cf CLI** (`cloudflare.config.ts`).

| File | Role |
|---|---|
| `config/schema.ts` | The one typed config schema. Generates [CONFIG.md](./CONFIG.md) and `alfred.config.example.json`. |
| `config/account.ts` | Resolves values: env / build variables, then `alfred.config.json` (gitignored), then defaults. |
| `deploy/web/` | Web Worker (`src/index.ts`) - own directory so cf builds it with the Cloudflare Vite plugin instead of the root TanStack app. |
| `apps/missions/` | Missions Worker (missions, knowledge graph, Workflows, crons). |
| `apps/oral/` | ORAL Worker (voice). |
| `scripts/setup.sh` | Creates the AI Gateway, Agent Memory namespace and Secrets Store secrets with cf. Dry run unless `--apply`. |
| `scripts/seed-memory.mjs` | Loads the owner's private material (outside git) into Agent Memory. Plan only unless `--apply`. |

## Steps

1. `cf auth login` as the customer. Copy `alfred.config.example.json` to `alfred.config.json` and fill it.
2. `npm run install:all`, then `npm run gate`.
3. Export the secrets listed in [CONFIG.md](./CONFIG.md) and run `scripts/setup.sh`, then `scripts/setup.sh --apply`.
4. In the dashboard: an Access application for the domain (copy its AUD to `ACCESS_AUD`); Email Routing
   `al@<domain>` to the web Worker (owner forwards become missions); optionally an Exa key under AI
   Gateway Provider Keys (alias in `EXA_KEY_ALIAS`).
5. `npm run deploy` (Missions first, then web, then ORAL; `cf deploy` each).
6. Optional: `ALFRED_PRIVATE_DIR=<private dir> npm run seed:memory -- --apply`.

`ALFRED_CONFIG_CHECK=1` substitutes `__CHECK__` for missing required values, so `npm run deploy:check`
(`cf deploy --dry-run`: builds and validates, no API calls) runs in the gate without an account.

## What cf cannot do yet (developers.cloudflare.com/cf/wrangler/, Oct 2026)

- **Live logs**: no `cf` equivalent of `wrangler tail`. Use `npx wrangler tail <worker>` ad hoc; Wrangler is not a dependency of this repo.
- **Single Worker secret**: cf cannot set one secret (`cf deploy --secrets-file` or `cf workers secrets bulk` instead). Alfred.report keeps secrets in Secrets Store (`cf secrets-store`), so this is not needed.
- **Workers Builds**: the default deploy command is `npx wrangler deploy`; set it to `npm run deploy`. The docs do not say whether `cf deploy` picks up the Builds API token, so add `CLOUDFLARE_API_TOKEN` as a build secret if it does not.
- D1 migrations: `npm --prefix apps/missions run db:migrate` (`cf d1 migrations apply`). On a database whose tables were created by hand, `d1_migrations` is empty and cf would re-run the files; seed that table first.
