> **LAB / ROADMAP — not live canon.**  
> Public truth: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) and [`../README.md`](../README.md).  
> Live host: `https://alfred.report`. Do not wire `command-os-review.icebergmedia.co.uk`.  
> This file mixes **shipped** and **wishlist** (WriteGuard / Kitesurf / “name unconfirmed”). Trust the Status column only.

# Architecture v2 — Alfred on the 2026 Agent Stack

This revision rebuilds the Alfred system on the latest Cloudflare primitives
(Agents Week Aug 2026 + recent launches). Each feature is mapped to a real
Cloudflare capability, with verification status noted.

## Feature Verification Summary

| # | Requested feature | Real Cloudflare primitive | Status |
|---|------------------|--------------------------|--------|
| 1 | @cloudflare/computer | Agents SDK + Browser Run tools | ⚠️ Name unconfirmed; capability real |
| 2 | Workers TCP/gRPC | `connect()` TCP sockets API; gRPC via Cloudflare Tunnel | ✅ |
| 3 | Billable Usage API | Billable Usage dashboard, Budget alerts, GraphQL | ✅ |
| 4 | Cloudflare Wallets | Wallets (Agents Week) + Agents SDK `payments` tool | ✅ |
| 5 | Agent Access Model | Access service tokens, OAuth scopes, MCP server portals | ⚠️ Name unconfirmed; capability real |
| 6 | Identity-aware analytics | Logpush auth fields + Analytics Engine user_id dimension | ⚠️ Name unconfirmed; capability real |
| 7 | WriteGuard | No official source — MCP write-control guardrails | ⚠️ Unconfirmed |
| 8 | WebMCP | No official source — AI Search MCP endpoint + Access MCP portal | ⚠️ Unconfirmed |
| 9 | Kitesurf | No official source — agent-first browsing = Browser Run sessions | ⚠️ Unconfirmed |
| 10 | MCPv2 | MCP 2026-07-28 stateless specification | ✅ |
| 11 | AI Search | AI Search (all plans): MCP endpoint, hybrid search, Agents SDK tool | ✅ |
| 12 | Pay Per Crawl | AI Crawl Control Pay Per Crawl (closed beta, min $0.001/crawl) | ✅ |
| 13 | Bot Preference Sync | Bot Preference Sync (blog Aug 21, 2026) — robots.txt auto-alignment | ✅ |
| 14 | BotBase | BotBase directory of bots/agents (blog Aug 28, 2026) | ✅ |
| 15 | Agents SDK Voice | `@cloudflare/voice` withVoice, WorkersAIFluxSTT, WorkersAITTS | ✅ |
| 16 | Secrets Store | Cloudflare Secrets Store (open beta, account-level secrets) | ✅ |
| 17 | CF Artifacts | CF Artifacts (in use: alfred-command namespace) | ✅ |
| 18 | Browser Rendering | Browser Run — headless Chrome, quick actions, /crawl | ✅ |

