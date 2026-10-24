import { test } from "node:test";
import assert from "node:assert/strict";
import { testD1 } from "./test-d1.ts";
import {
  KISS_COOKIE,
  LEGACY_KISS_COOKIE,
  checkPassword,
  login,
  makePasswordHash,
  mintSession,
  readSessionEx,
  sessionKeys,
  sessionMigration,
  signup,
  verifySignup,
  LEGACY_SIGNER_UNTIL,
} from "./kiss.ts";
import { googleRedirectUri } from "./google-auth.ts";
import { OWNER_CACHE_MS, invalidateOwnerCache, ownerTenant } from "./tenant.ts";

const K1 = "k1-session-key-0123456789abcdef0123456789";
const K2 = "k2-session-key-0123456789abcdef0123456789";
const OPS = "ops-token-value-0123456789abcdef";
const env = (over: Record<string, unknown> = {}) =>
  ({ DB: testD1(), ALFRED_SESSION_KEY: K1, ALFRED_OPS_TOKEN: OPS, OWNER_EMAILS: "owner@example.com", ...over }) as never;
const req = (cookie: string) => new Request("https://alfred.test/home", { headers: { Cookie: cookie } });

test("password signup is pending until the emailed token is used; tenant claimed only then", async () => {
  const e = env();
  const r = await signup(e, "Ann@Example.org", "correct horse", "Ann", "annco");
  assert.ok("pending" in r);
  const { token, tenant_id } = (r as { pending: { token: string; tenant_id: string } }).pending;
  assert.equal(tenant_id, "annco");
  // Not claimed yet: no user, login fails, the name is still free.
  assert.equal("error" in (await login(e, "ann@example.org", "correct horse")), true);
  const { nameAvailable } = await import("./kiss.ts");
  assert.equal((await nameAvailable(e, "annco")).ok, true);
  assert.equal("error" in (await verifySignup(e, "0".repeat(64))), true);
  const v = await verifySignup(e, token);
  assert.ok("user" in v && v.user.tenant_id === "annco");
  assert.equal("user" in (await login(e, "ann@example.org", "correct horse")), true);
  // A token works once.
  assert.equal("error" in (await verifySignup(e, token)), true);
});

test("first verified signup wins a contested name", async () => {
  const e = env();
  const a = (await signup(e, "a@example.org", "password1", "", "shared")) as { pending: { token: string } };
  const b = (await signup(e, "b@example.org", "password2", "", "shared")) as { pending: { token: string } };
  assert.ok("user" in (await verifySignup(e, b.pending.token)));
  const late = await verifySignup(e, a.pending.token);
  assert.ok("error" in late && late.status === 409);
});

test("owner emails cannot password-signup", async () => {
  const r = await signup(env(), "owner@example.com", "password1");
  assert.ok("error" in r && r.status === 409);
});

