> **QUARANTINED.** Health-check host is Iceberg. Live MCP is Access-gated.  
> Canon: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). `https://mcp.alfred.report/mcp` needs a Cloudflare Access **service token** or it 302s.

# WebMCP Integration — Agent Discoverability

## Overview

Alfred makes its capabilities discoverable via:

1. **AI Search MCP endpoint** — built-in `/mcp` on the AI Search instance
2. **Access MCP portal** — serving MCP 2026-07-28 stateless spec
3. **`llms.txt`** — agent-readable site index
4. **Agent card** — A2A `/.well-known/agent.json`

## Three Layers of Discoverability

### Layer 1: AI Search MCP Endpoint (Cloudflare-native)

AI Search instances include a built-in MCP endpoint. Create instance
`alfred-kb`, index alfred.report content, enable public endpoint:

```
https://<INSTANCE_ID>.search.ai.cloudflare.com/mcp
```

Agents query using the MCP `search` tool:
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "query": "How does Alfred handle mission budgets?" }
  }
}
```

Setup:
1. Dashboard: AI > AI Search > Create instance `alfred-kb`
2. Index alfred.report content
3. Settings > Public Endpoint > Enable
4. Copy the `/mcp` URL

### Layer 2: Access MCP Portal (MCP 2026-07-28 stateless)

Serve an MCP endpoint on `mcp.alfred.report` using the MCP 2026-07-28
stateless specification.

Tools exposed:
- `create_mission` — Create a new Alfred mission
- `query_missions` — List missions with optional status filter
- `get_report` — Get a mission report
- `speak` — Send text to Alfred via TTS

### Layer 3: llms.txt for Agent Discovery

```
# alfred.report
# AI agent-readable site index

# About
Alfred is an ORAL (Operator Response and Action Logic) operator running on Cloudflare Workers.
Capabilities: mission execution, voice interaction, report generation.

# MCP Endpoint
https://mcp.alfred.report/mcp

# A2A Agent Card
https://alfred.report/.well-known/agent.json

# AI Search (knowledge base)
https://<INSTANCE_ID>.search.ai.cloudflare.com/mcp

# API
https://command-os-review.icebergmedia.co.uk/api/health
https://speak.alfred.report/api/tts
https://voice.alfred.report/ws

# Authentication
Cloudflare Access service token required for write endpoints.
Read endpoints (health, agent card, llms.txt) are public.
```

## Routes in command-os-review

```typescript
app.get("/llms.txt", (c) => c.text(llmsTxtContent));
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));
app.get("/.well-known/agent.json", (c) => handleAgentCard(c.env));
```

## Security

- MCP `/mcp` endpoint protected by Cloudflare Access (service token)
- AI Search public endpoint is read-only (search tool only)
- A2A agent card is public (discovery only, no auth needed)
- `llms.txt` is public (discovery only)