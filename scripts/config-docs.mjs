#!/usr/bin/env node
// Generates docs/CONFIG.md and alfred.config.example.json from config/schema.ts.
//   node scripts/config-docs.mjs          write both files
//   node scripts/config-docs.mjs --check  exit 1 when either file is stale (used by the gate)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SCHEMA } from "../config/schema.ts";

const KIND_TITLE = {
  var: "Variables (plain Worker vars)",
  secret: "Secrets (Secrets Store; binding name = secret name)",
  resource: "Resources (names/ids behind bindings; an unset id lets `cf deploy` provision it)",
  build: "Deploy-time values",
};
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");

function markdown() {
  const out = [
    "# Configuration",
    "",
    "<!-- Generated from config/schema.ts by `npm run config:docs`. Do not edit by hand. -->",
    "",
    "One typed schema (`config/schema.ts`) declares every value an instance needs. Values resolve in",
    "this order: environment / Workers Builds variables, then `alfred.config.json` at the repo root",
    "(gitignored; start from `alfred.config.example.json`), then the schema default. Unknown keys in",
    "`alfred.config.json` are an error. Secrets never go in that file: `scripts/setup.sh` writes them",
    "to the account's Secrets Store from environment variables.",
    "",
    "Apps: `web` = deploy/web (src/index.ts), `missions` = apps/missions, `oral` = apps/oral.",
    "",
  ];
  for (const kind of ["build", "var", "secret", "resource"]) {
    out.push(`## ${KIND_TITLE[kind]}`, "", "| Key | Apps | Required | Default | Description |", "|---|---|---|---|---|");
    for (const [k, d] of Object.entries(SCHEMA)) {
      if (d.kind !== kind) continue;
      out.push(`| \`${k}\` | ${d.apps.join(", ")} | ${d.required ? "yes" : ""} | ${d.default !== undefined ? `\`${cell(d.default)}\`` : ""} | ${cell(d.description)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

function example() {
  const o = {};
  for (const [k, d] of Object.entries(SCHEMA)) {
    if (d.kind === "secret") continue;
    o[k] = d.example ?? d.default ?? "";
  }
  return JSON.stringify(o, null, 2) + "\n";
}

const targets = [
  ["docs/CONFIG.md", markdown()],
  ["alfred.config.example.json", example()],
];
if (process.argv.includes("--check")) {
  const stale = targets.filter(([f, c]) => !existsSync(f) || readFileSync(f, "utf8") !== c).map(([f]) => f);
  if (stale.length) {
    console.error(`stale (run npm run config:docs): ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("config docs current");
} else {
  for (const [f, c] of targets) writeFileSync(f, c);
  console.log(targets.map(([f]) => f).join(", "));
}
