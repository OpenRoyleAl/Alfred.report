> **QUARANTINED.** Not canon.  
> Deploy: repo root `npx wrangler deploy`. Live: `https://alfred.report`. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

# Deployment Guide v2 — Alfred Complete System

## Prerequisites
```bash
npm install -g wrangler@latest
npx wrangler login
npx wrangler whoami
# Account: OpenRoyleAl (0870b0bdbc14bcd31f43fe5e82c3ee8e)
```

## Step 1 — Delete Abandoned Workers
Dashboard: Workers & Pages. Keep only: `agent-alfred`, `alfred-report`.

## Step 2 — Create D1 Database
```bash
npx wrangler d1 create alfred-db
npx wrangler d1 execute alfred-db --remote --file=./schemas/schema.sql
npx wrangler d1 execute alfred-db --remote --file=./schemas/schema-v2.sql
npx wrangler d1 execute alfred-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```
Expected: missions, voice_sessions, mission_events, user_preferences, voice_samples, mission_costs, cost_events, memory_snapshots

## Step 3 — Create Agent Memory Namespace
```bash
npx wrangler agent-memory namespace create alfred
```

## Step 4 — Create KV Namespace (CF Artifacts only)
```bash
npx wrangler kv namespace create alfred-command
```

## Step 5 — Create R2 Buckets
```bash
npx wrangler r2 bucket create alfred-data
npx wrangler r2 bucket create alfred-snapshots
```

## Step 6 — Create AI Search Instance
1. Dashboard: AI > AI Search > Create instance
2. Name: `alfred-kb`
3. Data source: URL (https://alfred.report) or upload
4. Settings > Public Endpoint > Enable

## Step 7 — Create AI Gateway
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/0870b0bdbc14bcd31f43fe5e82c3ee8e/ai-gateway/gateways" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"id": "alfred-gateway", "name": "Alfred AI Gateway"}'
```
Register custom providers (MiMo, xAI) as per ai-gateway.md.

## Step 8 — Create Secrets Store
```bash
npx wrangler secrets-store store create alfred-secrets --remote
npx wrangler secrets-store secret put OPENAI_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put MIMO_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put XAI_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put CF_API_TOKEN --store alfred-secrets --remote
```

## Step 9 — Reserve Cloudflare Wallet Handle
1. Go to https://cloudflare.pay/
2. Reserve handle for OpenRoyleAl

## Step 10 — Enable Cloudflare Access
For each Worker: enable Access, create policy (email or service token).

## Step 11 — Set Up Pay Per Crawl (closed beta)
1. Signup: https://www.cloudflare.com/paypercrawl-signup/
2. Enable Pay Per Crawl, set price ($0.005/crawl)
3. Enable Bot Preference Sync
4. Register Alfred in BotBase

## Step 12 — Update wrangler.jsonc Files
Replace all `<NAMESPACE_ID>`, `<DATABASE_ID>` placeholders with real IDs.

## Step 13 — Deploy (in order)
```bash
# 1. Deploy agent-alfred (no service binding dependencies)
cd agent-alfred && npm ci && npx wrangler deploy

# 2. Deploy alfred-report (no service binding dependencies)
cd ../alfred-report && npm ci && npx wrangler deploy

# 3. Deploy command-os-review (depends on both service bindings)
cd .. && npm ci && npm run build && npx wrangler deploy
```

## Step 14 — Set Up Custom Domains
- alfred.report
- voice.alfred.report
- speak.alfred.report
- mcp.alfred.report

## Step 15 — Enable Web Analytics
Dashboard: Web Analytics > Add site > alfred.report

## Step 16 — Set Budget Alerts
Dashboard: Manage Account > Billing > Billable Usage > Budget alerts

## Step 17 — Verify
```bash
curl https://alfred.report/api/health
curl https://alfred.report/api/cop/overview
curl -X POST https://speak.alfred.report/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Good evening. Alfred at your service."}' --output test.mp3
curl -X POST https://mcp.alfred.report/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
curl https://alfred.report/.well-known/agent.json
curl https://alfred.report/llms.txt
```

## Resource Summary

| Resource | Name | Binding | Type |
|----------|------|---------|------|
| Worker | command-os-review | (main) | Compute |
| Worker | agent-alfred | AGENT_ALFRED (svc) | Compute |
| Worker | alfred-report | ALFRED_REPORT (svc) | Compute |
| Agent Memory | alfred | ALFRED_MEMORY | agent_memory |
| KV | alfred-command | ALFRED_COMMAND | kv |
| D1 | alfred-db | DB | d1 |
| R2 | alfred-data | ALFRED_DATA | r2 |
| R2 | alfred-snapshots | ALFRED_SNAPSHOTS | r2 |
| AI Search | alfred-kb | AI_SEARCH | ai_search |
| Browser Run | (auto) | BROWSER | browser |
| Analytics Engine | alfred_cop | ALFRED_COP | analytics_engine |
| AI Gateway | alfred-gateway | (URL) | gateway |
| Secrets Store | alfred-secrets | (4 secrets) | secrets_store |
| DO | MissionStateDO | MISSION_STATE | durable_object |
| DO | VoiceSessionDO | VOICE_SESSION | durable_object |
| Cloudflare Access | (per Worker) | ctx.access | access |
| Wallet handle | iceberg-media | (future) | wallets |
| Pay Per Crawl | alfred.report zone | (beta) | ai-crawl-control |
| BotBase | Alfred | (registration) | botbase |