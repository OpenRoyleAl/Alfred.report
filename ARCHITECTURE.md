# Architecture

Alfred.report runs as a Cloudflare Worker with:

- Static assets from `public/` (site, demo audio, discovery files)
- Worker logic in `src/` (HTTP routes, auth, APIs)
- Durable Objects for session and operator state
- Secrets via Cloudflare Secrets Store or `wrangler secret put`

Deploy with Wrangler. See the root README for the short path.
