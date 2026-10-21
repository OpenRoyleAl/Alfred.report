#!/usr/bin/env node
// Owner memory seed: loads the owner's private material into Agent Memory at setup.
//
// The material NEVER lives in git. Point ALFRED_PRIVATE_DIR at a private directory
// (e.g. ~/.alfred-private/<instance>); every *.md / *.txt file under it is ingested into
// the instance's Agent Memory namespace (config AGENT_MEMORY_NAMESPACE), profile "owner"
// (the profile the Missions Worker reads), one session per file so a re-run is traceable.
//
//   ALFRED_PRIVATE_DIR=~/.alfred-private/me node scripts/seed-memory.mjs           # plan only
//   ALFRED_PRIVATE_DIR=~/.alfred-private/me node scripts/seed-memory.mjs --apply   # ingest
//
// Uses `cf agent-memory ingest` (account auth from `cf auth login`). Without --apply it
// only lists what it would send; it makes no API calls.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccount } from "../config/account.ts";

const PROFILE = "owner";
const MAX_CHARS = 6000;
const apply = process.argv.includes("--apply");
const dir = process.env.ALFRED_PRIVATE_DIR;
if (!dir) {
  console.error("set ALFRED_PRIVATE_DIR to the private seed directory (outside the repo)");
  process.exit(2);
}
const REPO = fileURLToPath(new URL("..", import.meta.url));
if (!relative(REPO, resolve(dir)).startsWith("..")) {
  console.error("ALFRED_PRIVATE_DIR must be outside the repository");
  process.exit(2);
}
const namespace = loadAccount().get("AGENT_MEMORY_NAMESPACE");

function walk(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(md|txt)$/i.test(n) ? [p] : [];
  });
}

function chunks(text) {
  const out = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + "\n\n" + para).length > MAX_CHARS && cur) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const files = walk(dir);
const tmp = mkdtempSync(join(tmpdir(), "alfred-seed-"));
try {
  for (const f of files) {
    const rel = relative(dir, f);
    const messages = chunks(readFileSync(f, "utf8")).map((c) => ({
      role: "user",
      content: `Owner reference material (${rel}):\n\n${c}`,
    }));
    const session = `seed:${rel}`;
    console.log(`${apply ? "ingest" : "plan  "} ${rel}: ${messages.length} message(s) -> ${namespace}/${PROFILE} session ${session}`);
    if (!apply) continue;
    const file = join(tmp, "messages.json");
    writeFileSync(file, JSON.stringify(messages), { mode: 0o600 });
    execFileSync("cf", ["agent-memory", "ingest", PROFILE, "--namespace-name", namespace, "--messages", `@${file}`, "--session-id", session], { stdio: "inherit" });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!apply) console.log(`${files.length} file(s). Re-run with --apply to ingest.`);
