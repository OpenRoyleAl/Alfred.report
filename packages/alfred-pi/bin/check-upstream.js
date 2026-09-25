#!/usr/bin/env node
/** Print linked pi version on install / start — branding stays alfred-pi. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  const pkg = require("@earendil-works/pi-coding-agent/package.json");
  console.log(`[alfred-pi] linked @earendil-works/pi-coding-agent@${pkg.version} — Alfred.report! branding unchanged`);
} catch {
  console.log("[alfred-pi] optional upstream not installed; CLI branding still Alfred.report!");
}
