# AGENTS.md - Alfred.report

Guidance for coding agents working in this repository. (The Grok app-builder workspace guide is
vendored separately at `.grok/AGENTS.md`.)

- Names: import from `src/brand.ts`; read [docs/NAMING.md](docs/NAMING.md). Never hard-code a brand,
  Worker, Durable Object or resource name.
- Config: add a key to `config/schema.ts`, then `npm run config:docs`. No loose env lists.
- Tooling: the cf CLI (`cf`), not Wrangler. Look Cloudflare things up with `cf docs search`.
- Gate: `npm run gate` must pass (typecheck for all three Workers, tests, config docs current,
  secret scan, `cf deploy --dry-run` for each Worker).
- Never commit account IDs, emails, client material or secrets. Owner material belongs in a private
  directory loaded by `scripts/seed-memory.mjs`.
- Missions close only with evidence.
