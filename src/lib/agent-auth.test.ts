import { test } from "node:test";
import assert from "node:assert/strict";
import { testD1 } from "./test-d1.ts";
import { decideClaim, lookupClaim, pollToken, registerAgent, CLAIM_GRANT, authMd, authorizationServerMetadata } from "./agent-auth.ts";
import { listAgentTokens, revokeAgentTokenValue, verifyAgentToken } from "./agent-tokens.ts";

const envOf = () => ({ DB: testD1(), DOMAIN: "alfred.report" }) as any;
const king = { tenant_id: "kingdom-a", email: "a@example.com" };

async function rows(env: any, sql: string) {
  return (await env.DB.prepare(sql).all()).results as Record<string, unknown>[];
}

test("register -> approve -> poll issues one scoped key; secrets stored hashed only", async () => {
  const env = envOf();
  const r = await registerAgent(env, { type: "service_auth", login_hint: "a@example.com", api_key_name: "Report bot", scope: "missions:read memory:read" }, "1.2.3.4");
  assert.equal(r.status, 201);
  const claim = r.body.claim as any;
  assert.match(claim.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(claim.verification_uri, "https://alfred.report/connect");
  assert.equal(claim.interval, 5);
  const ct = String(r.body.claim_token);
  const dump = JSON.stringify(await rows(env, "SELECT * FROM alfred_report_agent_claims"));
  assert.ok(!dump.includes(ct) && !dump.includes(claim.user_code) && !dump.includes(claim.user_code.replace("-", "")), "claim token and code are hashed");

  assert.equal((await pollToken(env, ct)).body.error, "authorization_pending");
  assert.equal((await pollToken(env, ct)).body.error, "slow_down");

  const d = await decideClaim(env, king, claim.user_code.toLowerCase(), true, ["memory:read", "memory:write"]);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.scopes, ["memory:read"], "only a subset of what was requested");
  assert.equal((await decideClaim(env, king, claim.user_code, true, ["memory:read"])).status, 404, "decided claims cannot be re-approved");

  await env.DB.prepare("UPDATE alfred_report_agent_claims SET last_poll_at = NULL").run();
  const t = await pollToken(env, ct);
  assert.equal(t.status, 200);
  const tok = String(t.body.access_token);
  assert.match(tok, /^art_/);
  assert.equal(t.body.scope, "memory:read");
  assert.equal((await pollToken(env, ct)).body.error, "invalid_grant", "one-time exchange");
  const v = await verifyAgentToken(env, tok);
  assert.equal(v?.tenant_id, "kingdom-a");
  assert.deepEqual(v?.scopes, ["memory:read"]);
  assert.ok(!JSON.stringify(await rows(env, "SELECT * FROM alfred_report_agent_tokens")).includes(tok), "key hashed");
  const notices = await rows(env, "SELECT text FROM alfred_report_owner_notices");
  assert.match(String(notices[0].text), /New agent connected: Report bot .* kingdom-a with memory:read/);
  assert.equal((await listAgentTokens(env, "kingdom-a")).length, 1);
  assert.equal(await revokeAgentTokenValue(env, tok), true);
  assert.equal(await verifyAgentToken(env, tok), null, "revoked key stops working");
});

test("deny, expiry, unknown claim", async () => {
  const env = envOf();
  const r = await registerAgent(env, { login_hint: "b@example.com" }, "5.5.5.5");
  assert.equal(r.body.scope, "missions:read report:read", "default scopes");
  await decideClaim(env, king, (r.body.claim as any).user_code, false, []);
  assert.equal((await pollToken(env, String(r.body.claim_token))).body.error, "access_denied");
  const e = await registerAgent(env, { login_hint: "b@example.com" }, "5.5.5.5");
  await env.DB.prepare("UPDATE alfred_report_agent_claims SET expires_at = 1 WHERE status = 'pending'").run();
  assert.equal((await pollToken(env, String(e.body.claim_token))).body.error, "expired_token");
  assert.equal((await lookupClaim(env, "x@example.com", (e.body.claim as any).user_code)).status, 404, "expired code cannot be approved");
  assert.equal((await pollToken(env, "clm_nope")).body.error, "invalid_grant");
});

test("registration validation and rate limits", async () => {
  const env = envOf();
  assert.equal((await registerAgent(env, { login_hint: "not-an-email" }, "9.9.9.9")).status, 400);
  assert.equal((await registerAgent(env, { login_hint: "c@example.com", scope: "admin" }, "9.9.9.9")).status, 400);
  assert.equal((await registerAgent(env, { type: "oauth", login_hint: "c@example.com" }, "9.9.9.9")).body.error, "unsupported_identity_type");
  for (let i = 0; i < 3; i++) assert.equal((await registerAgent(env, { login_hint: "c@example.com" }, `10.0.0.${i}`)).status, 201);
  assert.equal((await registerAgent(env, { login_hint: "c@example.com" }, "10.0.0.9")).status, 429, "per login_hint cap");
  for (let i = 0; i < 2; i++) assert.equal((await registerAgent(env, { login_hint: `d${i}@example.com` }, "10.0.0.1")).status, 201);
  assert.equal((await registerAgent(env, { login_hint: "e@example.com" }, "10.0.0.1")).status, 201);
  assert.equal((await registerAgent(env, { login_hint: "f@example.com" }, "10.0.0.1")).status, 201);
  assert.equal((await registerAgent(env, { login_hint: "g@example.com" }, "10.0.0.1")).status, 429, "per network cap");
});

test("code brute force is capped per approver", async () => {
  const env = envOf();
  const r = await registerAgent(env, { login_hint: "h@example.com" }, "7.7.7.7");
  for (let i = 0; i < 5; i++) assert.equal((await lookupClaim(env, "mallory@example.com", "BCDF-GHJK")).status, 404);
  assert.equal((await lookupClaim(env, "mallory@example.com", (r.body.claim as any).user_code)).status, 429, "locked out even with the right code");
  assert.equal((await lookupClaim(env, "a@example.com", (r.body.claim as any).user_code)).status, 200);
});

test("discovery docs point at the claim grant", () => {
  const m = authorizationServerMetadata("alfred.report");
  assert.equal(m.token_endpoint, "https://mcp.alfred.report/oauth2/token");
  assert.deepEqual(m.grant_types_supported, [CLAIM_GRANT]);
  const md = authMd("alfred.report", "Alfred");
  assert.ok(md.includes("/agent/identity") && md.includes("authorization_pending") && md.includes("/oauth2/revoke"));
});
