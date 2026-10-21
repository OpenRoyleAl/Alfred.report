import { test } from "node:test";
import assert from "node:assert/strict";
import { clefExtension, clefGates } from "./clef.ts";
import { clairicExtension } from "./clairic.ts";
import { extractMission } from "../clairic.ts";
import { validateClefInput, CLEF_OMNI_MODEL_ID, CLEF_MODEL_ID, routeQuestions } from "../clef.ts";

type Call = { model: string; body: any; opts: any };
function fakeAI(reply: (c: Call) => unknown) {
  const calls: Call[] = [];
  const AI = {
    run: async (model: string, body: unknown, opts: unknown) => {
      const c = { model, body, opts };
      calls.push(c);
      return reply(c);
    },
  } as unknown as Ai;
  return { env: { AI, CLOUDFLARE_GATEWAY_ID: "gw" }, calls };
}
const failing = () => fakeAI(() => {
  throw new Error("down");
});
const exec = (t: any, p: unknown) => t.execute(p, {} as never);

test("route gate: published Clef shape through the gateway; audio switches to clef-omni", async () => {
  const { env, calls } = fakeAI(() => ({ answers: { route: { type: "choice", choice: "chat", probabilities: {}, confidence: 0.9 }, needs_web: { type: "noul", noul: 0.1 } } }));
  const g = clefGates(env);
  assert.deepEqual(await g.route("hi"), { route: "chat", confidence: 0.9, needsWeb: false, fallback: false });
  assert.equal(calls[0].model, CLEF_MODEL_ID);
  assert.equal(calls[0].body.model, "clef");
  assert.equal(typeof calls[0].body.questions, "object");
  assert.deepEqual(calls[0].opts, { gateway: { id: "gw" } });
  await g.route("hi", ["data:audio/wav;base64,AAAA"]);
  assert.equal(calls[1].model, CLEF_OMNI_MODEL_ID);
  assert.equal(calls[1].body.model, "clef-omni");
  assert.deepEqual(calls[1].body.audio, ["data:audio/wav;base64,AAAA"]);
});

test("gate failure policy: route -> mission, escalate fails closed, done -> unavailable", async () => {
  const g = clefGates(failing().env);
  assert.equal((await g.route("x")).route, "mission");
  assert.equal((await g.escalate("delete the zone")).escalate, true);
  assert.equal(await g.done("o", "r", null), null);
});

test("audio/video only on clef-omni, as data URLs (schema limits)", () => {
  const q = routeQuestions();
  assert.deepEqual(validateClefInput({ model: "clef", state: "s", questions: q, audio: ["data:audio/wav;base64,A"] }), ["audio/videos need clef-omni"]);
  assert.deepEqual(validateClefInput({ model: "clef-omni", state: "s", questions: q, audio: ["https://x/a.mp3"] }), ["audio: data:audio/... URL or audio/* content_type (no remote URLs)"]);
  assert.deepEqual(validateClefInput({ model: "clef-omni", state: "s", questions: q, videos: ["a", "b", "c"] }), ["videos: max 2"]);
});

test("clef extension: named extension with escalate + done tools; escalation reaches the mission", async () => {
  const { env } = fakeAI((c) =>
    c.body.questions.escalate
      ? { answers: { escalate: { type: "noul", noul: 0.9 }, risk: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 1 } } }
      : { answers: { done: { type: "noul", noul: 0.95 }, evidence_supports: { type: "noul", noul: 0.9 } } }
  );
  const seen: string[] = [];
  const ext = clefExtension(env, { onEscalate: (a, r) => seen.push(`${a}|${r}`) });
  assert.equal(ext.name, "clef");
  assert.deepEqual(ext.tools!.map((t) => t.name), ["clef_escalate_check", "clef_done_check"]);
  const e = await exec(ext.tools![0], { action: "pay the invoice" });
  assert.equal(JSON.parse(e.output[0].text).escalate, true);
  assert.deepEqual(seen, ["pay the invoice|escalate p=0.90"]);
  const d = await exec(ext.tools![1], { objective: "renew", result: "renewed", evidence: "order 1" });
  assert.equal(JSON.parse(d.output[0].text).done, true);
});

test("clairic extension: email / voice / image map to the published Clairic request", async () => {
  const { env, calls } = fakeAI(() => ({ answers: { objective: { type: "text", value: "Book venue", confidence: 0.9, p_null: 0.01 } }, truncated: false }));
  const ext = clairicExtension(env);
  assert.equal(ext.name, "clairic");
  const t = ext.tools![0];
  await exec(t, { source: "email", subject: "Venue", text: "Please book the venue" });
  await exec(t, { source: "voice", text: "book the venue for friday" });
  await exec(t, { source: "image", text: "whiteboard", image_base64: "AAAA", content_type: "image/png" });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.model, "@cf/cloudflare/clairic");
    assert.equal(c.body.model, "clairic");
    assert.equal(typeof c.body.fields, "object");
    assert.match(c.body.reference_date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(calls[0].body.state, "Subject: Venue\nPlease book the venue");
  assert.equal(calls[1].body.state, "book the venue for friday");
  assert.deepEqual(calls[2].body.images, [{ content_type: "image/png", base64: "AAAA" }]);
  const r = await extractMission(env, { kind: "voice", transcript: "x y z" });
  assert.equal(r.fields.objective.value, "Book venue");
});
