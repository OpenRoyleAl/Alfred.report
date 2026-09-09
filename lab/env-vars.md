> **LAB.** `command-os-review` is the Wrangler Worker **name**, not a public hostname.

# Recommended Environment Variables for command-os-review

## Non-secret variables (set in `wrangler.jsonc` `vars` block)

| Variable | Purpose | Example |
|----------|---------|---------|
| `ENVIRONMENT` | Runtime environment identifier | `production` / `preview` |
| `CF_ACCOUNT_ID` | Cloudflare account ID | `0870b0bdbc14bcd31f43fe5e82c3ee8e` |
| `AI_GATEWAY_ID` | AI Gateway identifier | `alfred-gateway` |
| `AI_GATEWAY_URL` | Full AI Gateway URL | `https://gateway.ai.cloudflare.com/v1/.../alfred-gateway` |
| `TTS_PROVIDER` | Default TTS provider | `workers-ai` |
| `STT_PROVIDER` | Default STT provider | `workers-ai` |
| `VOICE_MODEL` | Default voice model | `aura-2-en` |
| `ALFRED_PERSONALITY` | Alfred personality descriptor | `warm-british-male-authoritative-concise-dry-wit` |

## Secret variables (via Secrets Store)

These should **never** be committed to source.

| Secret | Purpose |
|--------|---------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o + TTS |
| `MIMO_API_KEY` | MiMo custom provider API key |
| `XAI_API_KEY` | xAI Grok API key |
| `CF_API_TOKEN` | Cloudflare API token for CI/R2 operations |

## How to set secrets
```bash
npx wrangler secrets-store secret put OPENAI_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put MIMO_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put XAI_API_KEY --store alfred-secrets --remote
npx wrangler secrets-store secret put CF_API_TOKEN --store alfred-secrets --remote
```

## Binding-based connection (recommended over env vars)

Service bindings let your Worker call another Worker directly without
going over the public internet:

```jsonc
{
  "services": [
    { "binding": "AGENT_ALFRED", "service": "agent-alfred" },
    { "binding": "ALFRED_REPORT", "service": "alfred-report" }
  ]
}
```

This is the most Cloudflare-native approach — no DNS, no TLS, no public URL
exposure, and requests stay within the Cloudflare network.