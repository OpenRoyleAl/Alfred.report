# Voice Architecture — Alfred (v2)

## Overview

Provider-agnostic voice layer. Workers AI is the default (free, no API keys);
MiMo/OpenAI/xAI via AI Gateway. Uses Agents SDK Voice (`@cloudflare/voice`)
for the built-in voice channel.

## Alfred Personality (Voice)

- **Warm British male** — approachable, professional
- **Authoritative** — confident, decisive
- **Concise** — short spoken responses
- **Dry wit** — subtle humor

System prompt:
```
You are Alfred, a warm British male ORAL operator. Authoritative yet approachable.
You speak concisely with dry wit. You are highly proactive. Respond as if speaking aloud.
```

## Voice Models (Workers AI)

| Model | Type | Notes |
|-------|------|-------|
| `@cf/deepgram/aura-1` | TTS | Context-aware, customizable voice |
| `@cf/deepgram/aura-2-en` | TTS | Aura-2 English, improved expressiveness |
| `@cf/deepgram/aura-2-es` | TTS | Aura-2 Spanish |
| `@cf/myshell-ai/melotts` | TTS | Multi-language MP3 |
| `@cf/openai/whisper-large-v3-turbo` | STT | Fast, accurate |
| `@cf/deepgram/nova-3` | STT | Multilingual, fast |
| `@cf/deepgram/flux` | STT | Agents SDK voice default |
| `@cf/pipecat-ai/smart-turn-v2` | Turn detection | Detects end of speech |

## Agents SDK Voice (built-in channel)

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

Reference: https://developers.cloudflare.com/agents/communication-channels/voice/

## Endpoints

### voice.alfred.report — WebSocket real-time
```
wss://voice.alfred.report/ws/:sessionId
```
Flow: WebSocket → VoiceSessionDO (hibernation) → STT (Whisper/Flux) →
ORAL operator → TTS (Aura-2) → audio back to client.

### speak.alfred.report — HTTP TTS
```
POST https://speak.alfred.report/api/tts
{ "text": "...", "voice": "aura-2-en", "provider": "workers-ai" }
```

### speak.alfred.report — HTTP STT
```
POST https://speak.alfred.report/api/stt
multipart: audio file
```

## Provider Factory

```typescript
export function createTTSProvider(env: Env, provider?: string): TTSProvider {
  switch (provider || env.TTS_PROVIDER) {
    case "workers-ai": return new WorkersAITTS(env.AI);
    case "mimo": return new GatewayTTS(env.AI_GATEWAY_URL, "mimo", env.MIMO_API_KEY);
    case "openai": return new OpenAITTS(env.AI_GATEWAY_URL, env.OPENAI_API_KEY);
    case "xai": return new GatewayTTS(env.AI_GATEWAY_URL, "xai", env.XAI_API_KEY);
    default: return new WorkersAITTS(env.AI);
  }
}
```

## Custom Voice Samples (Phase 2)

Upload → R2 (`voice-samples/{userId}/{sampleId}-{name}`) → D1
(`voice_samples` table) → linked to `user_preferences.voice_sample_key`.

## COP Telemetry on Voice

Every STT/TTS call writes to Analytics Engine `alfred_cop`:
- blobs: user_id, mission_id, agent="voice", provider, model, event_type
- doubles: tokens_in, tokens_out, cost_usd, duration_ms

## Phased Rollout

| Phase | TTS | STT | Turn Detection | Custom Voice |
|-------|-----|-----|----------------|--------------|
| 1 | Workers AI Aura-1 | Workers AI Whisper | smart-turn-v2 | No |
| 2 | Aura-2 + MeloTTS | Nova-3 + Flux | smart-turn-v2 | Yes (R2) |
| 3 | User-selected (any via Gateway) | User-selected | smart-turn-v2 | Yes + cloning |