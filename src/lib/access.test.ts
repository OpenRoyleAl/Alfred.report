import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnerEmail, safeEqual, tenantFromEmail, verifyAccessEmail } from "./access.ts";

const forged = "e30." + btoa(JSON.stringify({ email: "owner@example.com" })) + ".sig";

test("fails closed without Access config, even with a forged cookie/header", async () => {
  const req = new Request("https://x/", {
    headers: { Cookie: `CF_Authorization=${forged}`, "Cf-Access-Authenticated-User-Email": "owner@example.com" },
  });
  assert.equal(await verifyAccessEmail(req, {}), null);
});

test("no token -> null", async () => {
  assert.equal(await verifyAccessEmail(new Request("https://x/"), { ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" }), null);
});

test("owner list and tenant derivation", () => {
  assert.equal(isOwnerEmail({ OWNER_EMAILS: "A@x.com, b@y.com" }, "a@x.com"), true);
  assert.equal(isOwnerEmail({ OWNER_EMAILS: "" }, "a@x.com"), false);
  assert.equal(tenantFromEmail("Jo.Bloggs+1@x.com"), "jo_2ebloggs_2b1_40x_2ecom");
  // injective: same local part on another domain, or punctuation dropped, is another tenant
  assert.notEqual(tenantFromEmail("jo@owner.example.com"), tenantFromEmail("jo@other.example.com"));
  assert.notEqual(tenantFromEmail("jo.bloggs@x.com"), tenantFromEmail("jobloggs@x.com"));
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
});

test("ACCESS_AUD list: still fails closed without a token", async () => {
  assert.equal(await verifyAccessEmail(new Request("https://x/"), { ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "a,b" }), null);
});
