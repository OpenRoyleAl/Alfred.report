#!/usr/bin/env node
// Small CLI over config/schema.ts for shell scripts:
//   node scripts/config-cli.mjs get KEY       resolved value (env -> alfred.config.json -> default)
//   node scripts/config-cli.mjs secrets        every secret name (one per line)
import { loadAccount } from "../config/account.ts";
import { SCHEMA } from "../config/schema.ts";

const [cmd, key] = process.argv.slice(2);
if (cmd === "get") {
  if (!(key in SCHEMA)) { console.error(`unknown key ${key}`); process.exit(2); }
  process.stdout.write(loadAccount().get(key) ?? "");
} else if (cmd === "secrets") {
  console.log(Object.entries(SCHEMA).filter(([, d]) => d.kind === "secret").map(([k]) => k).join("\n"));
} else {
  console.error("usage: config-cli.mjs get KEY | secrets");
  process.exit(2);
}
