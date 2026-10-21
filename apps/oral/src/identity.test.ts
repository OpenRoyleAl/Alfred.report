import { test } from "node:test";
import assert from "node:assert/strict";
import { agentNameAllowed, identify, isOwnerTenant } from "./identity.ts";
import { tenantFromEmail } from "../../../src/lib/access.ts";

const env = { OWNER_EMAILS: "owner@acme.example.com", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };

test("no verified Access sign-in -> no identity", async () => {
  assert.equal(await identify(new Request("https://oral.acme.example.com/"), env), null);
});

test("owner is decided by the verified tenant, not by the request", () => {
  assert.equal(isOwnerTenant(env, tenantFromEmail("owner@acme.example.com")), true);
  assert.equal(isOwnerTenant(env, tenantFromEmail("owner@elsewhere.example.com")), false);
});

test("a socket may only open its own tenant's ORAL instance", () => {
  const id = { email: "x@y.z", tenant: tenantFromEmail("x@y.z"), isOwner: false };
  assert.equal(agentNameAllowed(id.tenant, id), true);
  assert.equal(agentNameAllowed(tenantFromEmail("owner@acme.example.com"), id), false);
});
