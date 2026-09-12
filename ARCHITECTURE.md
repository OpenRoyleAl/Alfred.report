# Architecture — alfred.report

Canon. Matches live. Lab notes: [`lab/`](lab/README.md).

**Public host is `https://alfred.report`.**  
Wrangler Worker name `command-os-review` is an internal id, not a hostname.

```
Artifacts (alfred-command / alfred-report)  →  git
        ↓  wrangler deploy
Worker (id: command-os-review)              →  live operator
        ↓  vanity only
GitHub (OpenRoyleAl/Alfred.report)          →  public square
```

## What answers alfred.report

One Worker with static assets. Root `wrangler.jsonc`. `npx wrangler deploy` from repo root.

| Route | Job |
|---|---|
| `alfred.report/*` | Face, board, APIs, A2A, llms.txt |
| `voice.alfred.report/*` | Voice / briefing |
| `speak.alfred.report/*` | HTTP TTS / STT |
| `mcp.alfred.report/*` | MCP — **Cloudflare Access**. Not open. |

Service bindings: `agent-alfred` (ORAL), `alfred-report` (board worker).  
Storage: D1 `alfred-db`, KV `alfred-command`, R2, Agent Memory, Analytics Engine `ALFRED_COP`.  
Voice: Workers AI Aura-2, speaker Draco. Public GET: `/voice/hello`.

### Open without a login

`/`, `/pi`, `/download`, `/login`, `/install.sh`, `/install.ps1`, `/board` (demo), `/evidence`, `/brief`, `/for-agents`, `/llms.txt`, `/.well-known/agent.json`, `/voice/hello`, `/voice/demo-brief`.

### alfred-pi (local harness)

Public install face at `/pi` and `/download`. One-liners:

- `curl -fsSL https://alfred.report/install.sh | sh`
- `powershell -c "irm https://alfred.report/install.ps1 | iex"`
- `npm|pnpm|bun add -g @openroyleal/alfred-pi`

CLI UX (locked): `alfred report`, `alfred report <slug>`, `alfred report update`, `/login`. Human session ids are kebab slugs only — no `mb-`, no dashed UUIDs in UI. `alfred-mem` auto-rename is documented; wire is stub.

### Not open

| Surface | Gate |
|---|---|
| `https://mcp.alfred.report/mcp` | Access **service token**. Unauthenticated GET **302**. |
| `/agents/*` | Access |
| Writes (missions, memory) | Service token |
| Live board | Google (humans) |

## Cold clone — which tree

| Path | Role | Deploy? |
|---|---|---|
| `dist/` | Public HTML/CSS/JS | Yes — Worker **Assets**. Face. |
| `src/` | This Worker: routes, Google, voice, MCP, A2A | Yes — `main` in root wrangler |
| `agent-alfred/` | Bound ORAL Worker | Separate `wrangler deploy` in that folder |
| `alfred-report/` | Bound board Worker | Separate deploy in that folder |
| `lab/` | Attic | No |

Artifacts is source of truth. `dist/` is what the browser gets. Nested Workers are not the homepage.

## Agents

Index: https://alfred.report/llms.txt  
Card: https://alfred.report/.well-known/agent.json  
MCP: https://mcp.alfred.report/mcp with `CF-Access-Client-Id` and `CF-Access-Client-Secret`. No token → 302.
