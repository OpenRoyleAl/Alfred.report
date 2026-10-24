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
import { durableFetchCheck, durablePlan, mcpAllow, mcpParseScopes, navSafeNext, reviewCore, reportSpeak, reportBuild } from "../src/alfred/core.ts";
import { nextBindState } from "../src/alfred/bind.ts";
import { senderAuthenticated } from "../src/lib/mail-auth.ts";

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

function runCheck(f: Fixture): void {
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
    default:
      throw new Error(`unknown check ${check}`);
  }
}

const fixtures = loadFixtures();
let failed = 0;
const results: Array<{ id: string; suite: string; ok: boolean; error?: string }> = [];
for (const f of fixtures) {
  try {
    runCheck(f);
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
