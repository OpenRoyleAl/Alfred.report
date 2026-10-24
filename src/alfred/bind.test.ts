import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBindState } from "./bind.ts";

test("bind is sticky on tenant and never downgrades owner", () => {
  const first = nextBindState({ tenantId: null, isOwner: false }, "owner", true);
  assert.deepEqual(first, { tenantId: "owner", isOwner: true });
  const token = nextBindState(first, "owner", false);
  assert.deepEqual(token, { tenantId: "owner", isOwner: true });
  const upgrade = nextBindState({ tenantId: "owner", isOwner: false }, "owner", true);
  assert.deepEqual(upgrade, { tenantId: "owner", isOwner: true });
});

test("bind refuses a different tenant", () => {
  assert.throws(() => nextBindState({ tenantId: "a", isOwner: false }, "b", false), /tenant mismatch/);
});
