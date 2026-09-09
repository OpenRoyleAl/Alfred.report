# Agent Memory — Hermes Namespace & Alfred Profile

## Overview

Agent Memory gives Alfred persistent, structured memory across sessions.
The system uses a dedicated KV namespace (`hermes`) for fast key-value
retrieval and a Vectorize index for semantic recall.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Agent Memory Layer                          │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │  KV: hermes  │  │  Vectorize:          │  │
│  │  - Profile   │  │  alfred-memory       │  │
│  │  - Session   │  │  - Semantic search   │  │
│  │  - State     │  │  - Recall by meaning  │  │
│  └─────────────┘  └──────────────────────┘  │
│  ┌─────────────────────────────────────┐    │
│  │  D1: alfred-db                       │    │
│  │  - Structured mission data           │    │
│  │  - Voice session records             │    │
│  │  - Event audit trail                 │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

## KV Namespace: hermes

### Key Structure
```
hermes/
├── profile:alfred          → Alfred's core profile (personality, config)
├── profile:{userId}        → Per-user profile customization
├── session:{sessionId}     → Session context and history
├── preferences:{userId}    → User preferences (TTS provider, voice, etc.)
├── state:oral:{missionId}  → ORAL operator state snapshot
├── memory:{userId}:{key}   → General memory entries
└── index:{userId}          → Memory index for listing
```

### Profile: Alfred
```json
{
  "name": "Alfred",
  "version": "1.0.0",
  "personality": {
    "formality": "professional-but-warm",
    "verbosity": "concise",
    "humor": "dry",
    "proactivity": "high"
  },
  "capabilities": ["oral_operator", "voice_interaction", "mission_management", "report_generation"],
  "default_tts": "workers-ai",
  "default_stt": "workers-ai",
  "default_voice_model": "aura-2-en",
  "created_at": "2026-08-26T00:00:00Z",
  "updated_at": "2026-09-08T00:00:00Z"
}
```

## Memory Flow
```
User interacts with Alfred
    ├── Voice session starts
    │   └── Load session context from KV (hermes:session:{id})
    │   └── Load user profile from KV (hermes:profile:{userId})
    │   └── Semantic recall from Vectorize (alfred-memory)
    ├── During interaction
    │   └── ORAL operator processes input
    │   └── New memories stored to KV + Vectorize
    │   └── Mission state updated in D1 + DO
    └── Session ends
        └── Session context saved to KV
        └── Session record updated in D1
        └── Relevant memories indexed in Vectorize
```

## KV vs D1 vs Vectorize — When to Use What

| Store | Use Case | Example |
|-------|----------|--------|
| KV (hermes) | Fast key-value, profiles, session state | `profile:alfred`, `session:{id}` |
| D1 (alfred-db) | Structured relational data, queries, joins | Missions, events, voice sessions |
| Vectorize (alfred-memory) | Semantic search, recall by meaning | "What did Alfred say about X?" |
| R2 (alfred-data) | Binary blobs, audio files | Voice samples, audio recordings |
| DO storage | Per-entity consistent state | Mission state, WebSocket session state |