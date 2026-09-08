# Alfred System Roadmap

## Reality Check

Most of the technology in the previous roadmap is **already live**. Containers
are GA. VPC TCP is GA. Post-quantum is live. 64 MiB Workers are live. AI Search
is live. Agents SDK is live. MCP 2026-07-28 is live. BotBase is live. Sandbox
SDK is GA. Pay Per Crawl is in closed beta. Wallets are in early access.

There is no reason to spread this over 12 months. **We launch everything
available this month.**

---

## Part 1: September 2026 — Full System Launch (Weeks 1-4)

### Week 1 — Infrastructure + Deploy

#### Day 1-2: Provision Everything

| Task | Command / Action | Status |
|------|------------------|--------|
| Delete abandoned Workers | Dashboard cleanup | ☐ |
| Create D1 database `alfred-db` | `wrangler d1 create alfred-db` | ☐ |
| Apply schema.sql + schema-v2.sql | `wrangler d1 execute alfred-db --remote --file=./schemas/schema.sql` | ☐ |
| Create Agent Memory namespace `alfred` | `wrangler agent-memory namespace create alfred` | ☐ |
| Create KV namespace `alfred-command` | `wrangler kv namespace create alfred-command` | ☐ |
| Create R2 buckets | `wrangler r2 bucket create alfred-data` + `alfred-snapshots` | ☐ |
| Create AI Search instance `alfred-kb` | Dashboard: AI > AI Search > Create | ☐ |
| Enable AI Search public endpoint | Dashboard: Settings > Public Endpoint > Enable | ☐ |
| Create AI Gateway `alfred-gateway` | API or Dashboard | ☐ |
| Register MiMo custom provider | API: `custom-providers` endpoint | ☐ |
| Register xAI custom provider | API: `custom-providers` endpoint | ☐ |
| Create Secrets Store `alfred-secrets` | `wrangler secrets-store store create alfred-secrets --remote` | ☐ |
| Store OPENAI_API_KEY | `wrangler secrets-store secret put OPENAI_API_KEY --store alfred-secrets --remote` | ☐ |
| Store MIMO_API_KEY | `wrangler secrets-store secret put MIMO_API_KEY --store alfred-secrets --remote` | ☐ |
| Store XAI_API_KEY | `wrangler secrets-store secret put XAI_API_KEY --store alfred-secrets --remote` | ☐ |
| Store CF_API_TOKEN | `wrangler secrets-store secret put CF_API_TOKEN --store alfred-secrets --remote` | ☐ |
| Reserve Wallet handle | https://cloudflare.pay/ | ☐ |
| Create Analytics Engine dataset `alfred_cop` | Automatic on first writeDataPoint | ☐ |

#### Day 3-4: Deploy Three Workers

```bash
# 1. agent-alfred (no dependencies)
cd agent-alfred && npm ci && npx wrangler deploy

# 2. alfred-report (no dependencies)
cd ../alfred-report && npm ci && npx wrangler deploy

# 3. command-os-review (service bindings to both)
cd .. && npm ci && npm run build && npx wrangler deploy
```

- Replace all `<NAMESPACE_ID>`, `<DATABASE_ID>` placeholders
- Set custom domains: `command-os-review.icebergmedia.co.uk`, `voice.alfred.report`, `speak.alfred.report`, `mcp.alfred.report`
- Enable Web Analytics
- Verify health: `curl https://command-os-review.icebergmedia.co.uk/api/health`

**Deliverable:** Three Workers live, all bindings connected, health checks green.

---

### Week 2 — Voice + COP Map + Agent Discoverability

#### Voice (live now)
- WebSocket voice sessions via VoiceSessionDO (hibernation API)
- Workers AI STT: `@cf/openai/whisper-large-v3-turbo` + `@cf/deepgram/flux`
- Workers AI TTS: `@cf/deepgram/aura-2-en`
- Turn detection: `@cf/pipecat-ai/smart-turn-v2`
- HTTP TTS: `speak.alfred.report/api/tts`
- HTTP STT: `speak.alfred.report/api/stt`
- Custom voice samples: R2 upload + D1 `voice_samples` table
- COP telemetry on every STT/TTS call (Analytics Engine `alfred_cop`)

#### COP Map (live now)
- Analytics Engine `alfred_cop` dataset — `recordCop()` on every AI call
- D1 cost ledger: `cost_events` + `mission_costs` rollup trigger
- 7 COP API endpoints: overview, missions, agents, voice, gateway, memory, burn-rate
- COP Map dashboard view: stats grid, burn rate, cost per mission, agent status, voice activity, gateway usage, memory usage
- Budget alerts: Dashboard → Manage Account → Billing → Billable Usage

