# Alfred.report!

A voice-first operator that runs on your own Cloudflare account, branded by your own domain.
Say your wake word - your instance brand, like **name.report!** - and get **The Report**: a short
spoken status of your recent missions (success or fail), a one-line synopsis, and what needs you.

Alfred.report! is the platform and Sovereign Custodian behind every instance.

## What is in here

| Part | Folder | What it does |
|---|---|---|
| Web | `src/`, `public/`, `deploy/web/` | Site, sign-in (Cloudflare Access / Google), per-user sandbox tenants, the `Alfred` front-door Durable Object (missions run on the durable engine), MCP, owner email forwards. |
| Missions | `apps/missions/` | Missions, evidence gates, knowledge graph (D1, Vectorize, R2), daily briefing and nightly maintenance (Workflows). |
| ORAL | `apps/oral/` | Voice: Workers AI speech-to-text and text-to-speech, continuous listening for the wake word. |

Models go through the instance's AI Gateway (Auto Router). Web search uses Ceramic by default and
escalates to Exa automatically, billed to the gateway's Exa provider key (`src/alfred/search.ts`).

Every signed-in user gets a limited sandbox (asks per day). The owner (`OWNER_EMAILS`) can start
missions and forward email to `al@<domain>` to start one.

## Docs

- [docs/SETUP.md](docs/SETUP.md) - per-customer setup with the cf CLI
- [docs/CONFIG.md](docs/CONFIG.md) - every config key (generated)
- [docs/NAMING.md](docs/NAMING.md) - brands, Worker and resource names
- [ARCHITECTURE.md](ARCHITECTURE.md)

## Develop

```
npm run install:all
npm run gate
```

Published by OpenRoyleAl.
