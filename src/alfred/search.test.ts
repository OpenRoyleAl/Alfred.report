import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedSearch, isThin, memoryBudget, wantsDeepSearch } from "./search.ts";

const res = (n: number, text = "cloudflare workers pricing") => ({
  items: Array.from({ length: n }, (_, i) => ({ url: `https://e.com/${i}`, title: text, description: text })),
  metadata: { query: "q", requestId: "r", latencyMs: 1 },
});
const src = (r: ReturnType<typeof res>, calls: string[], name: string) => ({
  async search() { calls.push(name); return r; },
});

test("deep intent detection", () => {
  assert.equal(wantsDeepSearch("weather in manila"), false);
  assert.equal(wantsDeepSearch("who founded anthropic and what is its valuation"), true);
  assert.equal(wantsDeepSearch('find "exact phrase here"'), true);
});

test("thin results", () => {
  assert.equal(isThin("cloudflare workers pricing", res(5)), false);
  assert.equal(isThin("cloudflare workers pricing", res(1)), true);
  assert.equal(isThin("tokio runtime scheduler", res(5)), true);
});

test("default stays on ceramic", async () => {
  const calls: string[] = [];
  const s = createRoutedSearch({ ceramic: src(res(5), calls, "ceramic"), exa: src(res(5), calls, "exa"), budget: memoryBudget(), exaDailyLimit: 10 });
  await s.search({ query: "cloudflare workers pricing" });
  assert.deepEqual(calls, ["ceramic"]);
});

test("deep goes to exa, thin escalates, budget caps", async () => {
  const calls: string[] = [];
  const budget = memoryBudget();
  const s = createRoutedSearch({ ceramic: src(res(1), calls, "ceramic"), exa: src(res(5), calls, "exa"), budget, exaDailyLimit: 2 });
  await s.search({ query: "competitors of cloudflare workers research" });
  await s.search({ query: "cloudflare workers pricing" });
  await s.search({ query: "cloudflare workers pricing" });
  assert.deepEqual(calls, ["exa", "ceramic", "exa", "ceramic"]);
  assert.equal(budget.used(), 2);
});

test("no exa key means ceramic only", async () => {
  const calls: string[] = [];
  const s = createRoutedSearch({ ceramic: src(res(1), calls, "ceramic"), budget: memoryBudget(), exaDailyLimit: 10 });
  await s.search({ query: "deep research on rust async" });
  assert.deepEqual(calls, ["ceramic"]);
});

test("escalation ladder: ceramic -> exa lite -> exa auto", async () => {
  const calls: string[] = [];
  const s = createRoutedSearch({
    ceramic: src(res(1), calls, "ceramic"),
    exaLite: src(res(5), calls, "exa-lite"),
    exa: src(res(5), calls, "exa"),
    budget: memoryBudget(),
    exaDailyLimit: 10,
    limiter: { async take() {} },
  });
  await s.search({ query: "cloudflare workers pricing" });
  assert.deepEqual(calls, ["ceramic", "exa-lite"]);
});

test("thin lite escalates to exa auto; failed lite falls through", async () => {
  const calls: string[] = [];
  const s = createRoutedSearch({
    ceramic: src(res(1), calls, "ceramic"),
    exaLite: src(res(2), calls, "exa-lite"),
    exa: src(res(5), calls, "exa"),
    budget: memoryBudget(),
    exaDailyLimit: 10,
    limiter: { async take() {} },
  });
  const r = await s.search({ query: "cloudflare workers pricing" });
  assert.deepEqual(calls, ["ceramic", "exa-lite", "exa"]);
  assert.equal(r.items.length, 5);
  const calls2: string[] = [];
  const s2 = createRoutedSearch({
    ceramic: src(res(1), calls2, "ceramic"),
    exaLite: { async search() { calls2.push("exa-lite"); throw new Error("400"); } },
    exa: src(res(5), calls2, "exa"),
    budget: memoryBudget(),
    exaDailyLimit: 10,
    limiter: { async take() {} },
  });
  await s2.search({ query: "cloudflare workers pricing" });
  assert.deepEqual(calls2, ["ceramic", "exa-lite", "exa"]);
});

test("deep intent skips lite and goes to exa auto", async () => {
  const calls: string[] = [];
  const s = createRoutedSearch({
    ceramic: src(res(5), calls, "ceramic"),
    exaLite: src(res(5), calls, "exa-lite"),
    exa: src(res(5), calls, "exa"),
    budget: memoryBudget(),
    exaDailyLimit: 10,
    limiter: { async take() {} },
  });
  await s.search({ query: "research the competitors of cloudflare" });
  assert.deepEqual(calls, ["exa"]);
});
