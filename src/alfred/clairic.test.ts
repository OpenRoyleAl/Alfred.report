import { test } from "node:test";
import assert from "node:assert/strict";
import { MISSION_FIELDS, intakeState, summarizeExtraction, validateClairicInput } from "./clairic.ts";

const env = { AI: {} as Ai };

test("mission fields use only published Clairic types and pass validation", () => {
  const allowed = new Set(["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"]);
  for (const f of Object.values(MISSION_FIELDS)) assert.ok(allowed.has(f.type));
  assert.deepEqual(validateClairicInput({ model: "clairic", state: "hello", fields: MISSION_FIELDS }), []);
});

test("validation: empty state needs images; list needs items; estimate needs min/max", () => {
  assert.ok(validateClairicInput({ model: "clairic", state: "", fields: MISSION_FIELDS }).length > 0);
  assert.deepEqual(validateClairicInput({ model: "clairic", state: "", images: ["data:image/png;base64,AA"], fields: { a: { type: "text" } } }), []);
  assert.ok(validateClairicInput({ model: "clairic", state: "x", fields: { a: { type: "list" } } }).length > 0);
  assert.ok(validateClairicInput({ model: "clairic", state: "x", fields: { a: { type: "estimate" } } }).length > 0);
  assert.ok(validateClairicInput({ model: "clairic", state: "x", fields: { "9bad": { type: "text" } } }).length > 0);
});

test("intake state: email headers + body, voice transcript, image caption", async () => {
  assert.equal((await intakeState(env, { kind: "email", subject: "Quote", body: "£40 by Friday" })).state, "Subject: Quote\n£40 by Friday");
  assert.equal((await intakeState(env, { kind: "voice", transcript: " call Ana " })).state, "call Ana");
  const img = await intakeState(env, { kind: "image", images: [1, 2, 3, 4, 5].map(() => "data:image/png;base64,AA") });
  assert.equal(img.images?.length, 4);
});

test("uncertain answers are routed to review; nulls are not", () => {
  const x = summarizeExtraction({
    model: "clairic",
    truncated: false,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      amount: { type: "number", value: 40, confidence: 0.95, p_null: 0.02 },
      due_date: { type: "date", value: "2026-10-23", confidence: 0.4, p_null: 0.1 },
      client: { type: "text", value: null, p_null: 0.9 },
    },
  });
  assert.deepEqual(x.needsReview, ["due_date"]);
  assert.equal(x.fields.client.value, null);
});
