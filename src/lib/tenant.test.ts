import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetOwnerCache, isOwnerTenantId, ownerTenant, resolveTenant } from "./tenant.ts";
import { tenantFromEmail } from "./access.ts";

// Minimal D1 fake: kiss_users rows by email.
function db(rows: Record<string, string>) {
  return {
    prepare(_sql: string) {
      return {
        bind(...emails: string[]) {
          return { first: async () => { for (const e of emails) if (rows[e]) return { tenant_id: rows[e] }; return null; } };
        },
      };
    },
  } as unknown as D1Database;
}
const base = { OWNER_EMAILS: "owner@acme.example.com,owner@second.example.com", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
beforeEach(() => _resetOwnerCache());

test("every owner email lands on the existing owner tenant", async () => {
  const env = { ...base, DB: db({ "owner@acme.example.com": "owner" }) };
  assert.equal(await resolveTenant(env, "owner@acme.example.com"), "owner");
  assert.equal(await resolveTenant(env, "Owner@Second.Example.com"), "owner");
  assert.equal(await ownerTenant(env), "owner");
  assert.equal(await isOwnerTenantId(env, "owner"), true);
  assert.equal(await isOwnerTenantId(env, tenantFromEmail("owner@acme.example.com")), false);
});

test("existing users resolve to their registered tenant; unknown users get the encoded email", async () => {
  const env = { ...base, DB: db({ "owner@acme.example.com": "owner", "jo@x.com": "jo" }) };
  assert.equal(await resolveTenant(env, "jo@x.com"), "jo");
  assert.equal(await resolveTenant(env, "new@y.com"), tenantFromEmail("new@y.com"));
});

test("fresh instance (no rows) falls back to the encoded first owner email", async () => {
  const env = { ...base, DB: db({}) };
  assert.equal(await resolveTenant(env, "owner@second.example.com"), tenantFromEmail("owner@acme.example.com"));
});

test("Google sign-in landing: owner -> dashboard, existing -> home, only new unpaid -> signup", async () => {
  const { postLoginPath } = await import("./tenant.ts");
  assert.equal(postLoginPath({ owner: true, created: false, paid: false, cb: "/home", tenant: "owner" }), "/");
  assert.equal(postLoginPath({ owner: true, created: false, paid: false, cb: "/signup?handle=owner", tenant: "owner" }), "/");
  assert.equal(postLoginPath({ owner: false, created: false, paid: false, cb: "/home", tenant: "jo" }), "/home");
  assert.equal(postLoginPath({ owner: false, created: true, paid: false, cb: "/home", tenant: "new1" }), "/signup?handle=new1");
  assert.equal(postLoginPath({ owner: false, created: true, paid: true, cb: "/now", tenant: "new1" }), "/now");
});
