#!/usr/bin/env node
/**
 * alfred-grok — branded Reserve for Alfred.report!
 * Links mweinbach/open-grok when present; never vendors a fork.
 * `alfred-grok login` opens Google sign-in on alfred.report (same session as web).
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const WAKE = "Alfred.report!";
const INSTALL_URL = "https://alfred.report";
const LOGIN_URL = `${INSTALL_URL}/login?next=/home`;
const UPSTREAM_NPM = []; // open-grok may not be on npm yet
const UPSTREAM_GIT = "https://github.com/mweinbach/open-grok.git";
const CONFIG_DIR = join(homedir(), ".config", "alfred-grok");
const require = createRequire(import.meta.url);

function banner() {
  console.log(`\n  \x1b[1malfred-grok\x1b[0m  ${WAKE}  v${VERSION}`);
  console.log(`  \x1b[2mReserve harness · Master is cloud Alfred.report! · same memory as web\x1b[0m`);
}

function checkUpstreamUpdate() {
  // Prefer linked local checkout; else try npm outdated message
  const local = process.env.OPEN_GROK_SRC || join(homedir(), "projects", "open-grok");
  if (existsSync(join(local, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(local, "package.json"), "utf8"));
      console.log(`  \x1b[2mupstream open-grok (local): ${pkg.version || "dev"} @ ${local}\x1b[0m`);
      console.log(`  \x1b[2mto update: git -C ${local} pull\x1b[0m`);
      return local;
    } catch { /* ignore */ }
  }
  console.log(`  \x1b[2mupstream: ${UPSTREAM_GIT}\x1b[0m`);
  console.log(`  \x1b[2mclone once: git clone ${UPSTREAM_GIT} ~/projects/open-grok\x1b[0m`);
  return null;
}

function openLogin() {
  console.log(`  Opening Google sign-in: ${LOGIN_URL}`);
  console.log(`  After sign-in, your CLI uses the same Alfred.report! session (no API key paste).`);
  try {
    if (process.platform === "darwin") spawnSync("open", [LOGIN_URL], { stdio: "ignore" });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", LOGIN_URL], { stdio: "ignore" });
    else spawnSync("xdg-open", [LOGIN_URL], { stdio: "ignore" });
  } catch { /* headless */ }
  console.log(`  ${LOGIN_URL}`);
}

function main() {
  const argv = process.argv.slice(2);
  banner();
  const local = checkUpstreamUpdate();

  if (argv[0] === "login" || argv[0] === "auth") {
    openLogin();
    return;
  }
  if (argv[0] === "version" || argv[0] === "-V" || argv[0] === "--version") {
    console.log(VERSION);
    return;
  }
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help" || !argv[0]) {
    console.log(`
  Usage:
    alfred-grok login     Google sign-in via alfred.report (no API keys)
    alfred-grok update    Pull linked open-grok if local checkout exists
    alfred-grok           Start Reserve (requires open-grok linked)

  Modes: Ronin = this alone · Team = with alfred-pi · Web-only = no harness
  Master memory is always cloud Alfred.report! (CF Agents SDK).
`);
    if (!argv[0]) openLogin();
    return;
  }
  if (argv[0] === "update") {
    if (!local) {
      console.log("  No local open-grok checkout. Clone first.");
      process.exit(1);
    }
    const r = spawnSync("git", ["-C", local, "pull", "--ff-only"], { stdio: "inherit" });
    process.exit(r.status || 0);
  }

  // Try to hand off to open-grok binary if installed
  const candidates = [
    local && join(local, "dist", "cli.js"),
    local && join(local, "bin", "open-grok.js"),
    join(homedir(), ".local", "bin", "open-grok"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) {
      console.log(`  \x1b[2mstarting upstream via ${c}\x1b[0m`);
      const r = spawnSync(process.execPath, [c, ...argv], { stdio: "inherit", env: { ...process.env, ALFRED_GATEWAY_URL: process.env.ALFRED_GATEWAY_URL || "https://alfred.report", ALFRED_BRAND: WAKE } });
      process.exit(r.status || 0);
    }
  }
  console.log(`  Upstream open-grok not linked yet.`);
  console.log(`  1) git clone ${UPSTREAM_GIT} ~/projects/open-grok`);
  console.log(`  2) alfred-grok login`);
  console.log(`  Branding stays Alfred.report! — upstream updates do not rewrite our CLI name.`);
  process.exit(0);
}

main();