#### Agent Discoverability (live now)
- AI Search MCP endpoint: `alfred-kb` instance, public `/mcp` endpoint
- MCP server (MCP 2026-07-28 stateless): `mcp.alfred.report/mcp` — 4 tools
- A2A agent card: `/.well-known/agent.json`
- A2A task lifecycle: `/a2a/tasks/send`, `/get`, `/cancel`
- `llms.txt`: agent-readable site index
- Cloudflare Access: service token auth on write endpoints

**Deliverable:** Alfred speaks, COP Map shows live telemetry, external agents can discover Alfred.

---

### Week 3 — Agents SDK + Containers + Sandbox + VPC

#### Agents SDK Migration (live now)
- Rebuild agent-alfred as Agents SDK `Agent` (Durable Object-based)
- `createBrowserTools` — Browser Run: browser_execute, /crawl, quick actions
- `createAISearchTool` — grounded retrieval over `alfred-kb`
- `createPaymentsTool` — Cloudflare Wallets integration
- `@cloudflare/voice` withVoice — WorkersAIFluxSTT + WorkersAITTS
- Durable execution: fibers, scheduling, state via Agent base class

#### Containers GA (live since Apr 2026)
- Deploy `alfred-runner` container for heavy agent workloads:
  - PDF report generation
  - Data processing / ETL
  - ML inference beyond Workers AI models
- Docker Hub support — use existing images for specialized tools
- SSH into live containers for debugging
- Active-CPU pricing — pay only when agents actually compute

```jsonc
// Add to command-os-review wrangler.jsonc
{
  "containers": [
    { "binding": "ALFRED_RUNNER", "image": "./Dockerfile", "max_instances": 10 }
  ]
}
```

#### Sandbox SDK (GA since Apr 2026)
- Isolated environments for executing untrusted agent-generated code
- Alfred writes and runs mission-specific scripts in a sandbox
- Third-party tool execution in isolation
- Safe experimentation without risking production state

```typescript
const sandbox = await env.SANDBOX.create();
const result = await sandbox.run(`
  const data = ${JSON.stringify(missionData)};
  return data.filter(d => d.priority > 7);
`);
```

#### Workers VPC + TCP `connect()` (live since Jun 2026)
- VPC Network binding for private TCP connections
- Connect to private voice AI backends (gRPC STT/TTS engines)
- Access private databases, Redis, Memcached without public exposure
- Route through Cloudflare Mesh to on-prem services
- Gateway egress filtering for Workers' public Internet traffic

```typescript
const socket = await env.PRIVATE_NETWORK.connect("10.0.1.50:50051");
```

#### 64 MiB Workers (live since Sep 2026)
- Bundle heavier dependencies — full AI SDKs, large frameworks
- Single Worker holds all of Alfred's agent logic + tools
- No more splitting logic across Workers due to size limits

#### Post-Quantum Origin Handshakes (live since Sep 2026)
- Automatic Key Exchange probes TLS 1.3 origins, prefers post-quantum
- Already live for 45B+ daily connections
- No code changes — Cloudflare handles negotiation
- Alfred's origin connections are quantum-safe by default

**Deliverable:** Alfred runs as a full Agents SDK Agent with Containers, Sandbox, VPC, and all platform capabilities.

---

### Week 4 — Monetization + Hardening + CI

#### Pay Per Crawl (closed beta — sign up now)
- Signup: https://www.cloudflare.com/paypercrawl-signup/
- Set price: $0.005/crawl on alfred.report (min $0.001)
- Per-crawler: Charge AI training bots, Allow search engines, Block scrapers
- WAF/Bot Management rules override Pay Per Crawl — configure carefully
- Cloudflare is Merchant of Record — payouts via Stripe

#### Bot Preference Sync (live since Aug 2026)
- Auto-align robots.txt with AI bot policies (Search / Agent / Training)
- Declare once, sync everywhere — no static robots.txt maintenance

#### BotBase Registration (live since Aug 2026)
- Register Alfred in BotBase directory
- Declare behavior model: content usage, data retention, identification
- Track submission status in dashboard

#### Cloudflare Wallets (early access — reserve handle now)
- Reserve handle at cloudflare.pay
- When full launch hits: create Virtual Wallet for Alfred
- Agent-initiated payments: Alfred pays for tools/data/services
- Mission budgets: Wallets enforce spend caps (complements DO budget enforcement)
- Pay-per-crawl revenue flows into Alfred's wallet
- Agent-to-agent payments via A2A