## Updated System Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    ALFRED — Agent-Native System (v2)                       │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │  command-os-review (Worker + Static Assets + Agents SDK)     │          │
│  │  Frontend + API gateway + COP Map dashboard                   │          │
│  │  Bindings: ASSETS, AGENT_ALFRED, ALFRED_REPORT, AI,           │          │
│  │  AI_SEARCH, BROWSER, DB, HERMES, ALFRED_COMMAND,              │          │
│  │  ALFRED_DATA, ALFRED_SNAPSHOTS, MISSION_STATE,                │          │
│  │  VOICE_SESSION, ALFRED_MEMORY, ALFRED_COP                     │          │
│  └──────────────────────────────────────────────────────────────┘          │
│       │                    │                     │                         │
│       ▼                    ▼                     ▼                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐          │
│  │ agent-alfred  │  │ alfred-report │  │  Workers AI               │          │
│  │ (ORAL Agent)  │  │ (Board)       │  │  TTS/STT/LLM/Embeddings  │          │
│  │  Agents SDK   │  │  + AI Search  │  └──────────────────────────┘          │
│  │  browser_exec │  │  grounding    │  ┌──────────────────────────┐          │
│  │  ai_search    │  │               │  │  AI Search (alfred KB)   │          │
│  │  payments     │  │               │  │  /mcp endpoint            │          │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘          │
│       │     ┌──────────────┴──────────────────────────┐             │
│       │     │  AI Gateway (alfred-gateway) + Secrets Store     │             │
│       │     │  BYOK: OPENAI/MIMO/XAI keys in Secrets Store     │             │
│       │     └─────────────────────────────────────────┘             │
│       ▼                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │  COP Map (Common Operational Picture)                        │          │
│  │  Analytics Engine: ALFRED_COP dataset                        │          │
│  │  - token burn per agent/mission                               │          │
│  │  - cost per mission                                           │          │
│  │  - active agents + status                                     │          │
│  │  - voice session activity                                     │          │
│  │  - AI Gateway usage                                           │          │
│  │  - memory usage                                               │          │
│  └──────────────────────────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │  Discoverability & Monetization (alfred.report zone)          │          │
│  │  - AI Search public /mcp endpoint (WebMCP-style)             │          │
│  │  - Access MCP portal (MCPv2 stateless, 2026-07-28 spec)      │          │
│  │  - Pay Per Crawl on 145+ domains (closed beta, $0.001 min)   │          │
│  │  - Bot Preference Sync (robots.txt auto-alignment)           │          │
│  │  - BotBase registration (declare Alfred's behavior model)    │          │
│  └──────────────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Feature Integration Details

### 1. Agent runtime (@cloudflare/computer → Agents SDK)
Rebuild agent-alfred as an Agents SDK `Agent` (Durable Object-based).

```typescript
import { Agent } from "agents";
import { createBrowserTools } from "agents/browser/ai";
import { createAISearchTool } from "agents/tools/ai-search";

export class OralOperator extends Agent {
  browserTools = createBrowserTools({
    ctx: this.ctx, browser: this.env.BROWSER,
    loader: this.env.LOADER, session: { mode: "dynamic" },
  });
  aiSearchTool = createAISearchTool(this.env.AI_SEARCH, "alfred-kb");
  async onMessage(message: string) { /* ORAL loop */ }
}
```

### 2. Workers TCP/gRPC — voice AI backends
Use the `connect()` TCP socket API for streaming audio to external voice backends.

### 3. Billable Usage API → cost tracking
- Account level: Billable Usage dashboard + Budget alerts
- Per-mission level: Analytics Engine `ALFRED_COP` dataset

### 4. Cloudflare Wallets — agent transactions
Use the Agents SDK `payments` tool for agent-initiated transactions.

### 5. Agent Access Model
- Access service tokens (`cfast_` format) for machine-to-machine auth
- OAuth scopes on Wrangler/Cloudflare API MCP server
- Access MCP server portals — approved MCP servers only

### 6. Identity-aware analytics
- Analytics Engine `ALFRED_COP` carries `user_id` dimension
- Logpush Account Abuse Protection Events dataset includes auth fields
- COP Map filters by user_id

### 7. WriteGuard (unconfirmed)
Implement equivalent guardrails:
- Access MCP portals restrict which MCP servers agents can write to
- Gateway MCP protocol detection blocks shadow MCP traffic
- WAF rules on alfred.report API write endpoints

### 8. WebMCP (unconfirmed)
- AI Search instance `alfred-kb` with public endpoint → `/mcp` tool
- Access MCP portal on alfred.report serving MCP 2026-07-28 stateless spec
- `llms.txt` at alfred.report for agent discovery

### 9. Kitesurf (unconfirmed)
Agent-first browsing covered by Browser Run:
- Persistent browser sessions
- Live View URLs for human-in-the-loop
- Quick actions: browser_markdown, browser_extract, browser_links, browser_scrape

### 10. MCPv2 → MCP 2026-07-28 stateless spec
- Stateless requests, no protocol session or protocol-specific DO
- `/mcp` endpoint accepts both new stateless and 2025 Streamable HTTP clients

### 11. AI Search — alfred.report as agent-ready search
- Create AI Search instance `alfred-kb`, index alfred.report content
- Enable public endpoint → agents query via `/mcp` (search tool)
- Expose `instance.search()` as an agent tool
- Hybrid search + metadata filtering

### 12. Pay Per Crawl — monetize AI crawler access
- Closed beta; signup: https://www.cloudflare.com/paypercrawl-signup/
- Set price per zone (min $0.001/crawl); Cloudflare is Merchant of Record
- Per-crawler actions: Charge / Allow / Block
- WAF/Bot Management rules override Pay Per Crawl "charge"

### 13. Bot Preference Sync
- Automatically aligns robots.txt with AI bot policies (Search / Agent / Training)
- No static file maintenance — declare once, sync everywhere

### 14. BotBase
- Register Alfred in BotBase (directory of bots and agents)
- Declare behavior model: how Alfred uses content (search, agent, training)

### 15. Agents SDK Voice — built-in voice channel
```typescript
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
const VoiceAgent = withVoice(Agent);
export class AlfredVoice extends VoiceAgent {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
  async onTurn(transcript: string, context: any) {
    const response = await this.env.AGENT_ALFRED.process(transcript, context);
    return response; // TTS speaks automatically
  }
}
```

### 16. Secrets Store
Move all secrets to account-level Secrets Store:
```bash
wrangler secrets-store store create alfred-secrets --remote
# OPENAI_API_KEY, MIMO_API_KEY, XAI_API_KEY, CF_API_TOKEN
```

### 17. CF Artifacts
Already in use (alfred-command namespace). Keep as Git compatible source of truth.

### 18. Browser Rendering → Browser Run
- `browser_execute` for interactive multi-step automation (CDP)
- Quick actions for one-shot tasks
- `/crawl` endpoint for whole-site research
- Playwright + Puppeteer + Stagehand support

## Migration Path (v1 → v2)

1. Add `ai_search`, `browser`, `analytics_engine_datasets` bindings to all 3 Workers
2. Create AI Search instance `alfred-kb`, index alfred.report
3. Create Analytics Engine dataset `alfred_cop`
4. Move secrets to Secrets Store, rebind all Workers
5. Rebuild agent-alfred as Agents SDK Agent with browser + AI Search + payments tools
6. Swap VoiceSessionDO TTS/STT for `@cloudflare/voice` withVoice
7. Add COP Map API endpoints (`/api/cop/*`) + dashboard view
8. Enable AI Search public /mcp endpoint + Access MCP portal (MCPv2 stateless)
9. Configure AI Crawl Control: Bot Preference Sync, Pay Per Crawl, BotBase registration
10. Set Budget alerts on Billable Usage dashboard