# Command OS v2 — Alfred

**Say "Alfred, report." Get closed work back with proof.**

Voice-first AI operator for business missions. Runs entirely on Cloudflare.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OpenRoyleAl/command-os-v2)

---

## What Is This?

Alfred is a voice-first AI Chief of Staff. Instead of chat windows and dashboards, you speak to Alfred and he speaks back with your mission status.

**One wake word. Closed work. Verified proof.**

```
You: "Hey Siri, Alfred report."
Alfred: "Good morning. 4 active missions. Cardigan needs your input. Shall I proceed?"
You: "Option 2."
Alfred: "Done. Cardigan updated. Anything else?"
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ YOU                                                          │
│ Siri / Google Assistant / Voice / Board                      │
└───────────────────────┬──────────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ command-os-review (Frontend + COP Map)                       │
│ Service Binding → agent-alfred (ORAL Operator)               │
│ Service Binding → alfred-report (Board)                      │
└──────────────────────────────────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ ORAL Operator (agent-alfred)                                 │
│ Missions → Voice → Memory → AI Gateway → Browser → Reports  │
└──────────────────────────────────────────────────────────────┘
```

## Features

- **Voice-first:** WebSocket real-time voice sessions via Durable Objects
- **Provider-agnostic TTS:** Workers AI default, MiMo/OpenAI/xAI as options
- **Mission lifecycle:** Intent → contract → execution → evidence → gate → voice report
- **COP Map:** Real-time token burn, costs, agent status, mission state
- **Agent Memory:** Persistent memory via Cloudflare Agent Memory
- **A2A Protocol:** Agent-to-agent communication (Google A2A)
- **WebMCP:** Agent discoverability via web standard
- **Pay Per Crawl:** Monetize AI crawler access on your domains
- **Multi-tenant:** Each user gets their own voice, data, and preferences

## Quick Start

### 1. Clone

```bash
git clone https://github.com/OpenRoyleAl/command-os-v2.git
cd command-os-v2
```

### 2. Install

```bash
npm install
cd agent-alfred && npm install && cd ..
cd alfred-report && npm install && cd ..
```

### 3. Deploy

```bash
# Deploy agent-alfred first
cd agent-alfred && npx wrangler deploy && cd ..

# Deploy alfred-report second
cd alfred-report && npx wrangler deploy && cd ..

# Deploy command-os-review last
npx wrangler deploy
```

### 4. Configure

Replace placeholders in `wrangler.jsonc`:
- `<NAMESPACE_ID>` → Your KV namespace ID
- `<DATABASE_ID>` → Your D1 database ID

Set secrets:
```bash
cd agent-alfred
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put MIMO_API_KEY
npx wrangler secret put XAI_API_KEY
```

### 5. Test

```bash
# Health check
curl https://voice.alfred.report/health

# Create a mission
curl -X POST https://voice.alfred.report/api/missions \
  -H "Content-Type: application/json" \
  -d '{"user_id":"hans","title":"Test mission","description":"Verify Alfred works"}'

# Voice briefing
curl https://voice.alfred.report/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Good morning, Hans. All systems operational."}' \
  -o briefing.wav
```

## Project Structure

```
command-os-v2/
├── src/                          # Main Worker source
│   ├── index.ts                  # Hono router (all endpoints)
│   ├── types.ts                  # TypeScript types
│   ├── ai/gateway.ts             # AI Gateway integration
│   ├── cop/cop.ts                # COP Map API (7 endpoints)
│   ├── cop/telemetry.ts          # Cost tracking wrapper
│   ├── db/queries.ts             # D1 database queries
│   ├── do/mission-state.ts       # Mission Durable Object
│   ├── do/voice-session.ts       # Voice WebSocket Durable Object
│   ├── mcp/server.ts             # MCP server (MCPv2)
│   ├── memory/agent-memory.ts    # Agent Memory integration
│   ├── memory/hermes.ts          # KV-based memory (legacy)
│   ├── memory/vectorize.ts       # Vectorize semantic recall
│   ├── voice/tts.ts              # TTS provider factory
│   ├── voice/stt.ts              # STT provider factory
│   ├── voice/custom-voice.ts     # Voice sample upload
│   ├── a2a/agent-card.ts         # A2A agent card
│   ├── a2a/tasks.ts              # A2A task lifecycle
│   └── computer/computer.ts      # @cloudflare/computer
├── agent-alfred/                 # ORAL Operator Worker
│   ├── src/index.ts              # ORAL processing
│   ├── src/agents-sdk.ts         # Agents SDK integration
│   ├── wrangler.jsonc            # Worker config
│   └── package.json
├── alfred-report/                # Board Worker
│   ├── src/index.ts              # Reports, AI summaries
│   ├── wrangler.jsonc            # Worker config
│   └── package.json
├── dist/                         # Frontend UI
│   ├── index.html                # SPA with 6 views
│   ├── app.js                    # Client logic
│   └── styles.css                # Dark theme
├── schemas/                      # D1 database schemas
│   ├── schema.sql                # v1 tables
│   └── schema-v2.sql             # v2 tables (COP, costs)
├── wrangler.jsonc                # Main Worker config
├── package.json
├── tsconfig.json
├── _headers                      # Security headers
├── _redirects                    # SPA routing
├── architecture-v2.md            # Full architecture
├── deployment-guide.md           # Step-by-step deploy
├── cop-map.md                    # COP Map design
├── voice-architecture.md         # Voice/TTS design
├── a2a-integration.md            # A2A protocol
├── webmcp-integration.md         # WebMCP integration
└── pay-per-crawl-setup.md        # Pay Per Crawl
```

