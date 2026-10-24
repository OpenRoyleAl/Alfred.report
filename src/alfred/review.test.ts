import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLogIds, reviewMission, type GatewayLogSummary } from "./review.ts";
import type { ToolEvent } from "./review.ts";

const log = (over: Partial<GatewayLogSummary> = {}): GatewayLogSummary => ({
  id: "l", model: "@cf/zai-org/glm-5.2", success: true, status: 200, tokens_in: 100, tokens_out: 50, cost: 0, duration: 10, ...over,
});
const ev = (over: Partial<ToolEvent> = {}): ToolEvent => ({
  mission_id: "m", tool: "web_search", args_hash: "a", ok: true, blocked: null, ms: 5, at: 0, ...over,
});

test("clean run passes", () => {
  const r = reviewMission({ missionId: "m", status: "done", finalText: "done", events: [ev()], logs: [log()], missingLogs: 0, evidence: "x", requireEvidence: true });
  assert.equal(r.verdict, "pass");
  assert.equal(r.totals.tokens_in, 100);
});

test("loop guard block fails the run (no lesson)", () => {
  const r = reviewMission({ missionId: "m", status: "done", finalText: "done", events: [ev(), ev({ blocked: "repeat_call", ok: false })], logs: [log()], missingLogs: 0, evidence: null, requireEvidence: false });
  assert.equal(r.verdict, "fail");
  assert.ok(r.flags.some((f) => f.kind === "loop"));
});

test("wasted tokens over limit fails", () => {
  const r = reviewMission({ missionId: "m", status: "done", finalText: "ok", events: [], logs: [log({ success: false, status: 500, tokens_in: 900 }), log()], missingLogs: 0, evidence: null, requireEvidence: false });
  assert.ok(r.flags.some((f) => f.kind === "wasted_tokens"));
  assert.equal(r.verdict, "fail");
});

test("unanswered and missing evidence fail", () => {
  const r = reviewMission({ missionId: "m", status: "unanswered", finalText: "", events: [], logs: [], missingLogs: 0, evidence: null, requireEvidence: true });
  assert.deepEqual(r.flags.filter((f) => f.blocking).map((f) => f.kind).sort(), ["no_evidence", "unanswered"]);
});

test("collectLogIds finds nested cloudflare diagnostics", () => {
  const entries = [{ message: { diagnostics: [{ type: "cloudflare", details: { logId: "abc" } }] } }, { x: { logId: "def" } }, { logId: "abc" }];
  assert.deepEqual(collectLogIds(entries).sort(), ["abc", "def"]);
});

test("clef done gate: not done blocks, unavailable only warns, escalation never teaches", () => {
  const base = { missionId: "m", status: "done", finalText: "ok", events: [ev()], logs: [log()], missingLogs: 0, evidence: "x", requireEvidence: false };
  assert.equal(reviewMission({ ...base, clefDone: { done: false, pDone: 0.3, pEvidence: 0.2 } }).verdict, "fail");
  const u = reviewMission({ ...base, clefDone: "unavailable" });
  assert.equal(u.verdict, "pass");
  assert.ok(u.flags.some((f) => f.kind === "clef_unavailable"));
  assert.equal(reviewMission({ ...base, clefDone: { done: true, pDone: 0.9, pEvidence: 0.9 }, escalation: "risk 3" }).verdict, "fail");
});
