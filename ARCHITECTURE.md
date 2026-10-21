# Architecture

```
browser / phone ──> web Worker (alfred-report, src/index.ts)
                      ├─ Access / Google sign-in -> tenant id
                      ├─ Alfred DO (one per tenant): Pi harness, tools, mission loop, reviews, lessons
                      │    tools: web_search (Ceramic -> Exa Lite -> Exa auto router), web_fetch, cf_docs_search,
                      │           memory (Agent Memory), missions, knowledge graph (owner), Clef, Clairic
                      ├─ /api/missions/* ── MISSIONS service binding ──> Missions Worker
                      └─ email(): owner forward -> Clairic -> mission

Missions Worker (alfred-report-missions, apps/missions)
  ├─ AlfredMissions DO, missions + evidence gates (D1), knowledge graph (D1 + Vectorize + R2)
  ├─ BriefingWorkflow (08:00 UTC), MaintenanceWorkflow (02:00 UTC), changelog watch (6h)
  └─ /a2a/* for external field agents (bearer), owner wake webhook

ORAL Worker (alfred-report-oral, apps/oral, oral.<domain>)
  └─ AlfredOral DO: Workers AI Flux STT + Aura TTS, continuous listening for the wake word

All model calls: AI Gateway (CLOUDFLARE_GATEWAY_ID) Auto Router, Workers AI floor.
Secrets: Secrets Store. Names: src/brand.ts. Config: config/schema.ts.
```

## Tenancy

- Owner (`OWNER_EMAILS`, or the `ALFRED_OPS_TOKEN` bearer): missions, intake, knowledge graph, email forwards.
- Everyone else who signs in: their own sandbox tenant (own Alfred DO and memory profile), asks only,
  `SANDBOX_ASKS_PER_DAY` per day, actions needing approval are refused.

## Search routing (`src/alfred/search.ts`)

Ceramic ($0.25 / 1k) by default. Exa ($7 / 1k, Exa `auto` type) when the query reads as research
(people, companies, code, finance, papers, comparisons, quoted or long queries) or when Ceramic
returns thin results. Exa runs only if `EXA_KEY_ALIAS` names a key on the gateway and the daily cap
`SEARCH_EXA_DAILY_LIMIT` is not spent. The model never picks the provider.
