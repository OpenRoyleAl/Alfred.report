import { test } from "node:test";
import assert from "node:assert/strict";
import { senderAuthenticated } from "./mail.ts";

test("sender auth requires aligned DMARC pass, not a foreign DKIM pass", () => {
  assert.equal(senderAuthenticated(new Headers({ "authentication-results": "mx.google.com; dmarc=pass" })), true);
  assert.equal(senderAuthenticated(new Headers({ "authentication-results": "mx; dkim=pass header.d=evil.example" })), false);
  assert.equal(senderAuthenticated(new Headers({ "authentication-results": "mx; dkim=pass; dmarc=fail" })), false);
  assert.equal(senderAuthenticated(new Headers()), false);
});
