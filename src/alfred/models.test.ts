import { test } from "node:test";
import assert from "node:assert/strict";
import { rustLimiter, floorModels, DEEPSEEK_FLASH, runPrimary, primaryModel } from "./models.ts";
import { limiterConfig } from "./core.ts";
// Each test gets a fresh Rust limiter slot (ids 2+ are free for tests).
let slot = 2;
const fresh = (rpm: number) => { const id = slot++; limiterConfig(id, rpm, 60_000); return rustLimiter(id); };

test("limiter allows 20/min then blocks; window slides", () => {
  const l = fresh(20);
  for (let i = 0; i < 20; i++) assert.equal(l.take(1000), true);
  assert.equal(l.take(1000), false);
  assert.equal(l.take(61_001), true);
});

test("floor drops DeepSeek while limited", () => {
  const l = fresh(1);
  assert.equal(floorModels({} as never, l)[0], DEEPSEEK_FLASH);
  l.take();
  assert.ok(!floorModels({} as never, l).includes(DEEPSEEK_FLASH));
});

test("primary defaults to DeepSeek; 429 opens cooldown and falls through", async () => {
  assert.equal(primaryModel({} as never), DEEPSEEK_FLASH);
  assert.equal(primaryModel({ MISSIONS_MODEL: "auto" } as never), null);
  const l = fresh(20);
  const env = { CLOUDFLARE_GATEWAY_ID: "gw", AI: { run: async () => { throw new Error("429 Too Many Requests"); } } } as never;
  assert.equal(await runPrimary(env, DEEPSEEK_FLASH, "s", "u", {}, l), null);
  assert.equal(l.available(), false);
  const ok = { CLOUDFLARE_GATEWAY_ID: "gw", AI: { run: async () => ({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 3 } }) } } as never;
  const r = await runPrimary(ok, DEEPSEEK_FLASH, "s", "u", {}, fresh(20));
  assert.equal(r?.text, "hi");
});
