# COP Map — Common Operational Picture

Real-time operational dashboard for the Alfred system. Tracks token burn,
cost per mission, active agents, mission lifecycle, voice activity, AI Gateway
usage, and memory usage.

## Data Sources

| Metric | Source | Granularity |
|--------|--------|-------------|
| Token burn per agent/mission | Analytics Engine `alfred_cop` (tokens_in, tokens_out) | Per AI call |
| Cost per mission | Analytics Engine `cost_usd` (computed at write time) | Per AI call, rolled up per mission |
| Active agents + status | D1 `missions` + DO `MissionStateDO` state | Real-time |
| Voice session activity | D1 `voice_sessions` | Per session |
| AI Gateway usage | AI Gateway analytics (gateway_id dimension in COP) | Per request |
| Memory usage | KV `hermes` key counts + Vectorize `alfred-memory` count | Snapshot |

## Analytics Engine Dataset: alfred_cop

```typescript
export function recordCop(env: Env, data: {
  userId: string; missionId: string; agent: string;
  provider: string; model: string; eventType: string;
  tokensIn?: number; tokensOut?: number;
  costUsd?: number; durationMs?: number;
}): void {
  env.ALFRED_COP.writeDataPoint({
    blobs: [data.userId, data.missionId, data.agent, data.provider, data.model, data.eventType],
    doubles: [data.tokensIn ?? 0, data.tokensOut ?? 0, data.costUsd ?? 0, data.durationMs ?? 0],
    indexes: [data.missionId],
  });
}
```

Blob layout: blob1=user_id, blob2=mission_id, blob3=agent, blob4=provider,
blob5=model, blob6=event_type
double1=tokens_in, double2=tokens_out, double3=cost_usd, double4=duration_ms

## COP API Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/cop/overview` | Live stats: active missions, voice sessions, cost today |
| `GET /api/cop/missions` | Per-mission cost/token rollup |
| `GET /api/cop/agents` | Per-agent burn rate (tokens + cost, last 24h) |
| `GET /api/cop/voice` | Voice session activity |
| `GET /api/cop/gateway` | AI Gateway usage summary (per provider/model) |
| `GET /api/cop/memory` | Memory usage (KV keys, Vectorize count, D1 rows) |
| `GET /api/cop/burn-rate` | Token burn rate per agent/mission (tokens/min) |

## Cost Calculation

```typescript
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.15, out: 0.60 },
  "gpt-4o": { in: 2.50, out: 10.00 },
  "grok-3": { in: 3.00, out: 15.00 },
  "mimo-latest": { in: 1.00, out: 4.00 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICES[model] || { in: 0.15, out: 0.60 };
  return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}
```

## Budget Alerts (account level)
- Manage Account → Billing → Billable Usage → Budget alerts
- Set dollar thresholds; email when projected monthly spend hits threshold
- COP Map shows the same usage data at mission/agent granularity