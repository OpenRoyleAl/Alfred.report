import { test } from "node:test";
import assert from "node:assert/strict";
import { signOAuthState, verifyOAuthState } from "./oauth-state.ts";

const env = { JWT_SECRET: "unit-test-jwt-secret" };

test("oauth state rejects a missing or hardcoded-empty secret", async () => {
  assert.equal(await verifyOAuthState({}, "a.b"), null);
});

test("oauth state expires and is not an open redirect", async () => {
  const fresh = await signOAuthState(env, { cb: "/now", t: Date.now(), n: "n1" });
  const ok = await verifyOAuthState(env, fresh);
  assert.equal(ok?.cb, "/now");
  const stale = await signOAuthState(env, { cb: "//evil.com", t: Date.now() - 16 * 60 * 1000, n: "n2" });
  assert.equal(await verifyOAuthState(env, stale), null);
});
