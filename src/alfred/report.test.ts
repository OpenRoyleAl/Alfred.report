import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, outcomeOf, shortTitle, speakReport, STUCK_AFTER_MS, type MissionRow } from "./report.ts";
import type { ReviewResult } from "./review.ts";

const totals = { requests: 1, tokens_in: 1, tokens_out: 1, cost: 0, wasted_tokens: 0, tool_calls: 1, tool_failures: 0 };
const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({ missionId: "m", verdict: "pass", flags: [], totals, models: [], ...over });
const row = (over: Partial<MissionRow> = {}): MissionRow => ({
  id: "m1", objective: "Renew the domain for the shop.", status: "done", verdict: "pass",
  started_at: 1000, finished_at: 2000, review: review({ done: { done: true, pDone: 0.9, pEvidence: 0.9 } }), ...over,
});

test("no missions: says so and nothing needs attention", () => {
  const r = buildReport("acme.report!", [], 5000);
  assert.equal(r.synopsis, "No missions yet.");
  assert.equal(speakReport(r), "acme.report! The Report. No missions yet. Nothing needs your attention.");
});

test("success / fail / running per mission, with synopsis and attention", () => {
  const now = 10_000_000;
  const rows = [
    row({ id: "a", started_at: now - 3000 }),
    row({ id: "b", objective: "Send the invoice to the client", started_at: now - 2000, verdict: "fail",
      review: review({ verdict: "fail", flags: [{ kind: "escalated", blocking: true, detail: "x" }], done: { done: true, pDone: 0.9, pEvidence: 0.9 } }) }),
    row({ id: "c", objective: "Check the uptime", status: "running", verdict: null, finished_at: null, review: null, started_at: now - STUCK_AFTER_MS - 60_000 }),
  ];
  const r = buildReport("acme.report!", rows, now);
  assert.deepEqual(r.counts, { success: 1, fail: 1, running: 1 });
  assert.equal(r.synopsis, "3 recent missions: 1 succeeded, 1 failed, 1 running.");
  assert.deepEqual(r.items.map((i) => i.outcome), ["fail", "success", "running"]); // newest first
  assert.deepEqual(r.attention, ["Send the invoice to the client: needs your approval", "Check the uptime: still running after 31 minutes"]);
  const spoken = speakReport(r);
  assert.match(spoken, /^acme\.report! The Report\. 3 recent missions/);
  assert.match(spoken, /Success: Renew the domain for the shop, verified done\./);
  assert.match(spoken, /Fail: Send the invoice to the client\./);
});

test("mission-done gate feeds The Report: Clef 'not done' fails the mission", () => {
  const r = buildReport("x.report!", [row({ verdict: "fail", review: review({ verdict: "fail", flags: [{ kind: "clef_not_done", blocking: true, detail: "p" }], done: { done: false, pDone: 0.2, pEvidence: 0.1 } }) })]);
  assert.equal(r.items[0].outcome, "fail");
  assert.equal(r.items[0].clefDone, false);
  assert.deepEqual(r.attention, ["Renew the domain for the shop: not finished"]);
});

test("done-gate unavailable: success is reported without 'verified'", () => {
  const r = buildReport("x.report!", [row({ review: review({ done: "unavailable", flags: [{ kind: "clef_unavailable", blocking: false, detail: "" }] }) })]);
  assert.equal(r.items[0].clefDone, null);
  assert.match(speakReport(r), /Success: Renew the domain for the shop\./);
});

test("limit keeps it short and titles are trimmed", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ id: String(i), started_at: i }));
  assert.equal(buildReport("x!", rows).items.length, 5);
  assert.equal(shortTitle("Forwarded email: please book the venue for the twelve person team offsite next month"), "please book the venue for the twelve person...");
  assert.equal(outcomeOf(row({ status: "unanswered", verdict: "fail" })), "fail");
});
