# AI Gateway — Alfred's Unified AI Router

## Overview

AI Gateway sits between Alfred's Workers and all AI providers. It provides
observability, caching, rate limiting, and unified billing. Workers AI is
used directly (no gateway needed). External providers (MiMo, OpenAI, xAI)
route through AI Gateway as custom providers.

Reference: [AI Gateway Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)

## Gateway Setup

### 1. Create AI Gateway
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/0870b0bdbc14bcd31f43fe5e82c3ee8e/ai-gateway/gateways" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "alfred-gateway", "name": "Alfred AI Gateway"}'
```

### 2. Register Custom Providers

#### MiMo (custom provider)
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/0870b0bdbc14bcd31f43fe5e82c3ee8e/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "MiMo", "slug": "mimo", "base_url": "https://api.mimo.example.com", "enable": true}'
```

#### OpenAI (native provider — no custom provider needed)
```
https://gateway.ai.cloudflare.com/v1/{account_id}/alfred-gateway/openai/
```

#### xAI (custom provider)
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/0870b0bdbc14bcd31f43fe5e82c3ee8e/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "xAI", "slug": "xai", "base_url": "https://api.x.ai", "enable": true}'
```

### 3. URL Routing

| Provider | Gateway Path | Upstream |
|----------|-------------|----------|
| MiMo | `/custom-mimo/v1/chat/completions` | `https://api.mimo.example.com/v1/chat/completions` |
| OpenAI | `/openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| xAI | `/custom-xai/v1/chat/completions` | `https://api.x.ai/v1/chat/completions` |

## AI Gateway Features Used

| Feature | Benefit for Alfred |
|---------|-------------------|
| Observability | Track all AI requests, latency, errors per provider |
| Caching | Cache repeated LLM responses |
| Rate limiting | Prevent abuse on voice endpoints |
| Unified billing | Single Cloudflare bill for all AI usage |
| Custom providers | MiMo and any future provider without code changes |
| BYOK | Store provider API keys securely in Cloudflare |

## BYOK (Bring Your Own Keys)
```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put MIMO_API_KEY
npx wrangler secret put XAI_API_KEY
```

## Provider Routing Matrix

```
Request type          │ Default provider  │ Alternative (user-selectable)
─────────────────────┼───────────────────┼──────────────────────────────
TTS (text-to-speech) │ Workers AI Aura-2 │ MiMo, OpenAI TTS
STT (speech-to-text) │ Workers AI Whisper│ Deepgram Nova-3, OpenAI Whisper
LLM (ORAL operator)  │ Workers AI Llama  │ OpenAI GPT-4o, xAI Grok, MiMo
Turn detection       │ Workers AI smart- │ (no alternative needed)
                     │turn-v2           │
Embeddings (memory)  │ Workers AI BGE-M3 │ OpenAI embeddings
```