## API Endpoints

### Voice
- `POST /api/tts` — Text-to-speech (returns audio)
- `POST /api/stt` — Speech-to-text (accepts audio)
- `WS /ws/:sessionId` — Real-time voice session

### Missions
- `POST /api/missions` — Create mission
- `GET /api/missions/:id` — Get mission
- `GET /api/missions` — List missions
- `POST /api/missions/:id/evidence` — Submit evidence

### COP Map
- `GET /api/cop/overview` — System overview
- `GET /api/cop/missions` — Mission costs
- `GET /api/cop/agents` — Agent activity
- `GET /api/cop/voice` — Voice sessions
- `GET /api/cop/gateway` — AI Gateway usage
- `GET /api/cop/memory` — Memory usage
- `GET /api/cop/burn-rate` — Token burn rate

### Memory
- `POST /api/memory/ingest` — Ingest knowledge
- `POST /api/memory/recall` — Recall by query
- `GET /api/memory/summary` — Get summary

### Agent Protocols
- `GET /.well-known/agent.json` — A2A agent card
- `POST /a2a/tasks/send` — Send A2A task
- `POST /mcp` — MCP endpoint (4 tools)

### Health
- `GET /health` — Health check
- `GET /llms.txt` — Agent-readable index

## Cloudflare Services Used

| Service | Purpose |
|---------|---------|
| Workers | 3 Workers (command-os-review, agent-alfred, alfred-report) |
| Durable Objects | Mission state, voice sessions |
| D1 | Structured data (missions, events, preferences) |
| KV | Agent Memory (hermes namespace) |
| Vectorize | Semantic recall (BGE-M3) |
| R2 | Voice samples, backups |
| AI Gateway | Unified LLM routing |
| Workers AI | TTS, STT, LLM |
| Agents SDK | Voice agent framework |
| Browser Run | Web scraping |
| Cloudflare Wallets | Agentic payments |
| Pay Per Crawl | Monetize AI crawlers |
| Secrets Store | API key management |
| CF Artifacts | Source storage |
| Billable Usage API | Cost tracking |
| @cloudflare/computer | Virtual filesystem |
| Web Analytics | Privacy-friendly analytics |
| Cloudflare Access | Authentication |

## Roadmap

### This Month (September 2026)
- Week 1: Deploy all infrastructure
- Week 2: Voice + COP Map + Agent Discoverability
- Week 3: Agents SDK + Browser Run + Wallets
- Week 4: Pay Per Crawl + CI Pipeline

### Q4 2026
- Pay Per Crawl GA → expand to 145+ domains
- Wallets full launch → agent payments live
- First external users

### 2027
- Cloudflare OS integration
- Agent marketplace
- Cross-agent memory
- Real-time collaboration

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

**Built with:** Cloudflare Workers, Durable Objects, D1, KV, Vectorize, R2, AI Gateway, Workers AI, Agents SDK, Browser Run, Wallets, Pay Per Crawl, Secrets Store, Artifacts, @cloudflare/computer

**Voice powered by:** Workers AI (Aura-1/2, MeloTTS, Whisper, Nova-3) + MiMo/OpenAI/xAI via AI Gateway

**Protocol support:** A2A (Google), MCPv2, WebMCP, Pay Per Crawl

---

*"Alfred, report!"*
