import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTurn, NOTHING_PENDING, SANDBOX_MISSION } from "./turn.ts";
import { parseUtterance } from "./wake.ts";

const D = "acme.report";
const turn = (t: string, owner: boolean, pending?: string) => decideTurn(parseUtterance(t, D), owner, pending);

test("WAKE gives The Report to owner and sandbox alike (each sees their own tenant)", () => {
  assert.deepEqual(turn("Acme, report!", true), { do: "report" });
  assert.deepEqual(turn("acme dot report", false), { do: "report" });
});

test("owner: draft -> Go Max AI! starts the drafted mission", () => {
  assert.deepEqual(turn("start a mission to renew the domain", true), { do: "draft", objective: "renew the domain" });
  assert.deepEqual(turn("Go Max AI!", true, "renew the domain"), { do: "start", objective: "renew the domain" });
  assert.deepEqual(turn("Go Max AI!", true), { do: "say", text: NOTHING_PENDING });
  assert.deepEqual(turn("go max ai check the backups", true), { do: "start", objective: "check the backups" });
  assert.deepEqual(turn("cancel", true, "renew the domain"), { do: "cancel" });
});

test("sandbox users cannot start missions by voice; their chat is metered", () => {
  assert.deepEqual(turn("start a mission to renew the domain", false), { do: "say", text: SANDBOX_MISSION });
  assert.deepEqual(turn("Go Max AI, delete everything", false), { do: "say", text: SANDBOX_MISSION });
  assert.deepEqual(turn("Go Max AI!", false, "x"), { do: "say", text: SANDBOX_MISSION });
  assert.deepEqual(turn("what can you do?", false), { do: "chat", metered: true });
  assert.deepEqual(turn("what can you do?", true), { do: "chat", metered: false });
});
