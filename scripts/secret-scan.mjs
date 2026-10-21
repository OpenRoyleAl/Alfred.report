#!/usr/bin/env node
// Fails the build if tracked files contain credentials, account IDs or personal emails.
// Pure Node (no ripgrep in Workers Builds). Scans `git ls-files` (falls back to a walk).
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const RULES = [
  ["cloudflare api token", /\b(?:cfat|cfut|cfk)_[A-Za-z0-9_-]{30,}/],
  ["bearer literal", /Bearer\s+[A-Za-z0-9._-]{32,}/],
  ["stripe secret", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["stripe webhook secret", /\bwhsec_[A-Za-z0-9]{16,}/],
  ["openai/anthropic/xai key", /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|xai-[A-Za-z0-9]{32,})/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["cloudflare account/resource id", /\b[0-9a-f]{32}\b/],
  ["stripe price id (put it in config)", /\bprice_[A-Za-z0-9]{14,}/],
  ["phone number", /(?:^|[\s"'>(])\+\d{1,3}(?:[\s.-]\(?\d{1,5}\)?){2,5}(?=[\s"'<]|$)/],
  ["personal email", /\b[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*example\.(?:com|org)\b|alfred\.report\b|x\.com\b|y\.com\b|company\.com\b|viewer\.grok\.invalid\b|users\.noreply\.github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/i],
];
// Owner-specific identifiers that must never ship in a per-account template.
const DENY = (process.env.SECRET_SCAN_DENY ?? "").split(",").filter(Boolean);
const ALLOW_FILES = /(^|\/)(package-lock\.json|.*\.lock|.*\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|mp4|wasm|pdf|zip))$|^scripts\/secret-scan\.mjs$/;
const ALLOW_LINE = /secret-scan:\s*allow|sha(256|384|512)-|"integrity"|ETag|<svg|data:image/;

let files;
try { files = execSync("git ls-files -z", { encoding: "utf8" }).split("\0").filter(Boolean); }
catch { console.error("secret-scan: not a git checkout"); process.exit(2); }

const hits = [];
for (const f of files) {
  if (ALLOW_FILES.test(f)) continue;
  let st; try { st = statSync(f); } catch { continue; }
  if (!st.isFile() || st.size > 2_000_000) continue;
  const text = readFileSync(f, "utf8");
  if (text.includes("\0")) continue;
  text.split("\n").forEach((line, i) => {
    if (ALLOW_LINE.test(line)) return;
    for (const d of DENY) if (line.includes(d)) hits.push(`${f}:${i + 1} denylisted identifier`);
    for (const [name, re] of RULES) if (re.test(line)) hits.push(`${f}:${i + 1} ${name}`);
  });
}
if (hits.length) {
  console.error(`✗ secret-scan: ${hits.length} finding(s)\n` + hits.slice(0, 200).join("\n"));
  process.exit(1);
}
console.log(`✓ secret-scan: ${files.length} tracked files clean`);
