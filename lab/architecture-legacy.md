> **QUARANTINED.** Old diagram. Not canon.  
> Use [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Public host is `alfred.report`.

# Full Application Architecture — Alfred Cloudflare-Native System

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ALFRED — Cloudflare-Native System                     │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │  command-os-review (Worker + Static Assets)                  │        │
│  │  Frontend + API Gateway Worker                                │        │
│  │  Routes:                                                      │        │
│  │    alfred.report  → Static UI          │        │
│  │    voice.alfred.report                   → WebSocket voice    │        │
│  │    speak.alfred.report                   → HTTP TTS endpoint   │        │
│  │  Bindings:                                                    │        │
│  │    ASSETS, AGENT_ALFRED (svc), ALFRED_REPORT (svc)           │        │
│  │    AI, DB (D1), ALFRED_COMMAND (KV), HERMES (KV)             │        │
│  │    ALFRED_DATA (R2), ALFRED_SNAPSHOTS (R2)                   │        │
│  │    ALFRED_MEMORY (Vectorize), MISSION_STATE (DO)             │        │
│  │    VOICE_SESSION (DO)                                         │        │
│  └──────────────────────────────────────────────────────────────┘        │
│       │                    │                     │                       │
│       ▼                    ▼                     ▼                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐        │
│  │ agent-alfred  │  │ alfred-report │  │  Workers AI               │        │
│  │ (ORAL operator│  │ (Board)       │  │  TTS/STT/LLM/Embeddings  │        │
│  │  Worker)      │  │                │  └──────────────────────────┘        │
│  └──────────────┘  └──────────────┘                                         │
│       │     ┌──────────────┴──────────────────────────────────┐           │
│       │     │  AI Gateway (alfred-gateway)                     │           │
│       │     │  Custom providers: MiMo, OpenAI, xAI            │           │
│       │     │  Features: caching, rate limiting, observability │           │
│       │     └─────────────────────────────────────────┘           │
│       ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐         │
│  │  Durable Objects                                             │         │
│  │  MissionStateDO (per-mission state)                           │         │
│  │  VoiceSessionDO (per-session WebSocket)                       │         │
│  └──────────────────────────────────────────────────────────────┘         │
│  ┌──────────────────────────────────────────────────────────────┐         │
│  │  Storage Layer                                               │         │
│  │  KV: alfred-command  → CF Artifacts source storage           │         │
│  │  KV: hermes          → Agent memory, profiles, sessions     │         │
│  │  D1: alfred-db       → Missions, voice_sessions, events     │         │
│  │  R2: alfred-data     → Voice samples, audio recordings      │         │
│  │  R2: alfred-snapshots→ CI build snapshots                   │         │
│  │  Vectorize: alfred-mem→ Semantic memory recall              │         │
│  └──────────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### command-os-review (Worker + Static Assets)
The unified frontend and API gateway. Migrated from Pages to Worker
with Static Assets for full Worker capabilities.

**Routes:**
- `alfred.report` — Static UI
- `voice.alfred.report/ws/:sessionId` — WebSocket voice sessions
- `speak.alfred.report/api/tts` — HTTP TTS endpoint
- `speak.alfred.report/api/stt` — HTTP STT endpoint
- `/api/missions/*` — Mission CRUD
- `/api/reports/*` — Report generation
- `/api/voice-samples/*` — Custom voice upload

### agent-alfred (Worker — ORAL Operator)
The ORAL (Operator Response and Action Logic) operator. Processes
natural language commands, manages mission lifecycle, generates
responses for TTS.

### alfred-report (Worker — Board)
Generates reports from mission data, voice session transcripts, and
event audit trails.

## End-to-End Request Flows

### 1. Voice Interaction (real-time)
```
User opens voice.alfred.report → WebSocket → VoiceSessionDO (hibernation)
→ User speaks → audio chunks → Workers AI Whisper (STT)
→ Transcript → agent-alfred → ORAL processing
→ Response → Workers AI Aura-2 (TTS) → audio back via WebSocket
→ Session saved to KV + D1
```

### 2. Mission Creation (HTTP)
```
User creates mission → POST /api/missions → command-os-review
→ Service binding → agent-alfred → creates mission in D1
→ Creates MissionStateDO instance → logs event in D1
→ Loads Alfred profile from KV → loads user preferences from D1
→ Response returned to UI
```

### 3. Report Generation
```
User requests report → POST /api/reports → command-os-review
→ Service binding → alfred-report → queries D1
→ Loads session context from KV → generates report
→ Optional: stored in R2
```

### 4. Semantic Memory Recall
```
User asks "what did we discuss about X?"
→ agent-alfred generates embedding via Workers AI (BGE-M3)
→ Vectorize query (alfred-memory) with user filter
→ Top-K results → synthesizes response → spoken via TTS or displayed
```

## Worker Cleanup

### Active Workers (KEEP)
| Worker | Role |
|--------|------|
| `agent-alfred` | ORAL operator |
| `alfred-report` | Board / report generation |
| `command-os-review` | Frontend + API gateway |

### Abandoned Workers (DELETE ALL)
Delete all others to free routes, binding slots, and reduce attack surface.

## Deployment Checklist
- [ ] Delete abandoned Workers
- [ ] Create D1 database: `npx wrangler d1 create alfred-db`
- [ ] Apply schema: `npx wrangler d1 execute alfred-db --remote --file=./schemas/schema.sql`
- [ ] Create KV namespace: `npx wrangler kv namespace create hermes`
- [ ] Create R2 buckets: `alfred-data` and `alfred-snapshots`
- [ ] Create Vectorize index: `npx wrangler vectorize create alfred-memory --dimensions 1024`
- [ ] Create AI Gateway (id: `alfred-gateway`)
- [ ] Register custom providers: MiMo, xAI
- [ ] Set secrets via Secrets Store
- [ ] Update wrangler.jsonc with actual IDs
- [ ] Deploy: `npx wrangler deploy`
- [ ] Set up custom domains
- [ ] Enable Web Analytics
- [ ] Test end-to-end