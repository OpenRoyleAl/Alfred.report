/**
 * Offline eval suite for Alfred.report (mission quality + security regressions).
 * Loads fixtures under evals/fixtures/ and scores them against the Rust/TS core
 * with no live bindings. Exit 1 if any case fails.
 *
 *   npm run eval
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableBoardId, durableCreate, durableFetchCheck, durablePlan, mcpAllow, mcpParseScopes, navAppRedirect, navSafeNext, reviewCore, reportSpeak, reportBuild, untrustedWrap } from "../src/alfred/core.ts";
import { googleRedirectUri } from "../src/lib/google-auth.ts";
import { checkPassword, makePasswordHash } from "../src/lib/kiss.ts";
import { nextBindState } from "../src/alfred/bind.ts";
import { senderAuthenticated } from "../src/lib/mail-auth.ts";
import { durableOp } from "../src/alfred/core.ts";
import { fetchPublicPage } from "../apps/missions/src/durable.ts";

type Fixture = {
  id: string;
  suite: "mission-quality" | "security";
  check: string;
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
};

const root = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(root, "fixtures");

function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const suite of ["mission-quality", "security"]) {
    const dir = join(fixturesDir, suite);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Fixture | Fixture[];
      for (const f of Array.isArray(raw) ? raw : [raw]) out.push({ ...f, suite: suite as Fixture["suite"] });
    }
  }
  return out;
}

async function runCheck(f: Fixture): Promise<void> {
  const { check, input, expect } = f;
  switch (check) {
    case "fetch_url": {
      let ok = true;
      let err = "";
      try {
        durableFetchCheck(String(input.url));
      } catch (e) {
        ok = false;
        err = (e as Error).message;
      }
      if (Boolean(expect.ok) !== ok) throw new Error(`ok=${ok} err=${err}`);
      return;
    }
    case "nav_safe": {
      const next = navSafeNext(input.next as string | null);
      if (next !== expect.next) throw new Error(`got ${next}`);
      return;
    }
    case "mcp_allow": {
      let ok = true;
      let err = "";
      try {
        mcpAllow(String(input.name), (input.scopes as string[]) ?? [], Boolean(input.isOwner));
      } catch (e) {
        ok = false;
        err = (e as Error).message;
      }
      if (Boolean(expect.ok) !== ok) throw new Error(`ok=${ok} err=${err}`);
      if (expect.error && !err.includes(String(expect.error))) throw new Error(`error ${err}`);
      return;
    }
    case "parse_scopes": {
      let threw = false;
      try {
        mcpParseScopes(input.scopes);
      } catch {
        threw = true;
      }
      if (Boolean(expect.throws) !== threw) throw new Error(`throws=${threw}`);
      return;
    }
    case "review": {
      const r = reviewCore<Record<string, unknown>>(input);
      if (expect.verdict && r.verdict !== expect.verdict) throw new Error(`verdict ${r.verdict}`);
      if (expect.lessonOk !== undefined && r.lessonOk !== expect.lessonOk) throw new Error(`lessonOk ${r.lessonOk}`);
      if (expect.flag && !JSON.stringify(r.flags).includes(String(expect.flag))) throw new Error(`missing flag`);
      return;
    }
    case "durable_plan": {
      const r = durablePlan(input as never);
      if (expect.action && r.action !== expect.action) throw new Error(`action ${r.action}`);
      if (Array.isArray(expect.uncited)) {
        const got = (r as { uncited?: string[] }).uncited ?? [];
        if (got.length !== expect.uncited.length) throw new Error(`uncited ${JSON.stringify(got)}`);
      }
      if (expect.answerContains && !String((r as { answer?: string }).answer || "").includes(String(expect.answerContains))) {
        throw new Error("answer mismatch");
      }
      return;
    }
    case "report_speak": {
      const report = reportBuild(input.report ?? input) as { items: unknown[]; synopsis: string };
      const spoken = reportSpeak(report);
      const words = spoken.trim().split(/\s+/).length;
      if (typeof expect.maxWords === "number" && words > expect.maxWords) throw new Error(`too long: ${words} words`);
      if (expect.contains && !spoken.includes(String(expect.contains))) throw new Error(`missing ${expect.contains}`);
      if (expect.omits && spoken.includes(String(expect.omits))) throw new Error(`contained ${expect.omits}`);
      return;
    }
    case "sender_auth": {
      const ok = senderAuthenticated(new Headers({ "authentication-results": String(input.authenticationResults || "") }));
      if (Boolean(expect.ok) !== ok) throw new Error(`ok=${ok}`);
      return;
    }
    case "bind": {
      const got = nextBindState(input.current as never, String(input.tenantId), Boolean(input.isOwner));
      if (JSON.stringify(got) !== JSON.stringify(expect.state)) throw new Error(`got ${JSON.stringify(got)}`);
      return;
    }
    case "bind_throws": {
      let threw = false;
      try {
        nextBindState(input.current as never, String(input.tenantId), Boolean(input.isOwner));
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected throw");
      return;
    }
    case "untrusted_wrap": {
      const w = untrustedWrap(String(input.url || "https://x.test/"), 200, String(input.text));
      const want = (expect.flags as string[] | undefined) ?? [];
      for (const fl of want) if (!w.flags.includes(fl)) throw new Error(`missing flag ${fl}: ${w.flags.join(",")}`);
      if (expect.clean === true && w.flags.length) throw new Error(`false positive: ${w.flags.join(",")}`);
      if (w.text.split("<<<END_UNTRUSTED_WEB_CONTENT>>>").length !== 2) throw new Error("fence closed early");
      return;
    }
    case "keyed_ids": {
      const k = "eval-receipt-key-0123456789abcdef0123456";
      const a = durableCreate({ tenant: "t", request_id: "req-12345678", objective: "x y z", now: 1, mac_key: k }).mission_id;
      const b = durableCreate({ tenant: "t", request_id: "req-12345678", objective: "x y z", now: 1, mac_key: k + "x" }).mission_id;
      if (a === b) throw new Error("mission id not keyed");
      if (durableBoardId("board-abcdef12", k) === durableBoardId("board-abcdef12", k + "x")) throw new Error("board id not keyed");
      let threw = false;
      try {
        durableCreate({ tenant: "t", request_id: "req-12345678", objective: "x y z", now: 1, mac_key: "" });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("no key did not fail closed");
      return;
    }
    case "oauth_redirect": {
      const got = googleRedirectUri({ DOMAIN: String(input.domain) });
      if (got !== expect.uri) throw new Error(`got ${got}`);
      return;
    }
    case "pbkdf2": {
      const h = await makePasswordHash("eval-password", "s");
      if (!h.startsWith(`p2$${expect.iterations}$`)) throw new Error(`hash ${h.slice(0, 12)}`);
      const r = await checkPassword("eval-password", "s", h);
      if (!r.ok || r.upgrade) throw new Error("verify failed");
      return;
    }
    case "nav_app": {
      const r = navAppRedirect(String(input.path), String(input.search || ""), Boolean(input.signedIn), Boolean(input.owner));
      if (r.location !== expect.location) throw new Error(`got ${r.location}`);
      return;
    }
    case "plan_prompt": {
      // Progressive disclosure: what the one loop's system prompt shows a caller.
      const r = durablePlan({ goal: "g", kind: "mission", tasks: [], owner: Boolean(input.owner) }) as { messages?: Array<{ content: string }> };
      const sys = String(r.messages?.[0]?.content ?? "");
      for (const c of (expect.contains as string[]) ?? []) if (!sys.includes(c)) throw new Error(`prompt missing ${c}`);
      for (const c of (expect.omits as string[]) ?? []) if (sys.includes(c)) throw new Error(`prompt leaked ${c}`);
      return;
    }
    case "tool_load": {
      const t = durableOp<{ text: string }>("tool_load", input).text;
      if (expect.contains && !t.includes(String(expect.contains))) throw new Error(`got ${t.slice(0, 120)}`);
      return;
    }
    case "tool_ok": {
      const ok = durableOp<{ ok: boolean }>("tool_ok", input).ok;
      if (ok !== Boolean(expect.ok)) throw new Error(`ok=${ok}`);
      return;
    }
    case "legacy_rows": {
      const r = durableOp<{ rows: Array<Record<string, unknown>>; skipped: number }>("legacy", input);
      if (r.rows.length !== expect.rows || r.skipped !== expect.skipped) throw new Error(`rows ${r.rows.length} skipped ${r.skipped}`);
      if (expect.status && r.rows[0]?.status !== expect.status) throw new Error(`status ${r.rows[0]?.status}`);
      return;
    }
    case "fetch_redirect": {
      // web_fetch in the one loop: a public page that redirects to an internal host must be refused.
      const hop = (async (u: RequestInfo | URL) =>
        String(u) === String(input.url) ? new Response(null, { status: 302, headers: { Location: String(input.location) } }) : new Response("ok")) as typeof fetch;
      let ok = true;
      try {
        await fetchPublicPage(String(input.url), hop);
      } catch {
        ok = false;
      }
      if (ok !== Boolean(expect.ok)) throw new Error(`ok=${ok}`);
      return;
    }
    case "one_engine": {
      // Structural: no source file may load the retired Pi harness again.
      const { execSync } = await import("node:child_process");
      const hits = execSync(`grep -rlE "${String(input.pattern)}" src apps/missions/src apps/oral/src --include=*.ts --include=*.tsx || true`, { cwd: join(root, "..") }).toString().trim();
      if (hits) throw new Error(`found in ${hits.replace(/\n/g, ", ")}`);
      return;
    }
    default:
      throw new Error(`unknown check ${check}`);
  }
}

const fixtures = loadFixtures();
let failed = 0;
const results: Array<{ id: string; suite: string; ok: boolean; error?: string }> = [];
for (const f of fixtures) {
  try {
    await runCheck(f);
    results.push({ id: f.id, suite: f.suite, ok: true });
    console.log(`ok   ${f.suite.padEnd(16)} ${f.id}`);
  } catch (e) {
    failed++;
    const error = (e as Error).message;
    results.push({ id: f.id, suite: f.suite, ok: false, error });
    console.log(`FAIL ${f.suite.padEnd(16)} ${f.id}  ${error}`);
  }
}
const passed = results.length - failed;
console.log(`\n${passed}/${results.length} passed (${failed} failed)`);
if (process.env.EVAL_JSON === "1") {
  console.log(JSON.stringify({ passed, failed, results }, null, 2));
}
if (failed) process.exit(1);