#### Cloudflare Access (live now)
- Email + service token policies on all Workers
- `ctx.access.getIdentity()` for user attribution
- Service tokens (`cfast_` format) for A2A/MCP machine-to-machine auth

#### WriteGuard Guardrails (implement now with available tools)
- Access MCP portals: restrict which MCP servers agents can write to
- Gateway MCP protocol detection: block shadow MCP traffic
- WAF rules on alfred.report API write endpoints
- Fine-grained permissions for MCP tool calls

#### Identity-Aware Analytics (live now)
- Analytics Engine `alfred_cop` carries `user_id` dimension
- Logpush Account Abuse Protection Events: `AuthenticationIdentityProvider`, `AuthenticationMethod`
- COP Map filters by user_id

#### Managed Defense + Vulnerability Discovery (live since Sep 2026)
- WAF data + OpenAI Daybreak models identify and patch critical threats
- Edge mitigations prepared when safe
- Code patch proposals for Alfred's codebase
- Context-aware vulnerability discovery using production traffic

#### CI Pipeline (build now)
- CF Artifacts → build → `wrangler deploy` → R2 snapshot
- Optional GitHub mirror
- Webhook Worker as CI runner (Cloudflare-native)

#### Logpush (live now)
- Worker logs to R2/S3 for long-term retention
- Account Abuse Protection Events dataset for security audit

**Deliverable:** Alfred is monetized, hardened, CI-automated, and production-ready.

---

## Part 2: Q4 2026 — Closed Beta → GA Transitions

These are the only items that genuinely can't ship this month because they're
in closed beta or early access. They should GA within Q4 2026.

### Pay Per Crawl — General Availability
**Current:** Closed beta. Signup open.
**Expected:** GA Q4 2026.
**Alfred action:** Already signed up and configured in beta. When GA hits:
- Expand from alfred.report to all 145+ Iceberg Media domains
- Automated pricing per zone based on content value
- Revenue dashboard integration with COP Map
- Bot Preference Sync auto-aligns all domains

### Cloudflare Wallets — Full Launch
**Current:** Early access. Handle reservation open.
**Expected:** Full launch Q4 2026.
**Alfred action:** Handle reserved. When full launch hits:
- Create Virtual Wallet for Alfred agent with spend cap
- Agent-initiated payments via `createPaymentsTool`
- Mission budget enforcement via Wallets (complements DO budget)
- Pay Per Crawl revenue flows into wallet
- Agent-to-agent payments via A2A
- Stablecoin settlement if available

### Inbound TCP to Workers
**Current:** Cloudflare says "coming soon."
**Expected:** Q4 2026.
**Alfred action:** When it launches:
- Accept raw TCP connections (not just HTTP/WebSocket)
- gRPC servers directly on Workers
- Voice sessions via raw TCP for lower latency
- Alfred as TCP proxy/gateway for other agents

### cf CLI
**Current:** Miniflare v5 preparing for it (Sep 2026).
**Expected:** Launch Q4 2026.
**Alfred action:** When stable:
- Replace `wrangler` with `cf` for all commands
- Better local dev experience
- Unified tooling across Workers, Containers, AI, R2, D1

---

## Part 3: 2027 — Genuinely Future Technology

These technologies are NOT yet available, NOT in beta, and NOT confirmed with
timelines. These are the real future bets.

### Workers GPU — Edge ML Inference
**Status:** Not announced. Containers have CPU; no GPU yet.
**What it enables:**
- Alfred runs local ML models (voice cloning, custom embeddings, fine-tuned LLMs)
- No external API calls for inference — everything at the edge
- Real-time voice cloning from R2 samples
- Custom embedding models for domain-specific semantic search

### Agent Marketplace
**Status:** Not announced. BotBase + A2A + MCP convergence makes this plausible.
**What it enables:**
- Alfred listed in a Cloudflare agent marketplace
- Other agents discover and hire Alfred for missions
- Alfred hires specialist agents for sub-tasks
- Reputation system, verified agent badges
- Monetization: agents pay agents for services

### Cloudflare-Native Database (Beyond D1)
**Status:** Not announced. D1 is SQLite-based; scale limits exist.
**What it enables:**
- Postgres-compatible database native to Cloudflare
- Complex queries, joins, aggregations D1 can't handle
- Alfred moves mission analytics to native DB
- Real-time materialized views for COP Map

### Edge ML Training
**Status:** Not announced. Workers AI does inference; no training yet.
**What it enables:**
- Alfred fine-tunes models at the edge based on user interaction patterns
- Personalized LLM per user without sending data to external providers
- Continuous learning from mission outcomes
- Adaptive voice models that improve with usage

