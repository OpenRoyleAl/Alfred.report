import { test } from "node:test";
import assert from "node:assert/strict";
import { argsHash, checkCall, DEFAULT_LIMITS, guardTool, type ToolEvent, type GuardStore } from "./guards.ts";

const ev = (over: Partial<ToolEvent>): ToolEvent => ({
  mission_id: "m", tool: "t", args_hash: "a", ok: true, blocked: null, ms: 1, at: 0, ...over,
});

test("argsHash is stable across key order", () => {
  assert.equal(argsHash({ a: 1, b: [1, 2] }), argsHash({ b: [1, 2], a: 1 }));
  assert.notEqual(argsHash({ a: 1 }), argsHash({ a: 2 }));
});

test("repeat identical call is blocked", () => {
  assert.equal(checkCall([ev({}), ev({})], "a"), "repeat_call");
  assert.equal(checkCall([ev({})], "a"), null);
});

test("failure streak blocks further calls", () => {
  const prior = [ev({ ok: false, args_hash: "1" }), ev({ ok: false, args_hash: "2" }), ev({ ok: false, args_hash: "3" })];
  assert.match(checkCall(prior, "4") ?? "", /^failure_streak/);
});

test("max calls per tool", () => {
  const prior = Array.from({ length: DEFAULT_LIMITS.maxCallsPerTool }, (_, i) => ev({ args_hash: String(i) }));
  assert.match(checkCall(prior, "new") ?? "", /^max_calls/);
});

test("guardTool records events and returns an error result when blocked", async () => {
  const events: ToolEvent[] = [];
  const store: GuardStore = {
    missionId: () => "m1",
    record: (e) => events.push(e),
    events: (m, t) => events.filter((e) => e.mission_id === m && (!t || e.tool === t)),
  };
  let runs = 0;
  const tool = guardTool(
    { name: "echo", description: "", parameters: {} as never, async execute() { runs++; return { output: [{ type: "text", text: "ok" }] }; } } as never,
    store
  ) as unknown as { execute: (a: unknown, b: unknown, c: unknown) => Promise<{ isError?: boolean }> };
  await tool.execute({ q: 1 }, {}, {});
  await tool.execute({ q: 1 }, {}, {});
  const third = await tool.execute({ q: 1 }, {}, {});
  assert.equal(runs, 2);
  assert.equal(third.isError, true);
  assert.equal(events.filter((e) => e.blocked === "repeat_call").length, 1);
});

test("normalizeResult maps content -> output (agents tool packages)", async () => {
  const { normalizeResult } = await import("./guards.ts");
  assert.deepEqual(normalizeResult({ content: [{ type: "text", text: "x" }] }), { output: [{ type: "text", text: "x" }] });
  const keep = { output: [{ type: "text", text: "y" }] };
  assert.equal(normalizeResult(keep), keep);
});
