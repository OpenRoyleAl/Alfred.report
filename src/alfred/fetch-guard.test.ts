import { test } from "node:test";
import assert from "node:assert/strict";
import { durableFetchCheck, navSafeNext } from "./core.ts";

test("durable fetch rejects SSRF hosts (userinfo, IPv6, numeric, localhost)", () => {
  const bad = [
    "http://localhost/x",
    "https://10.0.0.1/",
    "http://127.0.0.1/",
    "http://[::1]/secret",
    "https://evil@127.0.0.1/",
    "http://2130706433/",
    "http://foo.localhost/",
    "http://metadata.google.internal/",
  ];
  for (const url of bad) {
    assert.throws(() => durableFetchCheck(url), /host not allowed|url must be/, url);
  }
  assert.equal(durableFetchCheck("https://example.com/a"), "https://example.com/a");
});

test("navSafeNext rejects protocol-relative and off-site returns", () => {
  assert.equal(navSafeNext("/now"), "/now");
  assert.equal(navSafeNext("//evil.com"), "/home");
  assert.equal(navSafeNext("https://evil.com"), "/home");
  assert.equal(navSafeNext("/\\evil.com"), "/home");
});