### Cloudflare OS
**Status:** Not announced. cf CLI + Workers + Containers + VPC convergence suggests it.
**What it enables:**
- Alfred runs as a native process in a Cloudflare operating system
- No more Workers/Containers distinction — everything is just a process
- Unified networking, storage, compute
- Agent-native runtime environment

### Autonomous Agent Budgets
**Status:** Not announced. Wallets + Budget alerts + COP Map makes this plausible.
**What it enables:**
- Alfred manages its own budget autonomously
- Negotiates prices with other agents in real-time
- Self-limits spending based on mission priority
- Escrow and settlement for multi-agent missions
- Financial planning: Alfred predicts monthly costs and adjusts behavior

### Cross-Agent Memory
**Status:** Not announced. Agent Memory + A2A convergence makes this plausible.
**What it enables:**
- Agents share memory namespaces
- Alfred recalls context from conversations with other agents
- Shared knowledge base across agent ecosystem
- Memory portability: switch agents without losing context

### Real-Time Agent Collaboration
**Status:** Not announced. A2A + WebSocket + VPC makes this plausible.
**What it enables:**
- Multiple agents work on the same mission simultaneously
- Coordinate via shared Durable Object state
- Live agent presence (who's working on what)
- Conflict resolution when agents disagree
- Human-in-the-loop oversight via Live View URLs

### Quantum-Safe Agent Authentication
**Status:** Post-quantum origin handshakes are live; agent auth is not.
**What it enables:**
- Agent-to-agent auth uses post-quantum signatures
- Mission contracts signed with quantum-safe cryptography
- Future-proof against quantum computing threats to A2A trust

---

## Summary Timeline

```
September 2026 (THIS MONTH)
  Week 1  │ Infrastructure + Deploy all 3 Workers
  Week 2  │ Voice + COP Map + Agent Discoverability (A2A, MCP, AI Search)
  Week 3  │ Agents SDK + Containers + Sandbox + VPC + 64 MiB + Post-Quantum
  Week 4  │ Pay Per Crawl + BotBase + Wallets + Access + WriteGuard + CI + Logpush

Q4 2026 (Oct-Dec)
  Oct     │ Pay Per Crawl GA → expand to 145+ domains
  Oct-Nov │ Wallets full launch → agent payments live
  Nov     │ Inbound TCP to Workers → gRPC voice backends
  Dec     │ cf CLI → replace wrangler

2027 (GENUINELY FUTURE)
  Q1      │ Workers GPU (if announced) → edge ML inference
  Q1-Q2   │ Agent marketplace → Alfred listed, hiring other agents
  Q2      │ Edge ML training → personalized models per user
  Q2-Q3   │ Cloudflare-native database → beyond D1
  Q3      │ Cloudflare OS → unified runtime
  Q3-Q4   │ Autonomous agent budgets → self-managed finances
  Q4      │ Cross-agent memory + real-time collaboration
```

---

## Risk Factors

| Risk | Mitigation |
|------|-----------|
| Pay Per Crawl stays in closed beta | Already signed up; Bot Preference Sync + robots.txt as fallback |
| Wallets full launch delayed | DO + D1 cost tracking enforces budgets now; Wallets adds payments later |
| Inbound TCP delayed | WebSocket voice sessions work now — no blocking dependency |
| Agents SDK breaking changes | Pin version in package.json; test before upgrading |
| Custom provider (MiMo) availability | Workers AI as default; OpenAI/xAI as alternatives |
| cf CLI replaces wrangler | wrangler remains supported; migrate when stable |
| 64 MiB not enough | Containers for anything beyond 64 MiB |
| VPC TLS not yet supported | Plaintext TCP works now; TLS expected soon |

---

## Success Metrics

| Metric | Week 2 Target | Week 4 Target | Q4 2026 Target | 2027 Target |
|--------|---------------|--------------|-----------------|------------|
| Active missions | 5 | 20 | 100 | 1,000 |
| Voice sessions/day | 10 | 25 | 100 | 500 |
| Cost per mission | < $0.10 | < $0.05 | < $0.02 | < $0.01 |
| Agent response latency | < 2s | < 1s | < 500ms | < 200ms |
| MCP tool calls/day | 10 | 100 | 1,000 | 10,000 |
| A2A delegations/day | 0 | 10 | 100 | 500 |
| Pay Per Crawl revenue | $0 | $0 | $100/month | $1,000/month |
| Container workloads/day | 0 | 5 | 50 | 200 |
| Sandbox executions/day | 0 | 5 | 50 | 200 |
| Uptime | 99% | 99.9% | 99.95% | 99.99% |