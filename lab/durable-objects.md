# Durable Objects — Mission State & Session Authority

## Overview

Two DO classes handle stateful coordination:

1. **MissionStateDO** — per-mission state authority (ORAL operator state)
2. **VoiceSessionDO** — per-session WebSocket authority (voice sessions)

Reference: [Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)

## Why Durable Objects

| Need | Plain Worker | Durable Object |
|------|-------------|----------------|
| Stateless request handling | ✅ | ❌ (overkill) |
| Per-mission strong consistency | ❌ | ✅ |
| WebSocket session coordination | ❌ | ✅ |
| Serialized operations (no race conditions) | ❌ | ✅ |
| Scheduled work per entity (alarms) | ❌ | ✅ |
| Persistent connections across requests | ❌ | ✅ |

## MissionStateDO — ORAL Operator State Authority

Each mission gets its own DO instance. The DO is the single source of truth
for mission state — status transitions, directive accumulation, and result
aggregation are all serialized through it.

Lifecycle: intent → contract → execution → evidence → gate →
durable state → voice report → completed (server-derived)

Key features:
- State transitions: start, pause, resume, complete, cancel
- Evidence collection with typed evidence
- Independent gate verification (budget enforcement, evidence check)
- Voice report generation via TTS on completion
- Alarm-based timeout (30 min default)
- D1 event logging for audit trail

## VoiceSessionDO — WebSocket Session Authority

Each voice session gets its own DO instance. Uses Hibernation API:
- Clients stay connected while DO sleeps
- No duration charges during hibernation
- DO wakes automatically when a message arrives
- Auto ping/pong handled without waking the DO

Pipeline: WebSocket → STT (Whisper/Flux) → ORAL operator → TTS (Aura-2) → audio back

## DO Registration in wrangler.jsonc

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "MISSION_STATE", "class_name": "MissionStateDO" },
      { "name": "VOICE_SESSION", "class_name": "VoiceSessionDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MissionStateDO", "VoiceSessionDO"] }
  ]
}
```

## DO Lifecycle

```
Request arrives → constructor() → active (in-memory)
    ↓
All requests done → idle (10s) → hibernated (WS stays connected)
    ↓
New message → constructor() → active (in-memory)
    ↓
70-140s no activity (non-hibernateable) → inactive (cold start on next request)
```

All important state is persisted to DO storage before hibernation.

Reference: [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)