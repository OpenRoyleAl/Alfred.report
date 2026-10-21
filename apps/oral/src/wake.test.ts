import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUtterance, wakeKeyterms, wakePrefix, words } from "./wake.ts";

const D = "alfred.report";

test("the wake word is the instance brand, however Flux punctuates it", () => {
  for (const t of ["Alfred.report!", "Alfred, report!", "alfred dot report", "Hey Alfred report.", "Alfred report please", "ok alfred report, give me the status"]) {
    assert.deepEqual(parseUtterance(t, D), { kind: "wake" }, t);
  }
  assert.deepEqual(parseUtterance("acme report", "acme.report"), { kind: "wake" });
  assert.deepEqual(parseUtterance("Hans a Koch report", "hansakoch.report"), { kind: "wake" });
});

test("another instance's brand does not wake this one", () => {
  assert.equal(parseUtterance("acme report", D).kind, "chat");
  assert.equal(parseUtterance("report", D).kind, "chat");
  assert.equal(wakePrefix(words("alfred"), D), 0);
});

test("wake word before a request addresses it instead of waking", () => {
  assert.deepEqual(parseUtterance("Alfred report, what's on my calendar today?", D), { kind: "chat", text: "Alfred report, what's on my calendar today?" });
});

test("owner commands: propose, Go Max AI! confirm or direct start, cancel", () => {
  assert.deepEqual(parseUtterance("Alfred report, start a mission to renew the shop domain by Friday", D), {
    kind: "propose",
    objective: "renew the shop domain by friday",
  });
  assert.deepEqual(parseUtterance("New mission: check the uptime of the site", D), { kind: "propose", objective: "check the uptime of the site" });
  assert.deepEqual(parseUtterance("Go Max AI!", D), { kind: "go", objective: null });
  assert.deepEqual(parseUtterance("go max a.i.", D), { kind: "go", objective: null });
  assert.deepEqual(parseUtterance("Go Max AI, send the weekly summary to me", D), { kind: "go", objective: "send the weekly summary to me" });
  assert.deepEqual(parseUtterance("never mind", D), { kind: "cancel" });
});

test("keyterms boost the brand and flow terms", () => {
  const k = wakeKeyterms("acme.report");
  assert.ok(k.includes("acme report"));
  assert.ok(k.includes("Go Max AI"));
});
