import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDone, decideEscalate, decideRoute, doneQuestions, escalateQuestions, routeQuestions, validateClefInput } from "./clef.ts";

test("question sets are object maps that satisfy the published schema limits", () => {
  for (const questions of [routeQuestions(), escalateQuestions(), doneQuestions()]) {
    assert.ok(!Array.isArray(questions));
    assert.deepEqual(validateClefInput({ model: "clef", state: "x", questions }), []);
  }
  assert.ok(validateClefInput({ model: "clef", state: "x", questions: {} }).length > 0);
  assert.ok(validateClefInput({ model: "clef", state: "x", questions: { a: { type: "choice", instructions: "q", criteria: { only: "1" } } } }).length > 0);
  assert.ok(validateClefInput({ model: "clef", state: "x", questions: { a: { type: "score", instructions: "q", criteria: ["one"] } } }).length > 0);
});

test("route: confident choice is used; unsure or malformed falls back to mission", () => {
  const ok = decideRoute({ route: { type: "choice", choice: "chat", probabilities: { chat: 0.9 }, confidence: 0.9 }, needs_web: { type: "noul", noul: 0.1 } });
  assert.equal(ok.route, "chat");
  assert.equal(ok.fallback, false);
  assert.equal(decideRoute({ route: { type: "choice", choice: "chat", probabilities: {}, confidence: 0.3 } }).route, "mission");
  assert.equal(decideRoute({ route: { type: "choice", choice: "bogus", probabilities: {}, confidence: 0.99 } }).route, "mission");
  assert.equal(decideRoute({}).fallback, true);
});

test("escalate: fails closed and escalates on high p or high risk", () => {
  assert.equal(decideEscalate({}).escalate, true);
  assert.equal(decideEscalate({ escalate: { type: "noul", noul: 0.8 }, risk: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 } }).escalate, true);
  assert.equal(decideEscalate({ escalate: { type: "noul", noul: 0.1 }, risk: { type: "score", score: 2.4, legend: {}, probabilities: {}, confidence: 1 } }).escalate, true);
  assert.equal(decideEscalate({ escalate: { type: "noul", noul: 0.1 }, risk: { type: "score", score: 0.5, legend: {}, probabilities: {}, confidence: 1 } }).escalate, false);
});

test("done: needs both done and evidence", () => {
  assert.equal(decideDone({ done: { type: "noul", noul: 0.9 }, evidence_supports: { type: "noul", noul: 0.9 } }).done, true);
  assert.equal(decideDone({ done: { type: "noul", noul: 0.9 }, evidence_supports: { type: "noul", noul: 0.2 } }).done, false);
  assert.equal(decideDone({}).done, false);
});
