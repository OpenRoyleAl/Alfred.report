# ORAL

The voice Worker (`alfred-report-oral`, served on `oral.<domain>`), built on `@cloudflare/voice`
(`withVoice` on an Agents SDK Durable Object): Workers AI Deepgram Flux speech-to-text, Aura
text-to-speech, WebSocket transport. Listening is continuous.

Flow: **ORAL -> WAKE -> Go Max AI! -> The Report**

| You say | Who | What happens |
| --- | --- | --- |
| the wake word = the instance brand, e.g. "acme report" / "acme dot report" for `acme.report!` | anyone signed in | **WAKE**: speaks **The Report** for your tenant: success or fail per recent mission, a one-line synopsis, what needs attention |
| "start a mission to ..." | owner | drafts the mission (Clairic reads the typed fields and ORAL reads back any it is unsure of) |
| "Go Max AI!" | owner | starts the drafted mission (evidence required, Clef-gated, reviewed) |
| "Go Max AI, ..." | owner | drafts and starts in one go |
| "cancel" | owner | drops the draft |
| anything else | anyone | short spoken answer; sandbox turns count against `SANDBOX_ASKS_PER_DAY` |

The Report is built from stored missions and their reviews (`src/alfred/report.ts`), including the
Clef mission-done gate, so no model writes it and it cannot invent results. The same data is at
`GET /api/alfred/report` on the web Worker.

Security: every request needs a verified Cloudflare Access sign-in (`ACCESS_TEAM_DOMAIN`,
`ACCESS_AUD`); put `oral.<domain>` in the same Access application as the site. The agent instance
is named by the caller's tenant and the Worker refuses any other name, so a socket only reaches its
own tenant's ORAL and Alfred objects. Owners are `OWNER_EMAILS`.

Bindings: `ORAL_AGENT` (this Worker's `AlfredOral`), `ALFRED` (the web Worker's `Alfred`, by
`WEB_WORKER_NAME`), `AI`, `ASSETS`. Deploy the web Worker first.

- Config: `cloudflare.config.ts`; build: `vite.config.ts` (Cloudflare Vite plugin).
- Code: `src/server.ts` (agent), `src/wake.ts` (wake word + commands), `src/turn.ts` (turn policy),
  `src/identity.ts` (Access + tenant), `src/App.tsx` (client, `VoiceClient`).
- Commands: `npm run dev`, `npm run typecheck`, `npm run check`, `npm run deploy`.
