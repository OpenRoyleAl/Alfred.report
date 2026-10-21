# Alfred.report Missions

Missions Worker (`alfred-report-missions`): missions with budgets and evidence gates, the knowledge
graph, scheduled briefing/maintenance Workflows, and the `/a2a/*` surface for external field agents.
Reached by the web Worker through the `MISSIONS` service binding.

- Config: `cloudflare.config.ts` (values from `../../config/schema.ts`, see `docs/CONFIG.md`).
- Models: `src/lib/llm.ts` wraps the shared AI Gateway Auto Router client (`src/alfred/models.ts`).
- Commands: `npm run typecheck`, `npm run check` (`cf deploy --dry-run`), `npm run deploy`, `npm run db:migrate`.