test("session key is separate from the ops token; rotation and legacy grace keep users signed in", async () => {
  const user = { email: "u@example.org", name: "U", tenant_id: "u", billing_paid: 0 };
  const e1 = env();
  await (e1 as { DB: D1Database }).DB.prepare(
    "CREATE TABLE IF NOT EXISTS kiss_users (email TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'kiss', billing_paid INTEGER NOT NULL DEFAULT 0, byok_fp TEXT, created_at INTEGER NOT NULL)"
  ).run();
  await (e1 as { DB: D1Database }).DB.prepare("INSERT INTO kiss_users (email, name, tenant_id, pass_salt, pass_hash, created_at) VALUES ('u@example.org','U','u','s','h',1)").run();
  const t1 = await mintSession(e1, user);
  // Current cookie + primary key: valid, no reissue.
  assert.deepEqual((await readSessionEx(req(`${KISS_COOKIE}=${t1}`), e1))?.reissue, false);
  // Rotated to "K2,K1": old cookie still verifies and is re-issued under K2.
  const e2 = { ...(e1 as object), ALFRED_SESSION_KEY: `${K2},${K1}` } as never;
  const s = await readSessionEx(req(`${KISS_COOKIE}=${t1}`), e2);
  assert.equal(s?.user.email, "u@example.org");
  assert.equal(s?.reissue, true);
  // Without K1 the old token is dead.
  assert.equal(await readSessionEx(req(`${KISS_COOKIE}=${t1}`), { ...(e1 as object), ALFRED_SESSION_KEY: K2 } as never), null);
  // The ops token never signs.
  assert.equal((await sessionKeys(env({ ALFRED_SESSION_KEY: "" }))).sign, "");
  await assert.rejects(() => mintSession(env({ ALFRED_SESSION_KEY: "" }), user), /not configured/);
  // Legacy: unprefixed cookie signed with the ops token verifies during the grace window and migrates.
  const legacy = await mintSession({ ...(e1 as object), ALFRED_SESSION_KEY: OPS + "-padding-to-32-chars" } as never, user);
  void legacy;
  const opsSigned = await mintSession({ ...(e1 as object), ALFRED_SESSION_KEY: OPS } as never, user);
  const mig = await sessionMigration(req(`${LEGACY_KISS_COOKIE}=${opsSigned}`), e1);
  assert.ok(mig && mig[0].startsWith(`${KISS_COOKIE}=`) && mig[0].includes("Secure") && mig[0].includes("Path=/") && !/Domain=/i.test(mig[0]));
  assert.ok(mig[1].startsWith(`${LEGACY_KISS_COOKIE}=;`) && mig[1].includes("Max-Age=0"));
  assert.ok(Date.now() < LEGACY_SIGNER_UNTIL);
  assert.equal((await sessionKeys(e1, LEGACY_SIGNER_UNTIL + 1)).legacy.length, 0);
});

test("PBKDF2: new hashes use 100k iterations; legacy 10k hashes upgrade on login", async () => {
  const h = await makePasswordHash("pw-123456", "salt");
  assert.match(h, /^p2\$100000\$[0-9a-f]{64}$/);
  assert.deepEqual(await checkPassword("pw-123456", "salt", h), { ok: true, upgrade: false });
  assert.deepEqual(await checkPassword("wrong-pass", "salt", h), { ok: false, upgrade: false });
  const e = env();
  const r = (await signup(e, "old@example.org", "pw-123456")) as { pending: { token: string } };
  await verifySignup(e, r.pending.token);
  // Simulate a pre-upgrade row: bare 10k hex hash.
  const { webcrypto } = await import("node:crypto");
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode("pw-123456"), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("legacysalt"), iterations: 10_000 }, key, 256);
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const db = (e as { DB: D1Database }).DB;
  await db.prepare("UPDATE kiss_users SET pass_salt = ?, pass_hash = ? WHERE email = ?").bind("legacysalt", hex, "old@example.org").run();
  assert.ok("user" in (await login(e, "old@example.org", "pw-123456")));
  const row = await db.prepare("SELECT pass_salt, pass_hash FROM kiss_users WHERE email = ?").bind("old@example.org").first<{ pass_salt: string; pass_hash: string }>();
  assert.match(row!.pass_hash, /^p2\$100000\$/);
  assert.notEqual(row!.pass_salt, "legacysalt");
  assert.ok("user" in (await login(e, "old@example.org", "pw-123456")));
});

test("OAuth redirect_uri comes from DOMAIN config, never the request host", () => {
  assert.equal(googleRedirectUri({ DOMAIN: "alfred.report" }), "https://alfred.report/api/auth/google/callback");
  for (const bad of ["", "evil.com/x", "a b.com", "localhost", "x.com:8080"]) assert.equal(googleRedirectUri({ DOMAIN: bad }), "", bad);
});

test("owner tenant cache is short and invalidated on write", async () => {
  assert.ok(OWNER_CACHE_MS <= 60_000);
  const e = env();
  const db = (e as { DB: D1Database }).DB;
  invalidateOwnerCache();
  const before = await ownerTenant(e);
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS kiss_users (email TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'kiss', billing_paid INTEGER NOT NULL DEFAULT 0, byok_fp TEXT, created_at INTEGER NOT NULL)"
  ).run();
  await db.prepare("INSERT INTO kiss_users (email, name, tenant_id, pass_salt, pass_hash, created_at) VALUES ('owner@example.com','O','hans','google','g',1)").run();
  // The fallback answer was not cached, so the new row is seen at once.
  assert.notEqual(before, "hans");
  assert.equal(await ownerTenant(e), "hans");
});
