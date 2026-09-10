> **LAB.** Card is live at `https://alfred.report/.well-known/agent.json`.

# A2A Integration — Agent-to-Agent Communication

## Overview

Google's A2A (Agent-to-Agent) Protocol is an open standard for inter-agent
communication. Alfred exposes A2A endpoints so external agents can discover
and delegate tasks to Alfred.

Reference: https://github.com/google/A2A

## Architecture

```
External Agent (A2A client)
  | A2A JSON-RPC over HTTP
  v
command-os-review Worker
  +-- /.well-known/agent.json    → A2A agent card (discovery)
  +-- /a2a/tasks/send            → Create task (delegate to Alfred)
  +-- /a2a/tasks/get             → Poll task status
  +-- /a2a/tasks/cancel          → Cancel task
  v
agent-alfred (ORAL operator)     → processes the task
  v
alfred-report (Board)           → generates evidence/report
```

## Agent Card

Alfred publishes an A2A agent card at `/.well-known/agent.json`:

```json
{
  "name": "Alfred",
  "description": "ORAL operator — mission execution, voice interaction, report generation",
  "version": "2.0.0",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text", "voice"],
  "defaultOutputModes": ["text", "voice", "json"],
  "skills": [
    { "id": "oral_operator", "name": "ORAL Operator", "description": "Execute bounded missions with typed evidence" },
    { "id": "voice_interaction", "name": "Voice Interaction", "description": "Real-time voice via WebSocket (Workers AI TTS/STT)" },
    { "id": "report_generation", "name": "Report Generation", "description": "Generate structured reports from mission data" }
  ],
  "authentication": { "type": "cloudflare-access", "serviceToken": true }
}
```

## A2A Authentication

- Service token for machine-to-machine (A2A clients)
- `ctx.access.getIdentity()` for human-initiated A2A tasks
- A2A tasks carry `user_id` prefixed with `a2a:` to distinguish from direct users

## Outbound A2A (Alfred delegating to other agents)

```typescript
export async function delegateToAgent(
  agentUrl: string,
  task: string,
  authToken: string,
): Promise<string> {
  const response = await fetch(`${agentUrl}/tasks/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      message: { role: "user", parts: [{ type: "text", text: task }] },
    }),
  });
  const result = await response.json();
  return result.artifacts?.[0]?.parts?.[0]?.text || "No response";
}
```

## Routes in command-os-review

```typescript
app.get("/.well-known/agent.json", (c) => handleAgentCard(c.env));
app.post("/a2a/tasks/send", (c) => handleTaskSend(c.req.raw, c.env));
app.get("/a2a/tasks/get", (c) => handleTaskGet(c.req.raw, c.env));
app.post("/a2a/tasks/cancel", (c) => handleTaskCancel(c.req.raw, c.env));
```