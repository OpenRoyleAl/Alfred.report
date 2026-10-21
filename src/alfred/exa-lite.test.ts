import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITER, limiterConfig } from "./core.ts";
import { createExaLiteSearch, createRateLimiter, exaLiteUrl } from "./exa-lite.ts";

test("exa lite goes through the gateway custom provider with the BYOK alias, no key", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({ requestId: "x1", results: [{ url: "https://a.com", title: "A", highlights: ["hi"] }] });
  }) as unknown as typeof fetch;
  const s = createExaLiteSearch({ accountId: "acct", gateway: "gw", slug: "exa", alias: "default", gatewayToken: "tok", fetcher, limiter: { async take() {} } });
  const r = await s.search({ query: "q", limit: 3 });
  assert.equal(seen!.url, "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-exa/search");
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h["cf-aig-byok-alias"], "default");
  assert.equal(h["cf-aig-authorization"], "Bearer tok");
  assert.equal(h["x-api-key"], undefined);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { query: "q", type: "lite", numResults: 3 });
  assert.deepEqual(r.items, [{ url: "https://a.com", title: "A", description: "hi" }]);
  assert.equal(r.metadata.requestId, "x1");
  assert.equal(exaLiteUrl({ accountId: "a", gateway: "g", slug: "s" }), "https://gateway.ai.cloudflare.com/v1/a/g/custom-s/search");
});

test("non-2xx throws so the router can escalate", async () => {
  const fetcher = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
  const s = createExaLiteSearch({ accountId: "a", gateway: "g", slug: "exa", alias: "default", fetcher, limiter: { async take() {} } });
  await assert.rejects(s.search({ query: "q" }), /exa-lite 400/);
});

test("rate limiter allows 10 per second then waits", async () => {
  let t = 0;
  const waits: number[] = [];
  limiterConfig(LIMITER.exa, 10, 1000);
  const lim = createRateLimiter(() => t, async (ms) => { waits.push(ms); t += ms; });
  for (let i = 0; i < 10; i++) await lim.take();
  assert.equal(waits.length, 0);
  await lim.take();
  assert.deepEqual(waits, [1000]);
});
