import { test } from "node:test";
import assert from "node:assert/strict";
import { agentNameAllowed, bearer, identify } from "./identity.ts";

const env = { OWNER_EMAILS: "owner@acme.example.com", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", DB: undefined as never };

test("no token -> no identity (human Access sign-in is not accepted)", async () => {
  assert.equal(await identify(new Request("https://oral.acme.example.com/"), env), null);
  const withAccess = new Request("https://oral.acme.example.com/", { headers: { "Cf-Access-Jwt-Assertion": "x", Cookie: "CF_Authorization=x" } });
  assert.equal(await identify(withAccess, env), null);
});

test("malformed bearer never reaches the token table", async () => {
  const r = new Request("https://oral.acme.example.com/", { headers: { Authorization: "Bearer nope" } });
  assert.equal(bearer(r), "nope");
  assert.equal(await identify(r, env), null);
});

test("a socket may only open its own tenant's ORAL instance", () => {
  assert.equal(agentNameAllowed("t1", { tenant: "t1" }), true);
  assert.equal(agentNameAllowed("owner", { tenant: "t1" }), false);
});
