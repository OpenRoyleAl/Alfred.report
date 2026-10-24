import { test } from "node:test";
import assert from "node:assert/strict";
import { createParallelSearch, isThin, memoryBudget, wantsDeepSearch, type SearchRoute } from "./search.ts";

const res = (urls: string[], text = "cloudflare workers pricing") => ({
  items: urls.map((u) => ({ url: u, title: text, description: text })),
  metadata: { query: "q", requestId: "r", latencyMs: 1 },
});
const src = (r: ReturnType<typeof res>, calls: string[], name: string, fail = false) => ({
  async search() {
    calls.push(name);
    if (fail) throw new Error(`${name} down`);
    return r;
  },
});
const noWait = { take: async () => undefined } as never;
const req = { query: "cloudflare workers pricing", limit: 6 } as never;

test("deep intent detection and thinness still come from Rust", () => {
  assert.ok(wantsDeepSearch("who founded anthropic and what is its valuation"));
  assert.ok(!wantsDeepSearch("weather manila"));
  assert.ok(isThin("cloudflare workers pricing", res(["https://a.com"]) as never));
});

test("ceramic and exa run in parallel; results deduplicated and fused", async () => {
  const calls: string[] = [];
  let route: SearchRoute | undefined;
  const s = createParallelSearch({
    ceramic: src(res(["https://a.com/x", "https://b.com", "https://c.com"]), calls, "ceramic"),
    exaLite: src(res(["https://www.a.com/x/?utm_source=z", "https://d.com"]), calls, "exa-lite"),
    budget: memoryBudget(),
    owner: true,
    limiter: noWait,
    onRoute: (r) => (route = r),
  });
  const out = await s.search(req, {} as never);
  assert.deepEqual(calls.sort(), ["ceramic", "exa-lite"]);
  assert.equal(out.items.length, 4);
  assert.equal(out.items[0].url, "https://a.com/x");
  assert.deepEqual((out.items[0] as { providers?: string[] }).providers, ["ceramic", "exa-lite"]);
  assert.equal(route?.merged, 4);
});

test("one provider failing returns the other's results", async () => {
  for (const failing of ["ceramic", "exa-lite"]) {
    const calls: string[] = [];
    const s = createParallelSearch({
      ceramic: src(res(["https://a.com"]), calls, "ceramic", failing === "ceramic"),
      exaLite: src(res(["https://e.com"]), calls, "exa-lite", failing === "exa-lite"),
      budget: memoryBudget(),
      owner: true,
      limiter: noWait,
    });
    const out = await s.search(req, {} as never);
    assert.equal(out.items.length, 1, failing);
  }
  const both = createParallelSearch({ ceramic: src(res([]), [], "ceramic", true), exaLite: src(res([]), [], "exa-lite", true), budget: memoryBudget(), owner: true, limiter: noWait });
  await assert.rejects(both.search(req, {} as never), /web search failed/);
});

test("kingdom quota: other kingdoms fall back to ceramic only past the cap; owner unlimited", async () => {
  const budget = memoryBudget();
  const run = async (owner: boolean) => {
    const calls: string[] = [];
    let route: SearchRoute | undefined;
    await createParallelSearch({ ceramic: src(res(["https://a.com"]), calls, "ceramic"), exaLite: src(res(["https://e.com"]), calls, "exa-lite"), budget, owner, kingdomCap: 2, limiter: noWait, onRoute: (r) => (route = r) }).search(req, {} as never);
    return { calls: calls.sort(), route: route! };
  };
  assert.deepEqual((await run(false)).calls, ["ceramic", "exa-lite"]);
  assert.deepEqual((await run(false)).calls, ["ceramic", "exa-lite"]);
  const over = await run(false);
  assert.deepEqual(over.calls, ["ceramic"]);
  assert.match(over.route.exa.reason, /over daily exa cap/);
  assert.deepEqual((await run(true)).calls, ["ceramic", "exa-lite"]);
});

test("no exa key means ceramic only", async () => {
  const calls: string[] = [];
  await createParallelSearch({ ceramic: src(res(["https://a.com"]), calls, "ceramic"), budget: memoryBudget(), owner: true, limiter: noWait }).search(req, {} as never);
  assert.deepEqual(calls, ["ceramic"]);
});
