#!/usr/bin/env node
// alfred-pi — local harness. Wake word: Alfred.report!
// All inference routes through CF alfred-ai-gateway (Workers AI first).
// Dogfood PATH target until npm @openroyleal/alfred-pi publishes.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as readline from "node:readline";

const VERSION = "0.1.0-local";
function printLinkedPiVersion() {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@earendil-works/pi-coding-agent/package.json");
    if (pkg && pkg.version) {
      console.log(
        "  \x1b[2mlinked pi-coding-agent@" +
          pkg.version +
          " — update with: npm i @earendil-works/pi-coding-agent@latest\x1b[0m"
      );
    }
  } catch {
    /* optional upstream not installed — branding stays Alfred.report! */
  }
}

const WAKE = "Alfred.report!";
/** Chat identity — never invent "Alfred Pi" as a personal name. */
const SYSTEM_PROMPT =
  "You are **Alfred.report!** (exclamation included) — Cloudflare OS local harness " +
  "and the mouth of alfred.report. " +
  "You are NOT \"Alfred Pi\", not a separate person named Pi, and not a human. " +
  "\"alfred-pi\" is only the package/CLI name (binaries: alfred-pi, alfred report, alfred pi). " +
  "The human operator is Hans Alfred Koch (HAK); Al/Alfred is his middle name — you are the " +
  "report harness named after that middle name, not him. " +
  "Wake word: Alfred.report! Brief operator tone. Be helpful and concise. Canon SOUL: CF Agent Memory namespace alfred / profile alfred (local files are route stubs).";
const PRODUCT_GATEWAY = "alfred";
const INSTALL_URL = "https://alfred.report";
const CONFIG_DIR = join(homedir(), ".config", "alfred-pi");
const ENV_PATH = join(CONFIG_DIR, ".env");
const CFG_PATH = join(CONFIG_DIR, "config.json");
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
const VAULT_CF = join(homedir(), ".vault", "cloudflare.env");

/** Operator dogfood only — never default for consumers. */
function isOperatorMode(argvFlags = []) {
  const envOn =
    process.env.ALFRED_PI_OPERATOR === "1" ||
    process.env.ALFRED_PI_OPERATOR === "true" ||
    process.env.ALFRED_PI_ALLOW_VAULT === "1";
  const flagOn = argvFlags.includes("--vault") || argvFlags.includes("--operator");
  return envOn || flagOn;
}

function readVaultIfOperator(argvFlags = []) {
  if (!isOperatorMode(argvFlags)) return {};
  return existsSync(VAULT_CF) ? readEnvFile(VAULT_CF) : {};
}

/** OSC-8 hyperlink when terminal supports it; always include plain URL. */
function formatLoginUrl(url) {
  const plain = String(url || `${INSTALL_URL}/login`);
  // OSC 8 hyperlink wrapping the plain URL (falls back to visible plain text)
  return `\x1b]8;;${plain}\x1b\\${plain}\x1b]8;;\x1b\\`;
}

function openLoginPage({ quiet = false } = {}) {
  const url = `${INSTALL_URL}/login`;
  if (!quiet) console.log(`  ${formatLoginUrl(url)}`);
  try {
    if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else spawnSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    /* headless / no browser — URL already printed */
  }
  return url;
}

function finishPromptStdin(stdin, wasRaw) {
  try {
    if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
  } catch {
    /* ignore */
  }
  // Nested inside TUI raw-mode: leave stdin flowing. CLI login: pause so Node can exit.
  if (!wasRaw) {
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
  }
}

function promptSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? !!stdin.isRaw : false;
    let buf = "";
    if (stdin.isTTY) {
      // Prefer hidden input when TTY; do NOT open readline here (it holds the event loop).
      process.stdout.write(question);
      try {
        stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            finishPromptStdin(stdin, wasRaw);
            process.stdout.write("\n");
            resolve(buf.trim());
            return;
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            finishPromptStdin(stdin, wasRaw);
            process.stdout.write("\n");
            resolve("");
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            if (buf.length) buf = buf.slice(0, -1);
            continue;
          }
          if (ch >= " ") {
            buf += ch;
            process.stdout.write("*");
          }
        }
      };
      stdin.on("data", onData);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

const LOCAL_PKG = join(homedir(), "projects", "alfred-report", "packages", "alfred-pi");
const CLOUDFLARE_SKILLS_REPO = "https://github.com/cloudflare/skills.git";
const CLOUDFLARE_SKILLS_DIR =
  process.env.OPENROYLEAL_CF_SKILLS_DIR ||
  process.env.ALFRED_PI_SKILLS_DIR ||
  join(homedir(), ".alfred-pi", "skills", "cloudflare");
/** Pi/Larga harness path that actually loads Agent Skills. */
const PI_SKILLS_DIR = process.env.PI_SKILLS_DIR || join(homedir(), ".pi", "agent", "skills");

/** Default: tiniest Workers AI chat model for dogfood burns. */
/** Concrete fallback when Alfred-auto resolves a Workers AI rung. */
const DEFAULT_CONCRETE_MODEL = "@cf/meta/llama-3.2-1b-instruct";
/** Default mode id — Alfred-auto picks from gateway ladder (Workers AI free first). */
const MODEL_AUTO = "alfred-auto";
/** Elevated mode tag when Max/token plans are wired (locked tagline). */
const MODEL_GO_MAX = "go-max-al";
const GO_MAX_DISPLAY = "Go Max Al!";
/** Default stored model mode. */
const DEFAULT_MODEL = MODEL_AUTO;

const MIMO_PRO = "mimo-v2.6-pro";
const MIMO_FLASH = "mimo-v2.6-flash";
/** Preferred vision (cheap when credits exist). */
const MIMO_VISION = MIMO_FLASH;
/** Vision backup when MiMo 429/quota — Grok 4.7 multimodal via gateway alfred (never text-only Workers AI). */
const GROK_VISION = "grok-4.7";
/** Frontier Grok via Alfred Gateway (xAI) — preferred heavy rung when Max/token plans elevated. */
const GROK_DEFAULT = "grok-4.7";

/** Locked curated ladder — Alfred-auto at top; Workers AI free first; Grok/MIMO via gateway alfred. */
const CURATED_MODELS = [
  {
    id: MODEL_AUTO,
    provider: "alfred-auto",
    note: "default · Workers AI free first → Grok 4.7 / MIMO via gateway alfred when needed",
  },
  { id: "@cf/meta/llama-3.2-1b-instruct", provider: "workers-ai", note: "tiny neurons · free-first" },
  { id: "@cf/meta/llama-3.2-3b-instruct", provider: "workers-ai", note: "small" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", provider: "workers-ai", note: "mid" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "workers-ai", note: "strong Workers AI" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", provider: "workers-ai", note: "code" },
  { id: GROK_DEFAULT, provider: "xai", note: "Grok 4.7 · gateway alfred · frontier + vision backup" },
  { id: MIMO_PRO, provider: "mimo", note: "MiMo v2.6 Pro · gateway alfred · after free Workers AI" },
  { id: MIMO_FLASH, provider: "mimo", note: "MiMo v2.6 Flash · vision first · gateway alfred" },
];

const AUTO_LADDER = CURATED_MODELS.filter((m) => m.provider === "workers-ai").map((m) => m.id);

function isAutoModelId(id) {
  const s = String(id || "").toLowerCase();
  return s === MODEL_AUTO || s === MODEL_GO_MAX || s === "go max al!" || s === "go-max-al!";
}

function isMimoModel(id) {
  return String(id || "").toLowerCase().includes("mimo");
}

function isGrokModel(id) {
  return String(id || "").toLowerCase().startsWith("grok-");
}

function isGatewayExternalModel(id) {
  return isMimoModel(id) || isGrokModel(id);
}

function messageHasVision(messages = []) {
  for (const m of messages || []) {
    const c = m?.content;
    if (Array.isArray(c) && c.some((p) => p && (p.type === "image_url" || p.type === "image" || p.image_url))) {
      return true;
    }
    const s = typeof c === "string" ? c : "";
    if (/data:image\//i.test(s)) return true;
    if (/https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?/i.test(s)) return true;
  }
  return false;
}

/** Cloudflare Images account hash + always-on visionprep (mobile-first ≤512 edge). */
const CF_IMAGES_HASH = "qylTSKAhkLl75P5qa0ChGw";
const CF_IMAGES_VARIANT = "visionprep";
const CF_IMAGES_ACCOUNT = "0870b0bdbc14bcd31f43fe5e82c3ee8e";
/** Longest edge — providers bill image tiles/tokens; stay aggressive. */
const VISION_MAX_EDGE = 512;
const VISION_JPEG_QUALITY = 72;

function readCfImagesToken() {
  if (process.env.CF_IMAGES_TOKEN) return String(process.env.CF_IMAGES_TOKEN).trim();
  const p = join(homedir(), ".vault", "cf-images-token.env");
  if (existsSync(p)) {
    const env = readEnvFile(p);
    if (env.CF_IMAGES_TOKEN) return String(env.CF_IMAGES_TOKEN).trim();
  }
  const vault = isOperatorMode(["--vault"]) ? readVaultIfOperator(["--vault"]) : {};
  return String(vault.CF_IMAGES_TOKEN || "").trim();
}

function isAlreadyVisionPrepUrl(url) {
  const s = String(url || "");
  return /imagedelivery\.net\//i.test(s) && new RegExp(`/${CF_IMAGES_VARIANT}(?:\\?|$)`, "i").test(s);
}

function extractPartImageSrc(part) {
  if (!part || typeof part !== "object") return null;
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url === "object" && typeof part.image_url.url === "string") {
    return part.image_url.url;
  }
  if (typeof part.url === "string" && (part.type === "image" || part.type === "image_url")) return part.url;
  return null;
}

function setPartImageSrc(part, url) {
  if (part.image_url && typeof part.image_url === "object") {
    part.image_url = { ...part.image_url, url };
  } else if (typeof part.image_url === "string") {
    part.image_url = url;
  } else {
    part.type = "image_url";
    part.image_url = { url };
  }
  return part;
}

/**
 * Resolve image bytes from data URL or http(s).
 * @returns {Promise<{buf: Buffer, contentType: string}|null>}
 */
async function loadImageBuffer(src) {
  const s = String(src || "").trim();
  if (!s) return null;
  if (/^data:image\//i.test(s)) {
    const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) return null;
    return { buf: Buffer.from(m[2].replace(/\s/g, ""), "base64"), contentType: m[1].toLowerCase() };
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      const res = await fetch(s, {
        headers: { Accept: "image/*,*/*", "User-Agent": "alfred-pi-visionprep/1.0" },
        redirect: "follow",
      });
      if (!res.ok) return null;
      const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const ab = await res.arrayBuffer();
      return { buf: Buffer.from(ab), contentType: ct || "image/jpeg" };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Prefer Worker /api/vision-prep (IMAGES binding). Fallback: CF Images direct upload + visionprep URL.
 * Storage quota 0 → upload fails; then keep original (still marked attempted).
 */
async function prepOneImageViaCf(src, { token, accountId, origin } = {}) {
  const original = String(src || "");
  if (!original) return { url: original, via: "empty" };
  if (isAlreadyVisionPrepUrl(original)) return { url: original, via: "already-visionprep" };

  const base = String(origin || process.env.ALFRED_ORIGIN || "https://alfred.report").replace(/\/$/, "");
  // 1) Worker path — IMAGES binding, no storage quota
  try {
    const g = resolveGateway();
    const bearer =
      token ||
      g.token ||
      g.inferenceToken ||
      process.env.ALFRED_OPS_TOKEN ||
      "";
    if (bearer) {
      const res = await fetch(`${base}/api/vision-prep`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image: original }),
      });
      if (res.ok) {
        const data = await res.json();
        const out = Array.isArray(data?.images) ? data.images[0] : null;
        if (out && typeof out === "string") {
          return { url: out, via: data?.meta?.via || "worker-vision-prep" };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // 2) Direct CF Images API upload → delivery URL /visionprep
  const imgToken = token || readCfImagesToken();
  const acct = accountId || process.env.CLOUDFLARE_ACCOUNT_ID || CF_IMAGES_ACCOUNT;
  if (imgToken) {
    const loaded = await loadImageBuffer(original);
    if (loaded) {
      try {
        const form = new FormData();
        const blob = new Blob([loaded.buf], { type: loaded.contentType || "image/jpeg" });
        form.append("file", blob, "vision-prep.jpg");
        const up = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/images/v1`, {
          method: "POST",
          headers: { Authorization: `Bearer ${imgToken}` },
          body: form,
        });
        const text = await up.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }
        if (up.ok && data?.success && data?.result?.id) {
          const id = data.result.id;
          const variants = data.result.variants || [];
          const vp = variants.find((v) => typeof v === "string" && v.includes(`/${CF_IMAGES_VARIANT}`));
          const url =
            vp ||
            `https://imagedelivery.net/${CF_IMAGES_HASH}/${id}/${CF_IMAGES_VARIANT}`;
          return { url, via: "cf-images-upload" };
        }
        // Quota 0 / plan limit — expected until Images plan raised
        if (data?.errors?.[0]?.code === 5453) {
          return { url: original, via: "cf-images-quota-0", deferred: true };
        }
      } catch {
        /* keep original */
      }
    }
  }

  return { url: original, via: "passthrough" };
}

/**
 * Always-on CF Images visionprep for multimodal messages before MiMo/Grok.
 * Cheap local/edge resize — never an LLM.
 */
async function prepareMessagesVisionCf(messages) {
  if (!messageHasVision(messages)) {
    return { messages, meta: { prepared: 0, skipped: 0, via: "none" } };
  }
  let prepared = 0;
  let skipped = 0;
  const out = [];
  for (const msg of messages || []) {
    const c = msg?.content;
    if (!Array.isArray(c)) {
      out.push(msg);
      continue;
    }
    const parts = [];
    for (const part of c) {
      if (!part || typeof part !== "object") {
        parts.push(part);
        continue;
      }
      const src = extractPartImageSrc(part);
      const isImg = part.type === "image_url" || part.type === "image" || src;
      if (!isImg || !src) {
        parts.push(part);
        continue;
      }
      const r = await prepOneImageViaCf(src);
      const next = { ...part };
      setPartImageSrc(next, r.url);
      if (r.via === "already-visionprep" || r.via === "passthrough" || r.via === "cf-images-quota-0") {
        skipped += 1;
      } else {
        prepared += 1;
      }
      parts.push(next);
    }
    out.push({ ...msg, content: parts });
  }
  return { messages: out, meta: { prepared, skipped, via: "cf-images" } };
}

/** Max / token plans / BYOK extras — elevates Alfred-auto display → Go Max Al! */
function hasMaxOrTokenPlans({ cfg = {}, fileEnv = {}, operator = false } = {}) {
  const vault = operator ? readVaultIfOperator(["--vault"]) : {};
  const keys = [
    process.env.HERMES_API_KEY,
    process.env.MIMO_API_KEY,
    process.env.MIMO_MAX_API_KEY,
    process.env.CURSOR_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.XAI_API_KEY,
    fileEnv.HERMES_API_KEY,
    fileEnv.MIMO_API_KEY,
    fileEnv.MIMO_MAX_API_KEY,
    fileEnv.CURSOR_API_KEY,
    fileEnv.OPENAI_API_KEY,
    fileEnv.XAI_API_KEY,
    cfg.byokOpenAi,
    cfg.byokMimo,
    cfg.byokXai,
    cfg.tokenPlan,
    cfg.maxPlan,
    vault.HERMES_API_KEY,
    vault.MIMO_API_KEY,
    vault.MIMO_MAX_API_KEY,
    vault.CURSOR_API_KEY,
  ];
  if (keys.some((k) => k && String(k).trim())) return true;
  if (cfg.authMode === "token-plan" || cfg.authMode === "max" || cfg.plan === "max") return true;
  if (cfg.tokenPlans && (Array.isArray(cfg.tokenPlans) ? cfg.tokenPlans.length : true)) return true;
  return false;
}

function modelDisplayName(activeModel, opts = {}) {
  const id = activeModel || MODEL_AUTO;
  if (isAutoModelId(id)) {
    // First principles: elevate to Go Max Al! only when logged in AND Max/token plans wired.
    // Never show Go Max Al! under auth NEED LOGIN (env BYOK keys alone do not elevate).
    const loggedIn = Boolean(opts.loggedIn);
    return loggedIn && hasMaxOrTokenPlans(opts) ? GO_MAX_DISPLAY : "Alfred-auto";
  }
  return id;
}

/**
 * Alfred-auto picker — Workers AI free/tiny first → elevate for code/reason/size.
 * Go Max Al! uses the same picker with combo/cost awareness when Max/token plans are wired.
 */
function pickAlfredAutoModel({ messages = [], maxTokens = 64, toolNeeds = false } = {}) {
  if (messageHasVision(messages)) return MIMO_VISION;
  const blob = messages
    .map((m) => (typeof m?.content === "string" ? m.content : ""))
    .join("\n")
    .slice(-8000);
  const lower = blob.toLowerCase();
  const long = blob.length > 2400 || maxTokens > 256;
  if (
    toolNeeds ||
    /\b(code|typescript|javascript|python|refactor|bug|compile|wrangler|sql|regex)\b/i.test(lower)
  ) {
    return "@cf/qwen/qwen2.5-coder-32b-instruct";
  }
  if (/\b(reason|prove|theorem|deep analysis|step by step|chain of thought)\b/i.test(lower)) {
    return GROK_DEFAULT;
  }
  if (long || /\b(frontier|long context|architecture|design doc)\b/i.test(lower)) {
    return "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  }
  if (blob.length > 800 || maxTokens > 128) {
    return "@cf/meta/llama-3.1-8b-instruct-fp8";
  }
  if (blob.length > 280) {
    return "@cf/meta/llama-3.2-3b-instruct";
  }
  return DEFAULT_CONCRETE_MODEL;
}

function resolveConcreteModel(activeModel, opts = {}) {
  if (!activeModel || isAutoModelId(activeModel)) {
    return pickAlfredAutoModel(opts);
  }
  return activeModel;
}

function pkgDir() {
  return dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

function usage() {
  return `${WAKE}  alfred-pi ${VERSION}

There are many agent harnesses but this one is yours.

Usage:
  alfred-pi                   interactive TUI (persistent Alfred.report! splash home)
  alfred-pi --repl            text REPL (alfred> slash fallback)
  alfred-pi --resume <slug>   resume mission (TUI)
  alfred-pi login             sign in via alfred.report (paste CF AI Gateway token)
  alfred-pi login --vault     operator dogfood: wire from ~/.vault (ALFRED_PI_OPERATOR=1)
  alfred-pi logout            clear local gateway token config
  alfred-pi status            PATH + gateway wire check
  alfred-pi update            update harness + live Cloudflare skills
  alfred-pi skills sync       refresh github.com/cloudflare/skills
  alfred-pi skills status     show live skills checkout status
  alfred-pi --self-test       wake-word unit check (no inference)
  alfred-pi --no-splash       skip boot splash
  alfred-pi --help            this help
  alfred-pi --version

Splash home (default landing — stays until you act):
  Type a message / Enter → chat · / slash popover · Esc or Ctrl+P → numbered menu · Ctrl+C quit

Numbered menu (Esc / Ctrl+P from splash):
  Chat · Models · Resume mission · Usage/map · Login/Logout · Text REPL · Help · Exit

REPL/TUI slash commands:
  /model [n|id]    list curated ladder · switch (Alfred-auto default; Go Max Al! when logged in + Max/token)
                   (/models is a silent alias — not shown in slash menu)
  /usage           gateway map — standings, models, pace / coin hint
  /map             alias → /usage (same map view)
  /resume [slug]   resume mission (or last)
  /mission [slug]  alias → /resume (mission)
  /login           sign in via alfred.report
  /logout          clear local gateway token config
  /menu            back to splash home
  /exit            leave REPL / quit
  /help            this help

Chat/splash: type / for inline slash popover (filter in-place · ↑↓ · Enter · Esc)

Locked CLI (also via shim \`alfred\`):
  alfred report               open TUI (same as alfred-pi)
  alfred pi                   open TUI
  alfred report <slug>        resume mission
  alfred report update        update
  alfred login                sign in via alfred.report
  alfred login --vault        operator: wire from ~/.vault
`;
}

function parseDotenv(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.toLowerCase().startsWith("export ")) line = line.slice(7).trim();
    const i = line.indexOf("=");
    if (i < 1) continue;
    let k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function readEnvFile(path) {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));
  } catch {
    cfg = {};
  }
  const fileEnv = readEnvFile(ENV_PATH);
  return { cfg, fileEnv };
}

function gatewayUrl(accountId, gatewayId) {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/`;
}

function mask(value) {
  if (!value) return "(missing)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)} len=${value.length}`;
}

function resolveGateway(opts = {}) {
  const { cfg, fileEnv } = loadConfig();
  const operator = opts.operator === true || isOperatorMode(opts.flags || []);
  // Consumer default: never read ~/.vault / alfred-secrets / CF_TOKEN_MASTER / ALFRED_ADMIN_TOKEN.
  // Operator dogfood (--vault or ALFRED_PI_OPERATOR=1) may use vault on Vultr.
  const vault = operator ? readVaultIfOperator(["--vault"]) : {};
  const token =
    process.env.ALFRED_AI_GATEWAY_TOKEN ||
    process.env.CF_AIG_TOKEN_PI ||
    fileEnv.ALFRED_AI_GATEWAY_TOKEN ||
    (operator ? vault.CF_AIG_TOKEN_PI || vault.CF_AIG_TOKEN || "" : "") ||
    "";
  const tokenSource = process.env.ALFRED_AI_GATEWAY_TOKEN
    ? "env:ALFRED_AI_GATEWAY_TOKEN"
    : process.env.CF_AIG_TOKEN_PI
      ? "env:CF_AIG_TOKEN_PI"
      : fileEnv.ALFRED_AI_GATEWAY_TOKEN
        ? "config:.env"
        : operator && vault.CF_AIG_TOKEN_PI
          ? "vault:CF_AIG_TOKEN_PI"
          : operator && vault.CF_AIG_TOKEN
            ? "vault:CF_AIG_TOKEN"
            : "";
  // Consumer: pasted CF AI Gateway token is the inference credential.
  // Operator: may use vault ALFRED_ADMIN_TOKEN / CLOUDFLARE_API_TOKEN — never on default login.
  const inferenceToken =
    process.env.ALFRED_AI_INFERENCE_TOKEN ||
    fileEnv.ALFRED_AI_INFERENCE_TOKEN ||
    (operator
      ? process.env.ALFRED_ADMIN_TOKEN ||
        process.env.CLOUDFLARE_API_TOKEN ||
        vault.ALFRED_ADMIN_TOKEN ||
        vault.CLOUDFLARE_API_TOKEN ||
        vault.CF_AIG_TOKEN ||
        ""
      : "") ||
    token;
  const inferenceSource = process.env.ALFRED_AI_INFERENCE_TOKEN
    ? "env:ALFRED_AI_INFERENCE_TOKEN"
    : fileEnv.ALFRED_AI_INFERENCE_TOKEN
      ? "config:.env"
      : operator && process.env.ALFRED_ADMIN_TOKEN
        ? "env:ALFRED_ADMIN_TOKEN"
        : operator && process.env.CLOUDFLARE_API_TOKEN
          ? "env:CLOUDFLARE_API_TOKEN"
          : operator && vault.ALFRED_ADMIN_TOKEN
            ? "vault:ALFRED_ADMIN_TOKEN"
            : operator && vault.CLOUDFLARE_API_TOKEN
              ? "vault:CLOUDFLARE_API_TOKEN"
              : operator && vault.CF_AIG_TOKEN
                ? "vault:CF_AIG_TOKEN"
                : tokenSource || "";
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    fileEnv.CLOUDFLARE_ACCOUNT_ID ||
    cfg.accountId ||
    (operator ? vault.CLOUDFLARE_ACCOUNT_ID || "" : "") ||
    "";
  const gatewayId =
    process.env.ALFRED_AI_GATEWAY_ID || fileEnv.CLOUDFLARE_GATEWAY_ID || cfg.gatewayId || PRODUCT_GATEWAY;
  const activeModel = cfg.activeModel || DEFAULT_MODEL;
  const lastSlug = cfg.lastSlug || null;
  const wired = Boolean(cfg.wiredAt && (fileEnv.ALFRED_AI_GATEWAY_TOKEN || fileEnv.ALFRED_AI_INFERENCE_TOKEN));
  const loggedIn = Boolean(wired || inferenceToken);
  const maxPlans = hasMaxOrTokenPlans({ cfg, fileEnv, operator });
  return {
    token,
    tokenSource,
    inferenceToken,
    inferenceSource,
    accountId,
    gatewayId,
    url: accountId ? gatewayUrl(accountId, gatewayId) : "",
    vaultPresent: operator && existsSync(VAULT_CF),
    operator,
    wired,
    wiredAt: cfg.wiredAt || null,
    activeModel,
    modelDisplay: modelDisplayName(activeModel, { cfg, fileEnv, operator, loggedIn }),
    maxPlans,
    lastSlug,
    cfg,
    fileEnv,
  };
}

function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function ensureSessionsDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

function writeEnv(obj) {
  ensureConfigDir();
  const lines = [
    "# alfred-pi local env — chmod 600. Do not commit.",
    `# wired ${new Date().toISOString()}`,
    ...Object.entries(obj).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

function writeCfg(partial) {
  ensureConfigDir();
  const { cfg } = loadConfig();
  const next = { ...cfg, ...partial };
  writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CFG_PATH, 0o600);
  return next;
}

function kebabOk(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false;
  if (slug.startsWith("mb-")) return false;
  // Never accept raw UUIDs as human mission ids
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) return false;
  return true;
}

function sessionPath(slug) {
  return join(SESSIONS_DIR, `${slug}.json`);
}

function loadSession(slug) {
  try {
    return JSON.parse(readFileSync(sessionPath(slug), "utf8"));
  } catch {
    return null;
  }
}

function saveSession(session) {
  ensureSessionsDir();
  const path = sessionPath(session.slug);
  writeFileSync(path, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  writeCfg({ lastSlug: session.slug });
}

/** Manila-local short month+day meat, e.g. mission-sep13-pi */
function timestampMeatSlug() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const mon = String(parts.month || "mon").toLowerCase().replace(/\./g, "");
  const day = String(parts.day || "0");
  return `mission-${mon}${day}-pi`;
}

const SLUG_STOP = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "my", "me", "please", "hey",
  "alfred", "report", "pi", "with", "from", "into", "this", "that", "just", "can", "you",
]);

/** Human kebab meat from first prompt — alfred-mem auto-rename doctrine (readable). */
function meatSlugFromText(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !SLUG_STOP.has(w) && w.length > 1)
    .slice(0, 3);
  if (!words.length) return null;
  const slug = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return kebabOk(slug) ? slug : null;
}

function uniqueMissionSlug(base) {
  let root = String(base || "").toLowerCase();
  if (!kebabOk(root)) root = timestampMeatSlug();
  let slug = root;
  let n = 2;
  while (existsSync(sessionPath(slug))) {
    slug = `${root}-${n}`;
    n += 1;
  }
  return slug;
}

/** Friendly title from slug or first user message. */
function missionTitle(session) {
  if (session?.title) return session.title;
  const first = (session?.messages || []).find((m) => m.role === "user");
  if (first?.content) {
    const t = String(first.content).replace(/\s+/g, " ").trim().slice(0, 48);
    if (t) return t;
  }
  const slug = session?.slug || "";
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "Mission";
}

/** alfred-mem doctrine: auto-rename empty timestamp-meat missions from first prompt. */
function maybeRenameMissionFromPrompt(session, prompt) {
  if (!session) return session;
  const text = String(prompt || "").trim();
  if (!text) return session;
  if (!session.title) session.title = text.replace(/\s+/g, " ").trim().slice(0, 48);
  if ((session.messages || []).length > 0) {
    saveSession(session);
    return session;
  }
  const meat = meatSlugFromText(text);
  const isAuto =
    /^mission-[a-z]{3}\d{1,2}-pi(-\d+)?$/.test(session.slug) ||
    /^session-\d{8}/.test(session.slug);
  if (!meat || !isAuto) {
    saveSession(session);
    return session;
  }
  const oldSlug = session.slug;
  let slug = meat;
  if (existsSync(sessionPath(slug)) && slug !== oldSlug) slug = uniqueMissionSlug(meat);
  if (slug === oldSlug) {
    saveSession(session);
    return session;
  }
  const oldPath = sessionPath(oldSlug);
  session.slug = slug;
  saveSession(session);
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {
    /* ignore */
  }
  return session;
}

function newSession(slug, { title } = {}) {
  const s = {
    slug,
    title: title || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: resolveGateway().activeModel || DEFAULT_MODEL,
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, neurons: 0, calls: 0 },
  };
  saveSession(s);
  return s;
}

function isLegacySessionSlug(slug) {
  return /^session-\d{8}(?:-\d+)?$/.test(String(slug || ""));
}

function isHiddenMissionSlug(slug) {
  const s = String(slug || "");
  if (s.startsWith("mb-")) return true;
  if (isLegacySessionSlug(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  return false;
}

function migrateLegacySessions() {
  ensureSessionsDir();
  let moved = 0;
  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const f of files) {
    const slug = f.slice(0, -5);
    if (!isLegacySessionSlug(slug)) continue;
    const sess = loadSession(slug);
    if (!sess) continue;
    const first = (sess.messages || []).find((m) => m.role === "user");
    const meat =
      meatSlugFromText(sess.title || first?.content || "") ||
      uniqueMissionSlug(timestampMeatSlug());
    const nextSlug = uniqueMissionSlug(meat);
    const oldPath = sessionPath(slug);
    sess.slug = nextSlug;
    if (!sess.title) sess.title = missionTitle({ ...sess, slug: nextSlug });
    saveSession(sess);
    try {
      if (existsSync(oldPath) && nextSlug !== slug) unlinkSync(oldPath);
    } catch {
      /* ignore */
    }
    moved += 1;
  }
  return moved;
}

function listLocalSlugs() {
  ensureSessionsDir();
  migrateLegacySessions();
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((s) => {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) || isHiddenMissionSlug(s)) return false;
        if (/^mission-\d{8}(?:-\d+)?$/.test(s)) {
          const miss = loadSession(s);
          if (!miss?.messages?.length && !miss?.title) return false;
          if (miss?.title && /^mission \d{8}/i.test(miss.title) && !(miss.messages || []).length) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ta = loadSession(a)?.updatedAt || "";
        const tb = loadSession(b)?.updatedAt || "";
        return String(tb).localeCompare(String(ta));
      });
  } catch {
    return [];
  }
}

function humanMissionName(m) {
  if (!m) return "Mission";
  const titled = m.title || m.human_title || m.budget?.human_title;
  if (titled && !/^(msn_|session-|mb-)/i.test(String(titled))) return String(titled).replace(/\s+/g, " ").trim().slice(0, 72);
  const o = String(m.objective || "");
  const sub = o.match(/Subject:\s*([^|]+)/i);
  if (sub) {
    const t = sub[1].trim().replace(/^Fwd:\s*/i, "").trim();
    if (t) return t.slice(0, 72);
  }
  const parts = o.split("|").map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^(mb-|msn_|gmail:|thread:|https?:)/i.test(part)) continue;
    if (part.length < 3) continue;
    return part.slice(0, 72);
  }
  if (m.slug && !isHiddenMissionSlug(m.slug) && !/^mission-[a-z]{3}\d/i.test(m.slug)) {
    return missionTitle(m);
  }
  return missionTitle(m);
}

function sessionFromRemoteMission(m) {
  const title = humanMissionName(m);
  const meat = meatSlugFromText(title) || uniqueMissionSlug(timestampMeatSlug());
  const existing = loadSession(meat);
  const messages = existing?.messages?.length ? existing.messages.slice() : [];
  if (!messages.length) {
    if (m.objective) messages.push({ role: "user", content: String(m.objective) });
    for (const ev of (m.evidence || []).slice(-8)) {
      if (!ev?.notes) continue;
      messages.push({
        role: ev.actor === "hans" || ev.actor === "user" ? "user" : "assistant",
        content: String(ev.notes),
      });
    }
    if (m.report) messages.push({ role: "assistant", content: String(m.report) });
  }
  return {
    slug: existing?.slug || meat,
    title,
    remoteId: m.id || null,
    state: m.state || "active",
    createdAt: existing?.createdAt || new Date(m.created_at || Date.now()).toISOString(),
    updatedAt: new Date(m.updated_at || Date.now()).toISOString(),
    model: existing?.model || resolveGateway().activeModel || DEFAULT_MODEL,
    messages,
    usage: existing?.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, neurons: 0, calls: 0 },
    budget: m.budget || existing?.budget || {},
  };
}

async function fetchRemoteMissions() {
  const g = resolveGateway();
  const token = g.inferenceToken || g.token;
  if (!token) return [];
  const urls = [
    "https://agent-alfred.iceberg.workers.dev/missions?limit=80",
    "https://alfred.report/api/command/missions?limit=80",
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const rows = Array.isArray(data?.missions) ? data.missions : Array.isArray(data) ? data : [];
      if (rows.length) return rows;
    } catch {
      /* try next */
    }
  }
  return [];
}

function renameMission(session, title) {
  const text = String(title || "").replace(/\s+/g, " ").trim().slice(0, 72);
  if (!session || !text) return session;
  session.title = text;
  const meat = meatSlugFromText(text);
  if (meat && meat !== session.slug) {
    const oldSlug = session.slug;
    const oldPath = sessionPath(oldSlug);
    let slug = meat;
    if (existsSync(sessionPath(slug)) && slug !== oldSlug) slug = uniqueMissionSlug(meat);
    session.slug = slug;
    saveSession(session);
    try {
      if (existsSync(oldPath) && slug !== oldSlug) unlinkSync(oldPath);
    } catch {
      /* ignore */
    }
    return session;
  }
  saveSession(session);
  return session;
}

function isCloudflareSkillsRemote(url) {
  const normalized = String(url || "")
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return normalized === "https://github.com/cloudflare/skills";
}

function runGit(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function cloudflareSkillsStatus() {
  const gitDir = join(CLOUDFLARE_SKILLS_DIR, ".git");
  if (!existsSync(gitDir)) {
    return { ok: false, path: CLOUDFLARE_SKILLS_DIR, error: "not a git checkout" };
  }
  const remoteResult = runGit(["-C", CLOUDFLARE_SKILLS_DIR, "remote", "get-url", "origin"]);
  const remote = (remoteResult.stdout || "").trim();
  if (remoteResult.status !== 0 || !isCloudflareSkillsRemote(remote)) {
    return { ok: false, path: CLOUDFLARE_SKILLS_DIR, remote, error: "origin is not cloudflare/skills" };
  }
  const head = (runGit(["-C", CLOUDFLARE_SKILLS_DIR, "rev-parse", "HEAD"]).stdout || "").trim();
  const originMain = (
    runGit(["-C", CLOUDFLARE_SKILLS_DIR, "rev-parse", "refs/remotes/origin/main"]).stdout || ""
  ).trim();
  const date = (
    runGit(["-C", CLOUDFLARE_SKILLS_DIR, "show", "-s", "--format=%cI", "HEAD"]).stdout || ""
  ).trim();
  return {
    ok: Boolean(head && originMain && head === originMain),
    path: CLOUDFLARE_SKILLS_DIR,
    remote,
    head,
    originMain,
    date,
    error: head === originMain ? "" : "HEAD does not match origin/main",
  };
}

/** Keep the official Cloudflare skills as a live git checkout, never a vendored snapshot. */
function syncCloudflareSkills({ reason = "sync", quiet = false } = {}) {
  const parent = dirname(CLOUDFLARE_SKILLS_DIR);
  mkdirSync(parent, { recursive: true });
  if (!existsSync(join(CLOUDFLARE_SKILLS_DIR, ".git"))) {
    if (existsSync(CLOUDFLARE_SKILLS_DIR)) {
      const entries = readdirSync(CLOUDFLARE_SKILLS_DIR);
      if (entries.length) {
        console.error(`Cloudflare skills: refusing non-git directory ${CLOUDFLARE_SKILLS_DIR}`);
        return false;
      }
    }
    if (!quiet) console.log(`Cloudflare skills (${reason}): cloning origin/main…`);
    const clone = runGit([
      "clone",
      "--branch",
      "main",
      "--single-branch",
      CLOUDFLARE_SKILLS_REPO,
      CLOUDFLARE_SKILLS_DIR,
    ]);
    if (clone.status !== 0) {
      console.error((clone.stderr || clone.stdout || "Cloudflare skills clone failed").trim());
      return false;
    }
  } else {
    const before = cloudflareSkillsStatus();
    if (!before.remote || !isCloudflareSkillsRemote(before.remote)) {
      console.error(
        `Cloudflare skills: refusing checkout with non-Cloudflare origin at ${CLOUDFLARE_SKILLS_DIR}`,
      );
      return false;
    }
    runGit(["-C", CLOUDFLARE_SKILLS_DIR, "remote", "set-url", "origin", CLOUDFLARE_SKILLS_REPO]);
    const fetch = runGit(["-C", CLOUDFLARE_SKILLS_DIR, "fetch", "--prune", "origin", "main"]);
    if (fetch.status !== 0) {
      console.error((fetch.stderr || fetch.stdout || "Cloudflare skills fetch failed").trim());
      return false;
    }
    const checkout = runGit([
      "-C",
      CLOUDFLARE_SKILLS_DIR,
      "checkout",
      "-B",
      "main",
      "origin/main",
    ]);
    if (checkout.status !== 0) {
      console.error((checkout.stderr || checkout.stdout || "Cloudflare skills checkout failed").trim());
      return false;
    }
    const reset = runGit(["-C", CLOUDFLARE_SKILLS_DIR, "reset", "--hard", "origin/main"]);
    if (reset.status !== 0) {
      console.error((reset.stderr || reset.stdout || "Cloudflare skills reset failed").trim());
      return false;
    }
  }
  const status = cloudflareSkillsStatus();
  if (!status.ok) {
    console.error(`Cloudflare skills: ${status.error || "checkout verification failed"}`);
    return false;
  }
  const linked = exposeCloudflareSkillsToPi();
  if (!quiet) {
    console.log(`✓ Cloudflare skills ${status.head.slice(0, 12)} (${status.date})`);
    console.log(`  ${status.path} ← ${status.remote} origin/main`);
    console.log(`  harness: ${PI_SKILLS_DIR} (${linked} skill links)`);
  }
  return true;
}


function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Link live cloudflare/skills folders into ~/.pi/agent/skills (what Pi loads). */
function exposeCloudflareSkillsToPi() {
  const srcRoot = join(CLOUDFLARE_SKILLS_DIR, "skills");
  if (!isDir(srcRoot)) return 0;
  mkdirSync(PI_SKILLS_DIR, { recursive: true });
  let linked = 0;
  for (const name of readdirSync(srcRoot)) {
    const src = join(srcRoot, name);
    if (!isDir(src)) continue;
    const target = join(PI_SKILLS_DIR, name);
    if (existsSync(target) || isSymlink(target)) {
      if (!isSymlink(target)) continue; // never clobber a real tree
      try {
        if (readlinkSync(target) === src) {
          linked += 1;
          continue;
        }
      } catch {
        /* rewrite below */
      }
      try {
        unlinkSync(target);
      } catch {
        continue;
      }
    }
    try {
      symlinkSync(src, target);
      linked += 1;
    } catch {
      /* ignore single-skill link failures */
    }
  }
  return linked;
}

function printCloudflareSkillsStatus() {
  const status = cloudflareSkillsStatus();
  console.log(`Cloudflare skills: ${status.ok ? "live origin/main" : "NOT READY"}`);
  console.log(`  path:   ${status.path}`);
  console.log(`  remote: ${status.remote || "(missing)"}`);
  console.log(`  HEAD:   ${status.head || "(missing)"}${status.date ? `  ${status.date}` : ""}`);
  if (status.error) console.log(`  error:  ${status.error}`);
  return status.ok;
}

async function cmdLoginVault() {
  syncCloudflareSkills({ reason: "login --vault" });
  const g = resolveGateway({ operator: true, flags: ["--vault"] });
  if (!g.token && !g.inferenceToken) {
    console.log(`${WAKE} login --vault`);
    console.log("Operator vault wire failed — gateway key not found.");
    console.log(`  expected vault file: ${VAULT_CF}`);
    console.log("  expected keys: CF_AIG_TOKEN_PI (or CF_AIG_TOKEN) + CLOUDFLARE_ACCOUNT_ID");
    console.log("  inference may use ALFRED_ADMIN_TOKEN or CLOUDFLARE_API_TOKEN (operator only)");
    console.log(`  consumer path: alfred login  →  ${INSTALL_URL}/login`);
    process.exitCode = 2;
    return false;
  }
  if (!g.accountId) {
    console.log(`${WAKE} login --vault`);
    console.log("CLOUDFLARE_ACCOUNT_ID missing from vault/env.");
    process.exitCode = 2;
    return false;
  }
  ensureConfigDir();
  const envObj = {
    CLOUDFLARE_ACCOUNT_ID: g.accountId,
    CLOUDFLARE_GATEWAY_ID: PRODUCT_GATEWAY,
    ALFRED_AI_GATEWAY_URL: gatewayUrl(g.accountId, PRODUCT_GATEWAY),
  };
  if (g.token) envObj.ALFRED_AI_GATEWAY_TOKEN = g.token;
  const vault = readVaultIfOperator(["--vault"]);
  const infer =
    process.env.ALFRED_AI_INFERENCE_TOKEN ||
    process.env.ALFRED_ADMIN_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    vault.ALFRED_ADMIN_TOKEN ||
    vault.CLOUDFLARE_API_TOKEN ||
    "";
  if (infer) envObj.ALFRED_AI_INFERENCE_TOKEN = infer;
  writeEnv(envObj);
  writeCfg({
    accountId: g.accountId,
    gatewayId: PRODUCT_GATEWAY,
    gatewayUrl: gatewayUrl(g.accountId, PRODUCT_GATEWAY),
    tokenSource: g.tokenSource || "vault",
    inferenceSource: infer
      ? vault.ALFRED_ADMIN_TOKEN === infer
        ? "vault:ALFRED_ADMIN_TOKEN"
        : "vault/env inference token"
      : g.tokenSource || "",
    wiredAt: new Date().toISOString(),
    authMode: "operator-vault",
    activeModel: g.activeModel || DEFAULT_MODEL,
    note: "Operator dogfood via ~/.vault. Consumer default is alfred.report paste — never pull CF_TOKEN_MASTER/alfred-secrets on default login.",
  });
  const after = resolveGateway({ operator: true, flags: ["--vault"] });
  console.log(`${WAKE} login --vault — gateway wired (operator)`);
  console.log(`  profile:   ${PRODUCT_GATEWAY}`);
  console.log(`  account:   ${g.accountId}`);
  console.log(`  url:       ${gatewayUrl(g.accountId, PRODUCT_GATEWAY)}`);
  console.log(`  gateway:   ${mask(g.token)}  via ${g.tokenSource || "(none)"}`);
  console.log(`  inference: ${mask(after.inferenceToken)}  via ${after.inferenceSource || "(none)"}`);
  console.log(`  model:     ${after.modelDisplay || after.activeModel}`);
  console.log(`  config:    ${CFG_PATH}`);
  console.log("  inference: not started (login only)");
  return true;
}

/** Consumer default: alfred.report Access-first — paste gateway token + account id. */
async function cmdLoginConsumer() {
  syncCloudflareSkills({ reason: "login" });
  const url = `${INSTALL_URL}/login`;
  console.log(`${brandWordmark(true)} login`);
  console.log("");
  console.log("  Sign in (Access-first):");
  console.log(`  1) Open  ${formatLoginUrl(url)}`);
  console.log("  2) After Cloudflare Access on the site, return here");
  console.log("  3) Paste account id + gateway token (steps below)");
  console.log("");
  console.log(`  ${C.muted}Next: alfred.report → Access → CF account → APIs / reserves · Agent Memory when ready${C.reset}`);
  console.log("");
  openLoginPage({ quiet: true });

  const existing = loadConfig();
  let accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    existing.fileEnv.CLOUDFLARE_ACCOUNT_ID ||
    existing.cfg.accountId ||
    "";
  if (!accountId) {
    if (!process.stdin.isTTY) {
      console.log("Account id required (non-interactive). Set CLOUDFLARE_ACCOUNT_ID or re-run in a TTY.");
      process.exitCode = 2;
      return false;
    }
    accountId = await promptLine("  Account id: ");
  }
  if (!accountId) {
    console.log("Account id required.");
    process.exitCode = 2;
    return false;
  }

  let token = "";
  if (process.stdin.isTTY) {
    token = await promptSecret("  Gateway token (hidden): ");
  } else if (process.env.ALFRED_AI_GATEWAY_TOKEN) {
    token = process.env.ALFRED_AI_GATEWAY_TOKEN;
  } else {
    console.log("No TTY — set ALFRED_AI_GATEWAY_TOKEN or run interactively.");
    process.exitCode = 2;
    return false;
  }
  if (!token) {
    console.log("No token pasted — login cancelled.");
    process.exitCode = 2;
    return false;
  }

  ensureConfigDir();
  const envObj = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_GATEWAY_ID: PRODUCT_GATEWAY,
    ALFRED_AI_GATEWAY_URL: gatewayUrl(accountId, PRODUCT_GATEWAY),
    ALFRED_AI_GATEWAY_TOKEN: token,
    ALFRED_AI_INFERENCE_TOKEN: token,
  };
  writeEnv(envObj);
  writeCfg({
    accountId,
    gatewayId: PRODUCT_GATEWAY,
    gatewayUrl: gatewayUrl(accountId, PRODUCT_GATEWAY),
    tokenSource: "paste:alfred.report",
    inferenceSource: "paste:alfred.report",
    wiredAt: new Date().toISOString(),
    authMode: "alfred.report",
    activeModel: existing.cfg.activeModel || DEFAULT_MODEL,
    note: "Consumer auth via alfred.report — gateway token pasted locally.",
  });
  const after = resolveGateway();
  console.log("");
  console.log(`${brandWordmark(true)} login — ready`);
  console.log(`  account:  ${accountId}`);
  console.log(`  gateway:  ${mask(token)}`);
  console.log(`  model:    ${after.modelDisplay || after.activeModel}`);
  console.log(`  next:     alfred pi`);
  return true;
}

async function cmdLogin(opts = {}) {
  const flags = opts.flags || [];
  const g = resolveGateway({ flags });
  if (g.wired || g.inferenceToken) {
    console.log(`${brandWordmark(true)} already wired — Log out to switch accounts`);
    console.log("  Multi-tenant CF account linking: later (HAK dogfood first).");
    console.log("  Opening Access URL (paste token only if the page does not finish onboarding).");
    openLoginPage();
    printStatus({ mode: "login-already-wired" });
    return true;
  }
  if (isOperatorMode(flags)) return cmdLoginVault();
  return cmdLoginConsumer();
}

function cmdLogout() {
  try {
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);
  } catch {
    /* ignore */
  }
  const { cfg } = loadConfig();
  const kept = {
    activeModel: cfg.activeModel || DEFAULT_MODEL,
    lastSlug: cfg.lastSlug || null,
    gatewayId: PRODUCT_GATEWAY,
    note: "Logged out — local gateway tokens cleared.",
  };
  writeFileSync(CFG_PATH, JSON.stringify(kept, null, 2) + "\n", { mode: 0o600 });
  console.log(`${WAKE} logout — local gateway token config cleared`);
  console.log(`  removed: ${ENV_PATH}`);
  console.log("  missions kept on disk; /login to sign in via alfred.report");
  const slug = kept.lastSlug || null;
  console.log("  next:");
  if (slug) {
    console.log(`    resume:  alfred report ${slug}`);
    console.log(`    or:      /resume ${slug}  (slash, if staying in TUI)`);
  } else {
    console.log("    resume:  alfred report <slug>   or  /resume <slug>");
  }
  console.log("    start:   alfred pi  /  alfred report");
  console.log("    stay:    /menu  ·  /login  ·  /exit");
}

function printStatus(extra = {}) {
  const g = resolveGateway();
  const which = spawnSync("bash", ["-lc", "command -v alfred-pi; command -v alfred"], { encoding: "utf8" });
  const bins = (which.stdout || "").trim().split("\n").filter(Boolean);
  console.log(`${WAKE}  alfred-pi ${VERSION}`);
  console.log(`  bin:       ${process.argv[1]}`);
  console.log(`  path:      ${bins[0] || "(not on login PATH)"}`);
  console.log(`  gateway:   ${g.gatewayId || PRODUCT_GATEWAY}  wired=${g.wired ? "yes" : "no"}`);
  console.log(`  account:   ${g.accountId || "(missing)"}`);
  console.log(`  url:       ${g.url || "(missing)"}`);
  console.log(`  gateway-token: ${g.token ? mask(g.token) : "(missing)"}  ${g.tokenSource || ""}`.trim());
  console.log(
    `  inference: ${g.inferenceToken ? mask(g.inferenceToken) : "(missing)"}  ${g.inferenceSource || ""}`.trim(),
  );
  console.log(`  model:     ${g.modelDisplay || g.activeModel}`);
  if (extra.slug) console.log(`  resume:    ${extra.slug}`);
  if (extra.mode) console.log(`  mode:      ${extra.mode}`);
  if (extra.inferenceIdle !== false) {
    console.log("  note:      Workers AI first via alfred-ai-gateway — chat burns neurons");
  }
}

function cmdUpdate() {
  console.log("Updating alfred-pi…");
  const skillsOk = syncCloudflareSkills({ reason: "update" });
  const npm = spawnSync("npm", ["install", "-g", "--ignore-scripts", "@openroyleal/alfred-pi"], {
    encoding: "utf8",
  });
  if (npm.status === 0) {
    console.log("✓ npm @openroyleal/alfred-pi");
    if (!skillsOk) process.exitCode = 1;
    return;
  }
  console.log("npm registry 404/fail — using local package");
  const src = existsSync(join(LOCAL_PKG, "package.json")) ? LOCAL_PKG : pkgDir();
  const homeLocal = join(homedir(), ".local");
  const inst = spawnSync("npm", ["install", "-g", "--ignore-scripts", "--prefix", homeLocal, src], {
    encoding: "utf8",
  });
  if (inst.status !== 0) {
    console.error(inst.stderr || inst.stdout || "local install failed");
    console.error(`See ${INSTALL_URL}/pi`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ local ${src} → ${homeLocal}/bin/alfred-pi`);
  if (!skillsOk) process.exitCode = 1;
}

async function cfApi(path, { method = "GET", body, token, accountId } = {}) {
  const g = resolveGateway();
  const acct = accountId || g.accountId;
  const tok = token || g.inferenceToken;
  if (!acct || !tok) throw new Error("missing accountId or inference token — /login first");
  const url = path.startsWith("http")
    ? path
    : `https://api.cloudflare.com/client/v4/accounts/${acct}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      "cf-aig-gateway-id": g.gatewayId || PRODUCT_GATEWAY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function listGatewayModels() {
  // Locked ladder: Alfred-auto at top + curated Workers AI — never dump full catalog (32+).
  const g = resolveGateway();
  const out = CURATED_MODELS.map((m) => {
    if (m.id !== MODEL_AUTO) return { ...m };
    if (g.maxPlans) {
      return {
        id: MODEL_AUTO,
        provider: "alfred-auto",
        note: `${GO_MAX_DISPLAY} · combo routing · cost/usage aware`,
        label: GO_MAX_DISPLAY,
      };
    }
    return { ...m, label: "Alfred-auto" };
  });
  // MIMO / extras / BYOK only when keys configured — short note, not a dump.
  const vault = isOperatorMode() ? readVaultIfOperator(["--vault"]) : {};
  if (vault.HERMES_API_KEY || process.env.HERMES_API_KEY || process.env.MIMO_API_KEY || g.cfg?.byokMimo) {
    out.push({
      id: MIMO_PRO,
      provider: "mimo",
      note: "token plan / BYOK via gateway when configured · not default",
    });
    out.push({
      id: MIMO_FLASH,
      provider: "mimo",
      note: "v2.6 flash · gateway alfred · not default",
    });
    out.push({
      id: GROK_DEFAULT,
      provider: "xai",
      note: "Grok 4.7 · gateway alfred · not default",
    });
  }
  if (g.cfg?.byokOpenAi || process.env.OPENAI_API_KEY) {
    out.push({
      id: "openai-compat",
      provider: "byok",
      note: "BYOK OpenAI-compat when key wired · select explicitly",
    });
  }
  return { models: out, active: g.activeModel || MODEL_AUTO, display: g.modelDisplay };
}

function isTransientProviderFail(status, bodyText = "") {
  const s = Number(status) || 0;
  const t = String(bodyText || "").toLowerCase();
  return (
    s === 402 ||
    s === 429 ||
    s === 503 ||
    s === 502 ||
    /quota|credit|billing|rate.?limit|insufficient|exhausted|capacity|overloaded|no credits/i.test(t)
  );
}

/**
 * Go Max Al! external path: MiMo OR Grok via AI Gateway alfred.
 * Vision never falls back to text-only Workers AI — on MiMo burn-out → Grok 4.7 multimodal.
 */
async function chatGatewayExternal(messages, { model, maxTokens = 256 } = {}) {
  const g = resolveGateway();
  if (!g.accountId || !(g.token || g.inferenceToken)) {
    throw new Error("not wired for gateway external — /login first (gateway alfred)");
  }
  const requested = String(model || "").trim();
  const vision = messageHasVision(messages);
  let outbound = messages;
  if (vision) {
    try {
      const prepped = await prepareMessagesVisionCf(messages);
      outbound = prepped.messages;
      if (prepped.meta?.prepared || prepped.meta?.skipped) {
        console.error(
          `[alfred-pi] cf-images visionprep prepared=${prepped.meta.prepared} skipped=${prepped.meta.skipped}`,
        );
      }
    } catch (err) {
      console.error(
        "[alfred-pi] cf-images visionprep error (continuing):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  let useModel = requested;
  if (isGrokModel(useModel)) {
    /* keep grok */
  } else if (isMimoModel(useModel)) {
    /* keep mimo */
  } else {
    useModel = vision ? MIMO_VISION : MIMO_PRO;
  }

  const attempts = [];
  if (isGrokModel(useModel)) {
    attempts.push({ kind: "grok", model: useModel });
  } else {
    attempts.push({ kind: "mimo", model: useModel });
    if (vision) attempts.push({ kind: "grok", model: GROK_VISION });
    else attempts.push({ kind: "workers-ai", model: DEFAULT_CONCRETE_MODEL });
  }

  const bearer = g.token || g.inferenceToken;
  const url = `${gatewayUrl(g.accountId, g.gatewayId || PRODUCT_GATEWAY)}compat/chat/completions`;
  const errors = [];

  for (const attempt of attempts) {
    if (attempt.kind === "workers-ai") {
      const { ok, status, data: w } = await cfApi("/ai/v1/chat/completions", {
        method: "POST",
        body: {
          model: attempt.model,
          messages: outbound,
          max_tokens: Math.min(maxTokens, 64),
          stream: false,
        },
      });
      if (!ok) {
        errors.push(`workers-ai ${status}`);
        continue;
      }
      const content = w?.choices?.[0]?.message?.content || w?.result?.response || "";
      const usage = w?.usage || {};
      return {
        content: String(content || "").trim(),
        model: w?.model || attempt.model,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          neurons: typeof usage.neurons === "number" ? usage.neurons : null,
        },
        fallback: true,
      };
    }

    const gwModel =
      attempt.kind === "mimo" ? `custom-mimo/${attempt.model}` : `custom-xai/${attempt.model}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "cf-aig-authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "cf-aig-request-timeout": "30000",
        "cf-aig-max-attempts": "2",
      },
      body: JSON.stringify({
        model: gwModel,
        messages: outbound,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (res.ok) {
      const content = data?.choices?.[0]?.message?.content || "";
      const usage = data?.usage || {};
      return {
        content: String(content || "").trim(),
        model: data?.model || attempt.model,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          neurons: null,
        },
        fallback: attempt.model !== useModel,
      };
    }
    const errMsg = data?.error?.message || data?.raw || text.slice(0, 200);
    errors.push(`${attempt.kind} ${res.status}: ${errMsg}`);
    if (!isTransientProviderFail(res.status, errMsg) && attempt.kind === "mimo" && !vision) {
      break;
    }
  }
  throw new Error(`gateway external exhausted: ${errors.join(" | ")}`);
}

/** @deprecated name kept for callers — routes MiMo/Grok with vision-safe fallback */
async function chatMimoGateway(messages, opts = {}) {
  return chatGatewayExternal(messages, opts);
}

async function chatWorkersAI(messages, { model, maxTokens = 64 } = {}) {
  const g = resolveGateway();
  if (!g.inferenceToken || !g.accountId) {
    herdrReportAgent("blocked", "need login");
    throw new Error("not wired for inference — run /login");
  }
  herdrReportAgent("working");
  try {
    const requested = model || g.activeModel || DEFAULT_MODEL;
    let useModel = resolveConcreteModel(requested, { messages, maxTokens });
    if (messageHasVision(messages) && !isMimoModel(useModel) && !isGrokModel(useModel)) {
      useModel = MIMO_VISION;
    }
    if (isGatewayExternalModel(useModel)) {
      return await chatGatewayExternal(messages, { model: useModel, maxTokens });
    }
    const { ok, status, data } = await cfApi("/ai/v1/chat/completions", {
      method: "POST",
      body: {
        model: useModel,
        messages,
        max_tokens: maxTokens,
        stream: false,
      },
    });
    if (!ok) {
      const err =
        data?.errors?.[0]?.message || data?.error?.message || data?.raw || JSON.stringify(data).slice(0, 200);
      throw new Error(`Workers AI ${status}: ${err}`);
    }
    const content =
      data?.choices?.[0]?.message?.content ||
      data?.result?.response ||
      data?.result?.choices?.[0]?.message?.content ||
      "";
    const usage = data?.usage || data?.result?.usage || {};
    return {
      content: String(content || "").trim(),
      model: data?.model || useModel,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        neurons: typeof usage.neurons === "number" ? usage.neurons : null,
      },
    };
  } finally {
    if (_herdrLastState === "working") herdrReportAgent("idle");
  }
}

/** /usage and /map — gateway standings map (same view). */
async function fetchUsageSummary() {
  return fetchMapView();
}

async function fetchMapView() {
  const g = resolveGateway();
  const { models } = await listGatewayModels();
  const lines = [];
  lines.push(`${C.bold}${C.gold}AI gateway map${C.reset}  ·  /usage = /map`);
  lines.push(`gateway: ${g.gatewayId}  account: ${g.accountId || "(missing)"}`);
  lines.push(
    `wired: ${g.wired ? "yes" : "no"}  mode: ${g.modelDisplay}  stored: ${g.activeModel || MODEL_AUTO}`,
  );
  if (g.maxPlans) {
    lines.push(`plans: Max/token/BYOK detected → Alfred-auto elevates to ${GO_MAX_DISPLAY}`);
  } else {
    lines.push("plans: Workers AI free-first (wire Max/token/BYOK keys to elevate Alfred-auto → Go Max Al!)");
  }
  lines.push("");
  lines.push(`${C.muted}models / providers (curated)${C.reset}`);
  for (const m of models) {
    const mark = m.id === g.activeModel || (isAutoModelId(g.activeModel) && m.id === MODEL_AUTO) ? "*" : " ";
    const name = m.label || m.id;
    lines.push(` ${mark} ${name}  [${m.provider}]${m.note ? `  — ${m.note}` : ""}`);
  }
  lines.push("");
  try {
    const { ok, data } = await cfApi(`/ai-gateway/gateways/${g.gatewayId || PRODUCT_GATEWAY}/logs?per_page=50`);
    if (!ok) {
      lines.push(`logs API: HTTP error — meter at CF dashboard / AI Gateway → ${g.gatewayId}`);
      lines.push("pace estimate: partial — re-add coin when CF Workers AI free neurons / gateway $ run low (dashboard)");
      return lines.join("\n");
    }
    const rows = data.result || [];
    let tin = 0;
    let tout = 0;
    let cost = 0;
    let okN = 0;
    const t0 = rows.length ? Date.parse(rows[rows.length - 1].created_at || "") : NaN;
    const t1 = rows.length ? Date.parse(rows[0].created_at || "") : NaN;
    for (const r of rows) {
      tin += Number(r.tokens_in || 0);
      tout += Number(r.tokens_out || 0);
      cost += Number(r.cost || 0);
      if (r.status_code === 200) okN++;
    }
    lines.push(`${C.muted}standings (recent gateway logs)${C.reset}`);
    lines.push(`recent logs (last ${rows.length}): ok=${okN}  tokens_in=${tin}  tokens_out=${tout}`);
    lines.push(`estimated cost (gateway window): $${cost.toFixed(6)}`);
    if (rows[0]) {
      lines.push(
        `latest: ${rows[0].model || "?"}  ${rows[0].provider || "?"}  status=${rows[0].status_code}  ${rows[0].created_at || ""}`,
      );
    }
    const hours =
      Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? (t1 - t0) / 3_600_000 : null;
    if (hours && hours > 0.05 && tin + tout > 0) {
      const tokPerHour = (tin + tout) / hours;
      const costPerHour = cost / hours;
      lines.push(
        `pace (honest from last ${rows.length} logs ≈ ${hours.toFixed(2)}h): ~${Math.round(tokPerHour)} tok/h · ~$${costPerHour.toFixed(4)}/h`,
      );
      if (costPerHour > 0) {
        const hoursOn1 = 1 / costPerHour;
        lines.push(
          `coin hint: ~$1 at this pace lasts ~${hoursOn1.toFixed(1)}h — re-add when gateway $ / free neurons thin`,
        );
      } else {
        lines.push(
          "coin hint: window cost ≈ $0 (Workers AI free / unmetered in logs) — re-add coin when free neurons exhaust (CF dashboard)",
        );
      }
    } else {
      lines.push(
        "pace estimate: partial (need more gateway logs with timestamps) — check CF dashboard → Workers AI / AI Gateway",
      );
    }
    lines.push(
      "remaining free neurons: not exposed on this API — honest unknown; use CF dashboard for exact leftover",
    );
  } catch (e) {
    lines.push(`usage probe failed: ${e.message}`);
    lines.push("meter at CF dashboard / AI Gateway (alfred profile)");
    lines.push("pace / coin: unavailable without logs — estimates honest-partial");
  }
  return lines.join("\n");
}


/** Normalize REPL line for wake / product-phrase matching. */
function normalizeWakeInput(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.…]+$/g, "")
    .replace(/[^\w.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Local wake / product phrases — handle WITHOUT model inference.
 * Matches exactly or mainly: wake, alfred report, alfred pi, Alfred.report!
 */
function isLocalWakeCommand(raw) {
  const n = normalizeWakeInput(raw);
  if (!n) return false;
  const exact = new Set([
    "wake",
    "alfred",
    "alfred.report",
    "alfred report",
    "alfred pi",
    "alfred-pi",
    "alfred.report!",
  ]);
  if (exact.has(n) || exact.has(n.replace(/!+$/, ""))) return true;
  // Mainly wake: optional soft filler around the product phrase.
  if (
    /^(hey |ok |okay |please |yo )?(alfred([. ]?report|[- ]?pi)?|wake)( please| now)?$/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

function handleLocalWakeCommand(raw) {
  const g = resolveGateway();
  console.log(`${WAKE} ready — local harness (no inference)`);
  console.log(
    `  gateway: ${g.gatewayId || PRODUCT_GATEWAY}  wired=${g.wired || g.inferenceToken ? "yes" : "no"}  model=${g.modelDisplay || g.activeModel}`,
  );
  console.log(`  wake ok: "${raw.trim()}" is a local command — type /help or chat normally`);
  printReplHelp();
}

function printReplHelp() {
  console.log(`slash: /model /usage /map /resume /mission /rename /login /logout /menu /exit /help`);
  console.log(`chat:  type / for inline slash · or type normally (Workers AI · ${DEFAULT_MODEL} · tiny max_tokens)`);
}

async function runRepl(initialSlug) {
  let g = resolveGateway();
  console.log(WAKE);
  printStatus({
    mode: initialSlug ? `repl resume:${initialSlug}` : "repl (interactive)",
    slug: initialSlug || undefined,
    inferenceIdle: true,
  });
  if (!g.wired && !g.inferenceToken) {
    console.log("  tip: /login to sign in via alfred.report (paste your CF AI Gateway token)");
  }

  let session;
  if (initialSlug) {
    if (!kebabOk(initialSlug)) {
      console.error(`slug must be kebab-case (got ${initialSlug}). No mb- prefix.`);
      process.exitCode = 2;
      return;
    }
    session = loadSession(initialSlug) || newSession(initialSlug);
    console.log(`Resume slug: ${session.slug}  msgs=${session.messages.length}`);
  } else {
    const slug = uniqueMissionSlug(timestampMeatSlug());
    session = newSession(slug);
    console.log(`Mission: ${session.slug}`);
  }

  printReplHelp();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: alfredPrompt(),
  });

  const close = () => {
    try {
      saveSession(session);
    } catch {
      /* ignore */
    }
    rl.close();
  };

  rl.prompt();

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) {
      rl.prompt();
      continue;
    }

    if (raw.startsWith("/")) {
      const parts = raw.split(/\s+/);
      const cmd = normalizeSlashCmd(parts[0]);
      const arg = parts.slice(1).join(" ").trim();

      if (cmd === "/exit") {
        try {
          saveSession(session);
        } catch {
          /* ignore */
        }
        close();
        restoreTerminal(false);
        printShellNextSteps(session);
        console.log(`${WAKE} Until next time, sir.`);
        process.exit(0);
      }
      if (cmd === "/help") {
        process.stdout.write(usage());
        printReplHelp();
        rl.prompt();
        continue;
      }
      if (cmd === "/menu") {
        console.log("(REPL has no TUI menu — /exit then alfred pi, or use Chat slash)");
        rl.prompt();
        continue;
      }
      if (cmd === "/login") {
        await cmdLogin();
        g = resolveGateway();
        rl.prompt();
        continue;
      }
      if (cmd === "/logout") {
        cmdLogout();
        g = resolveGateway();
        rl.prompt();
        continue;
      }
      if (cmd === "/usage") {
        console.log(await fetchUsageSummary());
        const u = session.usage;
        console.log(
          `this mission: calls=${u.calls} tokens=${u.totalTokens} neurons=${u.neurons || 0}`,
        );
        rl.prompt();
        continue;
      }
      if (cmd === "/models") {
        const { models, active } = await listGatewayModels();
        if (!arg) {
          console.log(`${C.muted}Model ladder (type /model <n|id> to switch · Alfred-auto default)${C.reset}`);
          models.forEach((m, i) => {
            const mark =
              m.id === active || (isAutoModelId(active) && m.id === MODEL_AUTO)
                ? `${C.gold}*${C.reset}`
                : " ";
            const name = m.label || m.id;
            const note = m.note ? `  ${C.goldDim}${m.note}${C.reset}` : "";
            console.log(
              `${mark} ${C.muted}${String(i + 1).padStart(2)}${C.reset}  ${C.fg}${name}${C.reset}${name !== m.id ? ` ${C.muted}(${m.id})${C.reset}` : ""}  ${C.muted}[${m.provider}]${C.reset}${note}`,
            );
          });
          console.log(`active: ${C.gold}${modelDisplayName(active)}${C.reset}  stored=${active}`);
          console.log("switch: /model <n|id>  · Alfred-auto default · Go Max Al! when Max/token wired");
        } else {
          let pick = null;
          if (/^\d+$/.test(arg)) {
            pick = models[Number(arg) - 1];
          } else {
            pick = models.find((m) => m.id === arg) || { id: arg, provider: arg.startsWith("@cf/") ? "workers-ai" : "unknown" };
          }
          if (!pick?.id) {
            console.log("unknown model");
          } else {
            writeCfg({ activeModel: pick.id });
            session.model = pick.id;
            saveSession(session);
            console.log(`active model → ${pick.id}  ${isMimoModel(pick.id) ? "(gateway alfred MIMO)" : ""}`.trim());
          }
        }
        rl.prompt();
        continue;
      }
      if (cmd === "/resume") {
        let slug = arg;
        if (!slug) {
          slug = resolveGateway().lastSlug || listLocalSlugs().slice(-1)[0] || "";
        }
        if (!slug) {
          console.log("no prior mission — /resume or pick from the list");
          rl.prompt();
          continue;
        }
        if (!kebabOk(slug)) {
          console.log(`slug must be kebab-case (got ${slug}). No mb- prefix.`);
          rl.prompt();
          continue;
        }
        session = loadSession(slug) || newSession(slug);
        if (session.model) writeCfg({ activeModel: session.model });
        writeCfg({ lastSlug: session.slug });
        console.log(`loaded ${humanMissionName(session)}  msgs=${session.messages.length}`);
        for (const m of (session.messages || []).slice(-8)) {
          const who = m.role === "user" ? "you" : "alfred";
          console.log(`  ${who}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 100)}`);
        }
        rl.prompt();
        continue;
      }
      if (cmd === "/rename") {
        session = renameMission(session, arg);
        console.log(`renamed → ${humanMissionName(session)}`);
        rl.prompt();
        continue;
      }
      console.log(`unknown command ${parts[0]} — /help or type / in Chat for popup`);
      rl.prompt();
      continue;
    }

    // Local wake / product phrases — never send to the model.
    if (isLocalWakeCommand(raw)) {
      handleLocalWakeCommand(raw);
      rl.prompt();
      continue;
    }

    // Chat turn — Workers AI only, tiny completion budget.
    g = resolveGateway();
    if (!g.inferenceToken) {
      console.log("not wired — /login first");
      rl.prompt();
      continue;
    }
    session = maybeRenameMissionFromPrompt(session, raw);
    session.messages.push({ role: "user", content: raw });
    try {
      process.stdout.write("… ");
      const result = await chatWorkersAI(
        [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          ...session.messages.slice(-12),
        ],
        { model: session.model || g.activeModel, maxTokens: 64 },
      );
      process.stdout.write("\r");
      console.log(result.content || "(empty)");
      session.messages.push({ role: "assistant", content: result.content || "" });
      session.model = result.model;
      session.updatedAt = new Date().toISOString();
      session.usage.promptTokens += result.usage.promptTokens;
      session.usage.completionTokens += result.usage.completionTokens;
      session.usage.totalTokens += result.usage.totalTokens;
      if (result.usage.neurons != null) session.usage.neurons += result.usage.neurons;
      session.usage.calls += 1;
      saveSession(session);
      if (result.usage.neurons != null) {
        console.log(
          `  [${result.model}  tokens=${result.usage.totalTokens}  neurons=${result.usage.neurons.toFixed(4)}]`,
        );
      } else {
        console.log(`  [${result.model}  tokens=${result.usage.totalTokens}]`);
      }
    } catch (e) {
      process.stdout.write("\r");
      console.log(`error: ${e.message}`);
      session.messages.pop();
    }
    rl.prompt();
  }
}

/** --- KISS fullscreen TUI (zero deps: ANSI + raw stdin) --- */

/** Board palette — alfred.report (black + gold). */
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gold: "\x1b[38;2;201;162;39m", // #c9a227
  goldDim: "\x1b[38;2;138;112;24m", // #8a7018
  fg: "\x1b[38;2;236;234;228m", // #eceae4
  muted: "\x1b[38;2;154;149;140m", // #9a958c
  border: "\x1b[38;2;42;42;42m", // #2a2a2a
  paper: "\x1b[38;2;243;240;232m", // #f3f0e8
  white: "\x1b[38;2;255;255;255m", // OpenRoyle segment
  cream: "\x1b[38;2;239;234;219m", // #efeadb logo cream
  bg: "\x1b[48;2;10;10;10m", // #0a0a0a
};


/** --- Herdr agent status (same pattern as mimo-herdr / pane.report_agent) --- */
const HERDR_AGENT = "alfred";
const HERDR_SOURCE = "herdr:alfred";
let _herdrSeq = 0;
let _herdrLastState = "";

/**
 * Report alfred as a Herdr agent so `herdr agent list` shows working/blocked/idle.
 * Uses CLI when available; falls back to socat JSON-RPC like mimo-herdr.
 * No-op outside Herdr panes.
 */
function herdrReportAgent(state, message = "") {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  const st = String(state || "idle");
  if (st === _herdrLastState && !message) return;
  _herdrLastState = st;
  _herdrSeq += 1;
  const seq = Date.now() * 1000 + (_herdrSeq % 1000);
  const msgArgs = message ? ["--message", String(message).slice(0, 120)] : [];
  try {
    const r = spawnSync(
      process.env.HERDR_BIN_PATH || "herdr",
      ["pane", "report-agent", pane, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT, "--state", st, "--seq", String(seq), ...msgArgs],
      { stdio: "ignore", timeout: 800 },
    );
    if (r.status === 0) return;
  } catch {
    /* fall through */
  }
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) return;
  try {
    const req = JSON.stringify({
      id: `herdr:alfred:${seq}`,
      method: "pane.report_agent",
      params: { pane_id: pane, source: HERDR_SOURCE, agent: HERDR_AGENT, state: st, seq, ...(message ? { message: String(message).slice(0, 120) } : {}) },
    });
    spawnSync("socat", ["-", `UNIX-CONNECT:${sock}`], {
      input: req + "\n",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 800,
    });
  } catch {
    /* ignore */
  }
}

function herdrReleaseAgent() {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  try {
    spawnSync(
      process.env.HERDR_BIN_PATH || "herdr",
      ["pane", "release-agent", pane, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT],
      { stdio: "ignore", timeout: 800 },
    );
  } catch {
    /* ignore */
  }
  _herdrLastState = "";
}

/**
 * Logo wordmark: Al gold · fred cream · . gold (baseline) · report cream · ! gold.
 * Matches alfred.report homepage mark (gold Al, baseline ., gold !).
 * Prose / labels / prompt: ASCII only — never mathematical sans-serif glyphs (Apfred bug).
 * Straight-stem l lives ONLY in pixel/block splash glyphs (WM_GLYPHS).
 * Commands / WAKE stay ASCII "Alfred".
 */

function brandWordmark(big = false) {
  // Explicit A + l (both gold) so terminals never substitute a curly/exotic l.
  const al = `${C.bold}${C.gold}A${C.reset}${C.bold}${C.gold}l${C.reset}`;
  const fred = `${C.cream}fred${C.reset}`;
  const dot = `${C.bold}${C.gold}.${C.reset}`;
  const report = `${C.cream}report${C.reset}`;
  const bang = `${C.bold}${C.gold}!${C.reset}`;
  const mark = `${al}${fred}${dot}${report}${bang}`;
  return big ? mark : mark;
}

/** alfred-pi label — gold A+l (ASCII) + cream fred-pi. */
function alfredPiLabel() {
  return `${C.bold}${C.gold}A${C.reset}${C.bold}${C.gold}l${C.reset}${C.cream}fred-pi${C.reset}`;
}

/** Alfred> prompt — ASCII only: gold A, gold l, cream fred, plain >. No exotic Unicode. */
function alfredPrompt() {
  return `${C.bold}${C.gold}A${C.reset}${C.bold}${C.gold}l${C.reset}${C.cream}fred${C.reset}${C.fg}>${C.reset} `;
}

/** Corner: OpenRoyleAl — white OpenRoyle + gold Al (matches alfred.report footer). */
function cornerOpenRoyleAl() {
  return `${C.white || C.fg}OpenRoyle${C.reset}${C.bold}${C.gold}A${C.reset}${C.bold}${C.gold}l${C.reset}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Segment color index into Alfred.report! */
function wordmarkSegColor(i) {
  if (i < 2) return `${C.bold}${C.gold}`; // Al
  if (i < 6) return C.cream; // fred
  if (i === 6) return `${C.bold}${C.gold}`; // .
  if (i < 13) return C.cream; // report
  return `${C.bold}${C.gold}`; // !
}

/**
 * MASSIVE block glyphs. `l` = pure vertical stem (never L-foot).
 * Huge = 7×5 (wide terminals); compact = 5×4.
 */
const WM_GLYPHS_HUGE = {
  A: ["  ██  ", " █  █ ", "█    █", "██████", "█    █", "█    █", "█    █"],
  l: [" █    ", " █    ", " █    ", " █    ", " █    ", " █    ", " █    "],
  f: ["██████", "█     ", "█     ", "████  ", "█     ", "█     ", "█     "],
  r: ["█████ ", "█    █", "█    █", "█████ ", "█  █  ", "█   █ ", "█    █"],
  e: ["██████", "█     ", "█     ", "█████ ", "█     ", "█     ", "██████"],
  d: ["█████ ", "█    █", "█    █", "█    █", "█    █", "█    █", "█████ "],
  ".": ["      ", "      ", "      ", "      ", "      ", "  ██  ", "  ██  "],
  p: ["█████ ", "█    █", "█    █", "█████ ", "█     ", "█     ", "█     "],
  o: [" ████ ", "█    █", "█    █", "█    █", "█    █", "█    █", " ████ "],
  t: ["██████", "  ██  ", "  ██  ", "  ██  ", "  ██  ", "  ██  ", "  ██  "],
  "!": ["  ██  ", "  ██  ", "  ██  ", "  ██  ", "  ██  ", "      ", "  ██  "],
  " ": ["      ", "      ", "      ", "      ", "      ", "      ", "      "],
};

const WM_GLYPHS = {
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  l: [" █  ", " █  ", " █  ", " █  ", " █  "],
  f: ["████", "█   ", "███ ", "█   ", "█   "],
  r: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  e: ["████", "█   ", "███ ", "█   ", "████"],
  d: ["███ ", "█  █", "█  █", "█  █", "███ "],
  ".": ["    ", "    ", "    ", " ██ ", " ██ "],
  p: ["███ ", "█  █", "███ ", "█   ", "█   "],
  o: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  t: ["████", " ██ ", " ██ ", " ██ ", " ██ "],
  "!": [" ██ ", " ██ ", " ██ ", "    ", " ██ "],
  " ": ["    ", "    ", "    ", "    ", "    "],
};

/**
 * MASSIVE Alfred.report! + diamond flanks + underline (same width as full mark).
 * Picks huge glyphs when terminal is wide enough.
 */
function splashWordmarkRows(cols = 80) {
  // Homepage-pretty: big clear block mark, letter gaps, gold Al / . / ! — no diamond junk.
  const chars = "Alfred.report!".split("");
  const useHuge = cols >= 100;
  const glyphs = useHuge ? WM_GLYPHS_HUGE : WM_GLYPHS;
  const h = useHuge ? 7 : 5;
  const gap = useHuge ? "  " : " ";
  const rows = Array.from({ length: h }, () => "");
  for (let i = 0; i < chars.length; i++) {
    const g = glyphs[chars[i]] || glyphs[" "];
    const color = wordmarkSegColor(i);
    for (let r = 0; r < h; r++) {
      rows[r] += `${color}${g[r]}${C.reset}${gap}`;
    }
  }
  const trimmed = rows.map((r) => r.trimEnd());
  const fullW = ansiPlainLen(trimmed[0]);
  // subtle gold rule under mark (site baseline weight)
  const rule = `${C.gold}${"━".repeat(Math.max(12, Math.min(fullW, cols - 4)))}${C.reset}`;
  return [...trimmed, "", rule];
}

function ansiPlainLen(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function centerAnsi(s, width) {
  const len = ansiPlainLen(s);
  const pad = Math.max(0, Math.floor((width - len) / 2));
  return " ".repeat(pad) + s;
}

/** Denser diamond/star field (deterministic, calm). */
function splashStarField(cols, rows) {
  // Calm star field — sparse gold accents like alfred.report night sky, not dense soup.
  const field = Array.from({ length: rows }, () => Array(cols).fill(" "));
  const accents = ["·", "✦", "·", "✧", "·", "·", "✦", "·"];
  const spots = [
    [0, 8], [0, 28], [0, 52], [0, 76],
    [1, 18], [1, 44], [1, 68],
    [2, 6], [2, 36], [2, 60], [2, 88],
    [3, 22], [3, 50], [3, 74],
    [4, 12], [4, 40], [4, 66],
    [5, 30], [5, 58], [5, 82],
    [6, 4], [6, 24], [6, 48], [6, 72],
    [7, 16], [7, 42], [7, 64], [7, 90],
    [8, 10], [8, 34], [8, 56], [8, 80],
    [9, 20], [9, 46], [9, 70],
    [10, 8], [10, 38], [10, 62], [10, 86],
    [11, 26], [11, 54], [11, 78],
  ];
  for (let i = 0; i < spots.length; i++) {
    const [ry, cx] = spots[i];
    if (ry >= rows || cx >= cols) continue;
    field[ry][cx] = accents[i % accents.length];
  }
  return field.map((row) => `${C.goldDim}${row.join("")}${C.reset}`);
}

/**
 * Splash home — MASSIVE wordmark is the hero; minimal chrome under it (KISS).
 */
async function paintSplashHome({ animate = false } = {}) {
  if (!process.stdout.isTTY) return;

  const g = resolveGateway();
  const loggedIn = Boolean(g.wired || g.inferenceToken);
  const wired = loggedIn ? "READY" : "NEED LOGIN";
  const cols = Math.max(60, Math.min(process.stdout.columns || 80, 120));
  const rows = Math.max(22, Math.min(process.stdout.rows || 28, 48));

  process.stdout.write(`${C.bg}\x1b[2J\x1b[H`);
  tuiHideCursor();

  // Night-sky stars (site-like dark #070708 via C.bg)
  const starH = Math.min(12, Math.max(8, rows - 14));
  const stars = splashStarField(cols, starH);
  for (const line of stars) process.stdout.write(line + "\n");
  process.stdout.write("\x1b[H");

  // Top-right OpenRoyleAl (homepage footer brand)
  const corner = cornerOpenRoyleAl();
  const cornerPad = Math.max(0, cols - ansiPlainLen(corner) - 1);
  process.stdout.write(`${C.bg}${" ".repeat(cornerPad)}${corner}\n\n`);

  // Hero: big Alfred.report! (gold Al · baseline . · gold !)
  const wordRows = splashWordmarkRows(cols);
  // push mark toward vertical center
  const padTop = Math.max(0, Math.floor((rows - wordRows.length - 8) / 3));
  for (let i = 0; i < padTop; i++) process.stdout.write("\n");
  for (const row of wordRows) {
    process.stdout.write(centerAnsi(row, cols) + "\n");
    if (animate) await sleep(10);
  }

  // Site lede under mark
  process.stdout.write("\n");
  process.stdout.write(
    centerAnsi(`${C.muted}Done. Done right. What's next.${C.reset}`, cols) + "\n",
  );
  process.stdout.write("\n");

  // KISS chrome: nothing dense. Until login — one quiet tip. Logged in — elevate only then.
  if (!loggedIn) {
    process.stdout.write(
      centerAnsi(`${C.dim}${C.muted}/login · type / · Esc menu${C.reset}`, cols) + "\n",
    );
  } else {
    const mode = g.modelDisplay || modelDisplayName(g.activeModel || DEFAULT_MODEL, {
      cfg: g.cfg || {},
      fileEnv: g.fileEnv || {},
      operator: g.operator,
      loggedIn: true,
    });
    process.stdout.write(
      centerAnsi(
        `${C.muted}${mode}${C.reset}${C.dim}${C.muted} · / · Esc menu${C.reset}`,
        cols,
      ) + "\n",
    );
  }
  herdrReportAgent(wired === "NEED LOGIN" ? "blocked" : "idle");
}

/** First paint helper — paints home splash; does not sleep-then-clear to menu. */
async function showBootSplash({ skip = false, animate = true } = {}) {
  if (skip || process.env.ALFRED_PI_NO_SPLASH === "1") return;
  await paintSplashHome({ animate });
}

/**
 * Persistent splash home loop tick — stays until user acts (MiMo CODE-like).
 * @returns {{type:"chat",seed?:string}|{type:"menu"}|{type:"exit"}|{type:"slash",cmd:string}}
 */
async function runSplashHome(_session, { animate = false } = {}) {
  await paintSplashHome({ animate });
  const prompt = alfredPrompt();
  let line;
  try {
    line = await tuiReadLine(prompt, {
      slashMenu: true,
      escBack: true,
      menuKey: true, // Ctrl+P → menu
    });
  } catch (e) {
    if (e.message === "__tui_exit__") return { type: "exit" };
    throw e;
  }
  if (line === "esc" || line === "menu") return { type: "menu" };
  const raw = String(line ?? "").trim();
  if (!raw) return { type: "chat" }; // bare Enter → chat
  if (raw === "/exit" || raw === "/quit") return { type: "exit" };
  if (raw === "/menu") return { type: "menu" };
  if (raw.startsWith("/")) return { type: "slash", cmd: raw };
  return { type: "chat", seed: raw };
}




const TUI_MENU = [
  { id: "chat", label: "Chat / prompt" },
  { id: "models", label: "Change model" },
  { id: "resume", label: "Resume mission" },
  { id: "usage", label: "Usage / map" },
  { id: "auth", label: "Login" },
  { id: "repl", label: "Text REPL (Alfred>)" },
  { id: "help", label: "Help" },
  { id: "exit", label: "Exit" },
];

/** Inline `/` slash catalog — Alfred-relevant, wired (aliases labeled). /usage = /map. */
const SLASH_COMMANDS = [
  // One slash only in the menu: /model. /models stays a silent alias (normalizeSlashCmd).
  { cmd: "/model", desc: "list / switch ladder (Alfred-auto default · Go Max when Max/token wired)" },
  { cmd: "/usage", desc: "gateway map — standings, models, pace / coin" },
  { cmd: "/map", desc: "alias → /usage (same map view)" },
  { cmd: "/resume", desc: "resume mission" },
  { cmd: "/mission", desc: "alias → /resume" },
  { cmd: "/rename", desc: "rename current mission" },
  { cmd: "/login", desc: "sign in via alfred.report" },
  { cmd: "/logout", desc: "clear local gateway tokens" },
  { cmd: "/help", desc: "show help" },
  { cmd: "/menu", desc: "back to splash home / menu" },
  { cmd: "/exit", desc: "quit alfred-pi" },
];

function filterSlashCommands(typed) {
  const raw = String(typed || "/");
  const q = raw.startsWith("/") ? raw.slice(1).toLowerCase() : raw.toLowerCase();
  if (!q) return SLASH_COMMANDS.slice();
  return SLASH_COMMANDS.filter((c) => {
    const name = c.cmd.slice(1).toLowerCase();
    return name.startsWith(q) || c.desc.toLowerCase().includes(q);
  });
}

/** Normalize slash aliases so handlers stay KISS. */
function normalizeSlashCmd(cmd) {
  const c = String(cmd || "").toLowerCase();
  if (c === "/model") return "/models";
  if (c === "/map") return "/usage";
  if (c === "/mission") return "/resume";
  if (c === "/name") return "/rename";
  if (c === "/quit") return "/exit";
  if (c === "/?") return "/help";
  return c;
}

function tuiClear() {
  // 2J clear screen · 3J clear scrollback · H home — one chrome frame only
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function tuiHideCursor() {
  process.stdout.write("\x1b[?25l");
}

function tuiShowCursor() {
  process.stdout.write("\x1b[?25h");
}

/** Print clear next steps before returning to the user shell. */
function printShellNextSteps(session) {
  const slug =
    (session && session.slug) ||
    (() => {
      try {
        return loadConfig().cfg.lastSlug || null;
      } catch {
        return null;
      }
    })();
  console.log(`${WAKE} back to shell`);
  console.log("  next:");
  if (slug) {
    console.log(`    resume this mission:  alfred report ${slug}`);
    console.log(`    or in TUI later:      /resume ${slug}`);
  } else {
    console.log("    resume a mission:     alfred report <slug>");
    console.log("    or in TUI later:      /resume <slug>");
  }
  console.log("    start new:            alfred pi  /  alfred report");
  console.log("    if staying in TUI:    /menu");
}

/** Restore cooked terminal; drop stdin holds so Node can exit without Ctrl+C. */
function restoreTerminal(wasRaw = false) {
  tuiShowCursor();
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
  } catch {
    /* ignore */
  }
  try {
    process.stdin.removeListener("data", _onStdinKeyData);
    process.stdin.removeAllListeners("data");
  } catch {
    /* ignore */
  }
  _keyQueue.length = 0;
  _keyWaiter = null;
  _keyListening = false;
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
}

/** Tear down TUI/REPL, print next steps, process.exit(0) back to shell. */
function exitToShell(session = null, wasRaw = false) {
  try {
    if (session) saveSession(session);
  } catch {
    /* ignore */
  }
  restoreTerminal(wasRaw);
  try {
    tuiClear();
  } catch {
    /* ignore */
  }
  printShellNextSteps(session);
  console.log(`${WAKE} Until next time, sir.`);
  process.exit(0);
}

function tuiLine(text, width) {
  const s = String(text ?? "");
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length > width) return plain.slice(0, width);
  return s + " ".repeat(Math.max(0, width - plain.length));
}

function tuiBox(lines, { title = "", width } = {}) {
  const cols = Math.max(40, Math.min(width || process.stdout.columns || 80, 100));
  const inner = cols - 2;
  const out = [];
  const titleBit = title ? ` ${title} ` : "";
  const topPad = Math.max(0, inner - ansiPlainLen(titleBit));
  out.push(`┌${titleBit}${"─".repeat(topPad)}┐`);
  for (const line of lines) {
    out.push(`│${tuiLine(line, inner)}│`);
  }
  out.push(`└${"─".repeat(inner)}┘`);
  return out.join("\n");
}

function ansiPlain(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function filterModelItems(items, typed) {
  const q = String(typed || "").trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((it) => {
    const id = String(it.id || "").toLowerCase();
    const note = String(it.note || it.provider || "").toLowerCase();
    const label = String(typeof it === "string" ? it : it.label || "").toLowerCase();
    return id.includes(q) || note.includes(q) || label.includes(q);
  });
}

function ensureSession(initialSlug, { seedText } = {}) {
  if (initialSlug) {
    if (!kebabOk(initialSlug)) {
      throw new Error(`mission slug must be kebab-case (got ${initialSlug}). No mb- / uuid.`);
    }
    return loadSession(initialSlug) || newSession(initialSlug);
  }
  const fromSeed = meatSlugFromText(seedText);
  const slug = uniqueMissionSlug(fromSeed || timestampMeatSlug());
  const title = seedText ? String(seedText).replace(/\s+/g, " ").trim().slice(0, 48) : null;
  return newSession(slug, { title });
}

/** Pending key queue — one stdin chunk may contain many keystrokes (paste /exit). */
const _keyQueue = [];
let _keyWaiter = null;

function _encodeKeyChunk(str) {
  // Split into logical keys: CSI sequences (\x1b[...) or single chars.
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\x1b") {
      if (str[i + 1] === "\x1b") {
        out.push("\x1b\x1b");
        i += 2;
        continue;
      }
      if (str[i + 1] === "[") {
        let j = i + 2;
        while (j < str.length && !/[A-Za-z~]/.test(str[j])) j++;
        if (j < str.length) j++;
        out.push(str.slice(i, j));
        i = j;
        continue;
      }
      if (str[i + 1] === "O") {
        const seq = str.slice(i, Math.min(i + 3, str.length));
        out.push(seq);
        i += seq.length;
        continue;
      }
      out.push("\x1b");
      i += 1;
      continue;
    }
    out.push(str[i]);
    i += 1;
  }
  return out;
}

function _onStdinKeyData(buf) {
  const keys = _encodeKeyChunk(buf.toString("utf8"));
  for (const k of keys) _keyQueue.push(k);
  if (_keyWaiter && _keyQueue.length) {
    const resolve = _keyWaiter;
    _keyWaiter = null;
    resolve(_keyQueue.shift());
  }
}

let _keyListening = false;
function _ensureKeyListener() {
  if (_keyListening) return;
  process.stdin.on("data", _onStdinKeyData);
  _keyListening = true;
}

function readKey() {
  _ensureKeyListener();
  if (_keyQueue.length) return Promise.resolve(_keyQueue.shift());
  return new Promise((resolve) => {
    if (_keyQueue.length) {
      resolve(_keyQueue.shift());
      return;
    }
    _keyWaiter = resolve;
  });
}

/**
 * Inline `/` slash popover — attached above the alfred> prompt (mimo-style).
 * Keeps `/` in the input line; filter as you type; ↑↓ Enter Esc.
 * No separate filter: field · no full-screen takeover modal.
 * Keyboard-only; does not bind Herdr prefix (ctrl+b).
 * @returns {string|null} selected command (e.g. "/models") or null if dismissed
 */
async function tuiSlashInline(promptText, { initial = "/" } = {}) {
  let filter = initial.startsWith("/") ? initial : `/${initial}`;
  let idx = 0;
  let overlayH = 0;

  const eraseOverlayAndPrompt = () => {
    // Cursor is on the prompt line. Clear prompt + overlay lines above.
    process.stdout.write("\r\x1b[2K");
    for (let i = 0; i < overlayH; i++) {
      process.stdout.write("\x1b[1A\r\x1b[2K");
    }
    overlayH = 0;
  };

  const paint = () => {
    const items = filterSlashCommands(filter);
    if (idx >= items.length) idx = Math.max(0, items.length - 1);
    const maxShow = 8;
    let start = 0;
    if (items.length > maxShow) {
      start = Math.max(0, Math.min(idx - Math.floor(maxShow / 2), items.length - maxShow));
    }
    const slice = items.slice(start, start + maxShow);
    const cols = Math.max(36, Math.min(process.stdout.columns || 80, 72));
    const inner = cols - 2;
    const lines = [];
    const title = " slash ";
    const topPad = Math.max(0, inner - title.length);
    lines.push(`${C.border}╭${C.gold}${title}${C.border}${"─".repeat(topPad)}╮${C.reset}`);
    if (!slice.length) {
      lines.push(`${C.border}│${C.reset}${tuiLine(`  ${C.muted}(no match)${C.reset}`, inner)}${C.border}│${C.reset}`);
    } else {
      slice.forEach((it, si) => {
        const i = start + si;
        const on = i === idx;
        const mark = on ? `${C.gold}▶${C.reset}` : " ";
        const cmd = on ? `${C.bold}${C.gold}${it.cmd.padEnd(10)}${C.reset}` : `${C.gold}${it.cmd.padEnd(10)}${C.reset}`;
        const desc = `${C.muted}${it.desc}${C.reset}`;
        const row = ` ${mark} ${cmd} ${desc}`;
        const bg = on ? "\x1b[48;2;42;36;18m" : "";
        const rowReset = on ? C.reset : "";
        lines.push(`${C.border}│${C.reset}${bg}${tuiLine(row, inner)}${rowReset}${C.border}│${C.reset}`);
      });
    }
    if (items.length > maxShow) {
      lines.push(
        `${C.border}│${C.reset}${tuiLine(`  ${C.muted}${start + 1}–${start + slice.length} of ${items.length}${C.reset}`, inner)}${C.border}│${C.reset}`,
      );
    }
    lines.push(
      `${C.border}│${C.reset}${tuiLine(`  ${C.muted}↑↓ Enter · Esc dismiss${C.reset}`, inner)}${C.border}│${C.reset}`,
    );
    lines.push(`${C.border}╰${"─".repeat(inner)}╯${C.reset}`);

    eraseOverlayAndPrompt();
    for (const line of lines) process.stdout.write(line + "\n");
    overlayH = lines.length;
    process.stdout.write(`${promptText}${C.fg}${filter}${C.reset}`);
    tuiShowCursor();
  };

  tuiShowCursor();
  paint();

  while (true) {
    const items = filterSlashCommands(filter);
    const k = await readKey();
    if (k === "\x03") {
      eraseOverlayAndPrompt();
      throw new Error("__tui_exit__");
    }
    if (k === "\x1b" || k === "\x1b\x1b") {
      eraseOverlayAndPrompt();
      process.stdout.write(promptText);
      return null;
    }
    if (k === "\x1b[A") {
      if (items.length) idx = (idx - 1 + items.length) % items.length;
      paint();
      continue;
    }
    if (k === "\x1b[B" || k === "\t") {
      if (items.length) idx = (idx + 1) % items.length;
      paint();
      continue;
    }
    if (k === "\r" || k === "\n") {
      if (!items.length) {
        paint();
        continue;
      }
      eraseOverlayAndPrompt();
      const picked = items[idx].cmd;
      process.stdout.write(`${promptText}${picked}\n`);
      return picked;
    }
    if (k === "\x7f" || k === "\b") {
      if (filter.length > 1) {
        filter = filter.slice(0, -1);
        idx = 0;
        paint();
      } else {
        eraseOverlayAndPrompt();
        process.stdout.write(promptText);
        return null;
      }
      continue;
    }
    if (k.startsWith("\x1b")) continue;
    if (k === "\x02") continue; // Ctrl-B Herdr prefix
    if (k.length === 1 && k >= " ") {
      // space after a full command name → commit that cmd + keep typing? Keep KISS: treat as filter char
      filter += k;
      idx = 0;
      paint();
    }
  }
}

async function tuiReadLine(promptText, opts = {}) {
  tuiShowCursor();
  process.stdout.write(promptText);
  let buf = "";
  while (true) {
    const k = await readKey();
    if (k === "\r" || k === "\n") {
      process.stdout.write("\n");
      tuiHideCursor();
      return buf;
    }
    if (k === "\x03") {
      throw new Error("__tui_exit__");
    }
    if (k === "\x7f" || k === "\b") {
      if (buf.length) {
        buf = buf.slice(0, -1);
        process.stdout.write("\b \b");
      }
      continue;
    }
    // Esc while empty → signal back (splash → menu, chat → splash/menu)
    if (k === "\x1b" && buf.length === 0 && opts.escBack) {
      tuiHideCursor();
      return "esc";
    }
    // Ctrl+P while empty → numbered settings/models menu (splash home)
    if (k === "\x10" && buf.length === 0 && opts.menuKey) {
      tuiHideCursor();
      return "menu";
    }
    if (k.startsWith("\x1b")) {
      continue;
    }
    if (k === "\x02") continue; // Ctrl-B — leave for Herdr
    // mimo-style: typing `/` on empty prompt opens inline slash popover (keeps / in line)
    if (k === "/" && buf.length === 0 && opts.slashMenu) {
      const picked = await tuiSlashInline(promptText, { initial: "/" });
      tuiHideCursor();
      if (picked) return picked;
      // dismissed — stay on prompt (already redrawn empty); continue reading
      buf = "";
      tuiShowCursor();
      continue;
    }
    if (k.length === 1 && k >= " ") {
      buf += k;
      process.stdout.write(k);
    }
  }
}

/**
 * mimo-like searchable select modal (for /model and other lists).
 * Type to filter in-place · ↑↓ · Enter · Esc. Burns zero.
 */
async function tuiSearchPick(title, items, { initial = 0, statusLines = [], getLabel } = {}) {
  const labelOf = (it) => {
    if (getLabel) return getLabel(it);
    if (typeof it === "string") return it;
    return it.label || it.id || String(it);
  };
  if (!items.length) {
    tuiClear();
    console.log(tuiBox([...statusLines, "", "(empty)", "", "Enter / Esc back"], { title }));
    await readKey();
    return null;
  }
  let filter = "";
  let idx = Math.max(0, Math.min(initial, items.length - 1));
  tuiHideCursor();
  while (true) {
    const filtered = filterModelItems(items, filter);
    if (idx >= filtered.length) idx = Math.max(0, filtered.length - 1);
    tuiClear();
    const lines = [...statusLines, ""];
    const maxShow = Math.min(14, Math.max(6, (process.stdout.rows || 24) - 12));
    let start = 0;
    if (filtered.length > maxShow) {
      start = Math.max(0, Math.min(idx - Math.floor(maxShow / 2), filtered.length - maxShow));
    }
    const slice = filtered.slice(start, start + maxShow);
    if (!slice.length) {
      lines.push(`  ${C.muted}(no match)${C.reset}`);
    } else {
      slice.forEach((it, si) => {
        const i = start + si;
        const on = i === idx;
        const mark = on ? `${C.gold}▶${C.reset}` : " ";
        const lab = labelOf(it);
        lines.push(on ? ` ${mark} ${C.bold}${C.fg}${lab}${C.reset}` : ` ${mark} ${lab}`);
      });
    }
    if (filtered.length > maxShow) {
      lines.push("", `  ${C.muted}${start + 1}–${start + slice.length} of ${filtered.length}${C.reset}`);
    }
    lines.push(
      "",
      `  ${C.muted}search${C.reset} ${C.fg}${filter || ""}${C.reset}${C.gold}█${C.reset}`,
      "",
      "↑↓ move · type filter · Enter select · Esc/Backspace-empty back",
    );
    console.log(tuiBox(lines, { title }));
    const k = await readKey();
    if (k === "\x03") return null;
    if (k === "\x1b" || (k === "q" && !filter)) return null;
    if (k === "\x1b[A") {
      if (filtered.length) idx = (idx - 1 + filtered.length) % filtered.length;
      continue;
    }
    if (k === "\x1b[B" || k === "\t") {
      if (filtered.length) idx = (idx + 1) % filtered.length;
      continue;
    }
    if (k === "\r" || k === "\n") {
      if (!filtered.length) continue;
      return filtered[idx];
    }
    if (k === "\x7f" || k === "\b") {
      if (filter.length) {
        filter = filter.slice(0, -1);
        idx = 0;
      } else {
        return null;
      }
      continue;
    }
    if (k.startsWith("\x1b")) continue;
    if (k === "\x02") continue;
    if (k.length === 1 && k >= " ") {
      filter += k;
      idx = 0;
    }
  }
}

async function tuiPickList(title, items, { initial = 0, statusLines = [] } = {}) {
  // Prefer searchable picker (mimo-like) for any list ≥ 6; short menus stay simple.
  if (items.length >= 6) {
    return tuiSearchPick(title, items, { initial, statusLines });
  }
  if (!items.length) {
    tuiClear();
    console.log(tuiBox([...statusLines, "", "(empty)", "", "Enter / q to go back"], { title }));
    await readKey();
    return null;
  }
  let idx = Math.max(0, Math.min(initial, items.length - 1));
  while (true) {
    tuiClear();
    const lines = [...statusLines, ""];
    items.forEach((it, i) => {
      const mark = i === idx ? `${C.gold}▶${C.reset}` : " ";
      const label = typeof it === "string" ? it : it.label;
      lines.push(` ${mark} ${label}`);
    });
    lines.push("", "↑↓ / j k  move · Enter select · Esc/q back");
    console.log(tuiBox(lines, { title }));
    const k = await readKey();
    if (k === "\x1b[A" || k === "k") {
      idx = (idx - 1 + items.length) % items.length;
      continue;
    }
    if (k === "\x1b[B" || k === "j") {
      idx = (idx + 1) % items.length;
      continue;
    }
    if (k === "\r" || k === "\n") return items[idx];
    if (k === "q" || k === "\x1b" || k === "\x03") return null;
    if (k.startsWith("\x1b") && k.length > 1) {
      continue;
    }
  }
}

function tuiStatusLines(session, { thin = false } = {}) {
  const g = resolveGateway();
  const wired = g.wired || g.inferenceToken ? "yes" : "no";
  const wiredTxt = wired === "yes" ? C.gold + "yes" + C.reset : wired;
  if (thin) {
    // One chrome frame for pickers — no nested brand header spam
    return [
      `${alfredPiLabel()} ${C.muted}${VERSION}${C.reset}  ·  gateway ${C.gold}${g.gatewayId || PRODUCT_GATEWAY}${C.reset} wired=${wiredTxt}`,
      `mission: ${C.fg}${humanMissionName(session)}${C.reset}  ·  msgs=${session?.messages?.length ?? 0}`,
    ];
  }
  return [
    `${brandWordmark(true)}  ${alfredPiLabel()} ${C.muted}${VERSION}${C.reset}`,
    `gateway: ${C.gold}${g.gatewayId || PRODUCT_GATEWAY}${C.reset}  wired=${wiredTxt}`,
    `model:   ${g.modelDisplay || g.activeModel}`,
    `mission: ${humanMissionName(session)}  ·  msgs=${session?.messages?.length ?? 0}`,
  ];
}

async function tuiChat(session) {
  while (true) {
    const g = resolveGateway();
    tuiClear();
    const recent = (session.messages || []).slice(-8);
    const body = [
      ...tuiStatusLines(session),
      "",
      "── chat (Esc/q → splash · type / for slash · wake local) ──",
      "",
    ];
    if (!recent.length) body.push("(no messages yet)");
    for (const m of recent) {
      const who = m.role === "user" ? "you" : m.role === "assistant" ? "alfred" : m.role;
      const text = String(m.content || "").replace(/\s+/g, " ").slice(0, 90);
      body.push(`${who}: ${text}`);
    }
    body.push("", "type message then Enter:");
    console.log(tuiBox(body, { title: "Chat" }));
    let line;
    try {
      line = await tuiReadLine(alfredPrompt(), {
        slashMenu: true,
        escBack: true,
        statusLines: tuiStatusLines(session),
      });
    } catch (e) {
      if (e.message === "__tui_exit__") return "exit";
      throw e;
    }
    if (line && typeof line === "object" && line.__slash_dismissed) {
      continue; // redraw chat, re-prompt
    }
    const raw = String(line ?? "").trim();
    if (!raw || raw === "q" || raw === "/back" || raw === "esc") return null;
    if (raw === "/exit" || raw === "/quit") return "exit";
    if (raw === "/menu") return null;
    if (raw.startsWith("/")) {
      const parts = raw.split(/\s+/);
      const cmd = normalizeSlashCmd(parts[0]);
      if (cmd === "/help") {
        tuiClear();
        process.stdout.write(usage());
        printReplHelp();
        process.stdout.write("\n[Enter]");
        await readKey();
        continue;
      }
      if (cmd === "/login") {
        tuiClear();
        await cmdLogin();
        process.stdout.write("\n[Enter]");
        await readKey();
        continue;
      }
      if (cmd === "/logout") {
        tuiClear();
        cmdLogout();
        process.stdout.write("\n[Enter]");
        await readKey();
        continue;
      }
      if (cmd === "/usage") {
        tuiClear();
        console.log(await fetchUsageSummary());
        process.stdout.write("\n[Enter]");
        await readKey();
        continue;
      }
      if (cmd === "/models") {
        await tuiModels(session, parts.slice(1).join(" ").trim());
        continue;
      }
      if (cmd === "/resume") {
        const next = await tuiResume(session, parts.slice(1).join(" ").trim());
        if (next) session = next;
        continue;
      }
      if (cmd === "/rename") {
        session = await tuiRename(session, parts.slice(1).join(" ").trim());
        continue;
      }
      console.log(`unknown ${parts[0]} — type / for slash`);
      await readKey();
      continue;
    }
    if (isLocalWakeCommand(raw)) {
      tuiClear();
      handleLocalWakeCommand(raw);
      process.stdout.write("\n[Enter]");
      await readKey();
      continue;
    }
    if (!g.inferenceToken) {
      console.log("not wired — use Login from menu or /login");
      await readKey();
      continue;
    }
    session = maybeRenameMissionFromPrompt(session, raw);
    session.messages.push({ role: "user", content: raw });
    try {
      process.stdout.write("… ");
      const result = await chatWorkersAI(
        [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          ...session.messages.slice(-12),
        ],
        { model: session.model || g.activeModel, maxTokens: 64 },
      );
      process.stdout.write("\r");
      session.messages.push({ role: "assistant", content: result.content || "" });
      session.model = result.model;
      session.updatedAt = new Date().toISOString();
      session.usage.promptTokens += result.usage.promptTokens;
      session.usage.completionTokens += result.usage.completionTokens;
      session.usage.totalTokens += result.usage.totalTokens;
      if (result.usage.neurons != null) session.usage.neurons += result.usage.neurons;
      session.usage.calls += 1;
      saveSession(session);
    } catch (e) {
      process.stdout.write("\r");
      console.log(`error: ${e.message}`);
      session.messages.pop();
      await readKey();
    }
  }
}

async function tuiModels(session, arg) {
  const { models, active } = await listGatewayModels();
  if (arg) {
    let pick = null;
    if (/^\d+$/.test(arg)) pick = models[Number(arg) - 1];
    else pick = models.find((m) => m.id === arg) || { id: arg };
    if (!pick?.id) {
      console.log("unknown model");
      await readKey();
      return;
    }
    writeCfg({ activeModel: pick.id });
    session.model = pick.id;
    saveSession(session);
    return;
  }
  const items = models.map((m) => {
    const name = m.label || m.id;
    const selected = m.id === active || (isAutoModelId(active) && m.id === MODEL_AUTO);
    return {
      id: m.id,
      provider: m.provider,
      note: m.note || "",
      label:
        `${selected ? `${C.gold}*${C.reset}` : " "} ${C.fg}${name}${C.reset}` +
        (name !== m.id ? ` ${C.muted}(${m.id})${C.reset}` : "") +
        `  ${C.muted}[${m.provider}]${C.reset}` +
        (m.note ? `  ${C.goldDim}${m.note}${C.reset}` : ""),
    };
  });
  const initial = Math.max(
    0,
    models.findIndex((m) => m.id === active || (isAutoModelId(active) && m.id === MODEL_AUTO)),
  );
  const picked = await tuiSearchPick("Select model", items, {
    initial,
    statusLines: [
      ...tuiStatusLines(session, { thin: true }),
      "",
      `${C.muted}Alfred-auto at top · curated Workers AI · Go Max Al! when Max/token wired${C.reset}`,
      `${C.muted}active: ${active}${C.reset}`,
    ],
  });
  if (!picked) return;
  writeCfg({ activeModel: picked.id });
  session.model = picked.id;
  saveSession(session);
}

async function tuiResume(session, arg) {
  migrateLegacySessions();
  if (arg) {
    if (!kebabOk(arg) && !/^msn_[a-z0-9]+$/i.test(arg)) {
      console.log(`mission must be a meat title / slug (got ${arg})`);
      await readKey();
      return null;
    }
    let next = kebabOk(arg) ? loadSession(arg) : null;
    if (!next) {
      const remote = (await fetchRemoteMissions()).find((m) => {
        const title = humanMissionName(m);
        return m.id === arg || meatSlugFromText(title) === arg || String(title).toLowerCase() === arg.toLowerCase();
      });
      if (remote) {
        next = sessionFromRemoteMission(remote);
        saveSession(next);
      }
    }
    next = next || (kebabOk(arg) ? newSession(arg) : null);
    if (!next) {
      console.log("mission not found");
      await readKey();
      return null;
    }
    if (next.model) writeCfg({ activeModel: next.model });
    writeCfg({ lastSlug: next.slug });
    return next;
  }
  const slugs = listLocalSlugs();
  const last = resolveGateway().lastSlug;
  const items = slugs.map((s) => {
    const miss = loadSession(s);
    const title = humanMissionName(miss || { slug: s });
    const n = miss?.messages?.length || 0;
    const tags = [
      s === last ? "last" : "",
      s === session.slug ? "current" : "",
      n ? `${n} msgs` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const tagBit = tags ? `  ${C.muted}(${tags})${C.reset}` : "";
    return {
      id: s,
      kind: "local",
      label: `${C.fg}${title}${C.reset}${tagBit}`,
    };
  });
  try {
    const remote = await fetchRemoteMissions();
    const seen = new Set(items.map((it) => it.id));
    for (const m of remote) {
      const title = humanMissionName(m);
      const meat = meatSlugFromText(title) || m.id;
      if (seen.has(meat) || seen.has(m.id)) continue;
      if (String(m.state || "") === "aborted" && /archiv/i.test(JSON.stringify(m.evidence || []))) continue;
      seen.add(meat);
      items.push({
        id: m.id,
        kind: "remote",
        mission: m,
        label: `${C.fg}${title}${C.reset}  ${C.muted}${m.state || "open"} · ORAL${C.reset}`,
      });
    }
  } catch {
    /* local only */
  }
  if (!items.length) {
    tuiClear();
    console.log("no missions yet — type a message on splash to start one");
    await readKey();
    return null;
  }
  const picked = await tuiPickList("Resume mission", items, {
    initial: Math.max(0, slugs.indexOf(session.slug)),
    statusLines: [
      ...tuiStatusLines(session, { thin: true }),
      "",
      `${C.muted}Pick a mission — chat/history loads. Meat titles only.${C.reset}`,
    ],
  });
  if (!picked) return null;
  let next;
  if (picked.kind === "remote" && picked.mission) {
    next = sessionFromRemoteMission(picked.mission);
    saveSession(next);
  } else {
    next = loadSession(picked.id) || newSession(picked.id);
  }
  if (next.model) writeCfg({ activeModel: next.model });
  writeCfg({ lastSlug: next.slug });
  tuiClear();
  console.log(`${brandWordmark(true)} loaded ${C.gold}${humanMissionName(next)}${C.reset}`);
  console.log(`  ${next.messages.length} message(s) in history`);
  const preview = (next.messages || []).slice(-4);
  for (const m of preview) {
    const who = m.role === "user" ? "you" : "alfred";
    console.log(`  ${C.muted}${who}:${C.reset} ${String(m.content || "").replace(/\s+/g, " ").slice(0, 88)}`);
  }
  return next;
}

async function tuiRename(session, arg) {
  let title = String(arg || "").trim();
  if (!title) {
    tuiClear();
    console.log(tuiBox([...tuiStatusLines(session, { thin: true }), "", "Rename this mission"], { title: "Rename" }));
    try {
      title = await tuiReadLine("title> ", { escBack: true });
    } catch {
      return session;
    }
  }
  title = String(title || "").trim();
  if (!title) return session;
  const next = renameMission(session, title);
  tuiClear();
  console.log(`${brandWordmark(true)} renamed → ${C.gold}${humanMissionName(next)}${C.reset}`);
  return next;
}

function authMenuLabel() {
  const g = resolveGateway();
  return g.wired || g.inferenceToken ? "Log out" : "Login";
}

async function tuiAuth(session) {
  const g = resolveGateway();
  const wired = Boolean(g.wired || g.inferenceToken);
  const items = wired
    ? [
        { id: "logout", label: "Log out — clear local gateway tokens" },
        { id: "open", label: "Open alfred.report Access URL" },
        { id: "login", label: `${C.muted}Login (already wired)${C.reset}` },
        { id: "status", label: "Show status" },
        { id: "back", label: "Back" },
      ]
    : [
        { id: "login", label: "Login — open alfred.report/login (Access first)" },
        { id: "status", label: "Show status" },
        { id: "back", label: "Back" },
      ];
  const picked = await tuiPickList(wired ? "Log out" : "Login", items, {
    statusLines: [
      ...tuiStatusLines(session, { thin: true }),
      wired
        ? `${C.gold}wired${C.reset}  token ${mask(g.inferenceToken)}  ${g.inferenceSource || ""}`
        : "not wired — Access URL then paste token only as fallback (onboarding later)",
      `${C.muted}Multi-tenant CF account linking: later. HAK dogfood first.${C.reset}`,
    ],
  });
  if (!picked || picked.id === "back") return;
  tuiClear();
  if (picked.id === "open" || (picked.id === "login" && wired)) {
    openLoginPage();
    console.log("already wired — paste token only if Access does not finish onboarding.");
  } else if (picked.id === "login") await cmdLogin();
  else if (picked.id === "logout") cmdLogout();
  else printStatus({ mode: "tui" });
  process.stdout.write("\n[Enter]");
  await readKey();
}

async function runTui(initialSlug, opts = {}) {
  herdrReportAgent("working");
  const _herdrExit = () => { herdrReportAgent("idle"); herdrReleaseAgent(); };
  process.once("exit", _herdrExit);
  process.once("SIGINT", () => { _herdrExit(); });

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return runRepl(initialSlug);
  }

  let session;
  try {
    migrateLegacySessions();
    session = ensureSession(initialSlug);
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 2;
    return;
  }

  const skipSplash = Boolean(opts.noSplash) || process.argv.includes("--no-splash");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  tuiHideCursor();

  let menuIdx = 0;
  let running = true;
  let mode = initialSlug ? "chat" : skipSplash ? "menu" : "splash";
  let splashAnimate = !skipSplash; // cascade once, then stay put
  let chatSeed = "";

  /** Soft handoff (e.g. → text REPL): restore cooked mode but keep process alive. */
  const cleanup = () => {
    try {
      saveSession(session);
    } catch {
      /* ignore */
    }
    tuiShowCursor();
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    tuiClear();
  };

  /** /exit · menu Exit · Ctrl+C — must return to shell (no Ctrl+C hang). */
  const quitToShell = () => {
    exitToShell(session, wasRaw);
  };

  /** Numbered settings menu — behind Esc / Ctrl+P, not the default landing. */
  async function runNumberedMenuOnce() {
    tuiClear();
    const lines = [...tuiStatusLines(session), ""];
    TUI_MENU.forEach((item, i) => {
      const mark = i === menuIdx ? "▶" : " ";
      const label = item.id === "auth" ? authMenuLabel() : item.label;
      lines.push(` ${mark} ${i + 1}. ${label}`);
    });
    lines.push("", "↑↓ / j k  move · Enter / 1-8  select · Esc splash · q quit");
    console.log(tuiBox(lines, { title: `${C.gold}Al${C.reset}${C.fg}fred.report!${C.reset} menu` }));

    const k = await readKey();
    if (k === "q" || k === "\x03") return "exit";
    if (k === "\x1b" || k === "\x1b\x1b") return "splash"; // Esc → back to splash home
    if (k === "\x1b[A" || k === "k") {
      menuIdx = (menuIdx - 1 + TUI_MENU.length) % TUI_MENU.length;
      return "menu";
    }
    if (k === "\x1b[B" || k === "j") {
      menuIdx = (menuIdx + 1) % TUI_MENU.length;
      return "menu";
    }
    if (/^[1-8]$/.test(k)) {
      menuIdx = Number(k) - 1;
    } else if (k !== "\r" && k !== "\n") {
      return "menu";
    }

    const choice = TUI_MENU[menuIdx];
    if (!choice) return "menu";

    if (choice.id === "exit") return "exit";
    if (choice.id === "help") {
      tuiClear();
      process.stdout.write(usage());
      printReplHelp();
      console.log("\nTUI: alfred pi / alfred report open splash home. Esc/Ctrl+P → this menu. --repl for text REPL.");
      process.stdout.write("\n[Enter]");
      await readKey();
      return "menu";
    }
    if (choice.id === "repl") {
      cleanup();
      process.stdin.setRawMode(false);
      return runRepl(session.slug).then(() => "__repl_done__");
    }
    if (choice.id === "chat") return "chat";
    if (choice.id === "models") {
      await tuiModels(session);
      return "menu";
    }
    if (choice.id === "resume") {
      const next = await tuiResume(session);
      if (next) {
        session = next;
        return "chat";
      }
      return "menu";
    }
    if (choice.id === "usage") {
      tuiClear();
      console.log(await fetchUsageSummary());
      const u = session.usage;
      console.log(`this mission: calls=${u.calls} tokens=${u.totalTokens} neurons=${u.neurons || 0}`);
      process.stdout.write("\n[Enter]");
      await readKey();
      return "menu";
    }
    if (choice.id === "auth") {
      await tuiAuth(session);
      return "menu";
    }
    return "menu";
  }

  /** Run a slash picked on the splash home (models/usage/login/…). */
  async function runSplashSlash(raw) {
    const parts = String(raw).split(/\s+/);
    const cmd = normalizeSlashCmd(parts[0]);
    if (cmd === "/help") {
      tuiClear();
      process.stdout.write(usage());
      printReplHelp();
      process.stdout.write("\n[Enter]");
      await readKey();
      return;
    }
    if (cmd === "/login") {
      tuiClear();
      await cmdLogin();
      process.stdout.write("\n[Enter]");
      await readKey();
      return;
    }
    if (cmd === "/logout") {
      tuiClear();
      cmdLogout();
      process.stdout.write("\n[Enter]");
      await readKey();
      return;
    }
    if (cmd === "/models" || cmd === "/model") {
      await tuiModels(session);
      return;
    }
    if (cmd === "/usage") {
      tuiClear();
      console.log(await fetchUsageSummary());
      const u = session.usage;
      console.log(`this mission: calls=${u.calls} tokens=${u.totalTokens} neurons=${u.neurons || 0}`);
      process.stdout.write("\n[Enter]");
      await readKey();
      return;
    }
    if (cmd === "/resume" || cmd === "/mission") {
      const next = await tuiResume(session);
      if (next) {
        session = next;
        mode = "chat";
      }
      return;
    }
    if (cmd === "/rename") {
      session = await tuiRename(session, parts.slice(1).join(" ").trim());
      return;
    }
    // unknown slash — open chat so user can see it / retry
    chatSeed = raw;
    mode = "chat";
  }

  try {
    while (running) {
      if (mode === "splash") {
        const act = await runSplashHome(session, { animate: splashAnimate });
        splashAnimate = false; // never re-cascade as a fake boot
        if (act.type === "exit") {
          quitToShell();
        }
        if (act.type === "menu") {
          mode = "menu";
          continue;
        }
        if (act.type === "slash") {
          await runSplashSlash(act.cmd);
          if (mode !== "chat") mode = "splash";
          continue;
        }
        if (act.type === "chat") {
          chatSeed = act.seed || "";
          mode = "chat";
          continue;
        }
        mode = "splash";
        continue;
      }

      if (mode === "chat") {
        // If user typed a message on splash, inject as first turn then continue chat UI
        if (chatSeed) {
          const seed = chatSeed;
          chatSeed = "";
          session = maybeRenameMissionFromPrompt(session, seed);
          const g = resolveGateway();
          tuiClear();
          console.log(tuiBox([...tuiStatusLines(session), "", `you: ${seed}`], { title: "Chat" }));
          if (isLocalWakeCommand(seed)) {
            handleLocalWakeCommand(seed);
            process.stdout.write("\n[Enter]");
            await readKey();
          } else if (!g.inferenceToken) {
            console.log("not wired — /login first (Esc/Ctrl+P menu → Login, or type /login on splash)");
            process.stdout.write("\n[Enter]");
            await readKey();
          } else {
            session.messages.push({ role: "user", content: seed });
            try {
              process.stdout.write("… ");
              const result = await chatWorkersAI(
                [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages.slice(-12)],
                { model: session.model || g.activeModel, maxTokens: 64 },
              );
              process.stdout.write("\r");
              console.log(result.content || "(empty)");
              session.messages.push({ role: "assistant", content: result.content || "" });
              session.model = result.model;
              session.updatedAt = new Date().toISOString();
              session.usage.promptTokens += result.usage.promptTokens;
              session.usage.completionTokens += result.usage.completionTokens;
              session.usage.totalTokens += result.usage.totalTokens;
              if (result.usage.neurons != null) session.usage.neurons += result.usage.neurons;
              session.usage.calls += 1;
              saveSession(session);
            } catch (e) {
              process.stdout.write("\r");
              console.log(`error: ${e.message}`);
              session.messages.pop();
            }
          }
        }
        const r = await tuiChat(session);
        if (r === "exit") {
          quitToShell();
        }
        mode = "splash"; // Esc/q /menu from chat → splash home (not numbered menu)
        continue;
      }

      // mode === "menu"
      const next = await runNumberedMenuOnce();
      if (next === "exit") {
        quitToShell();
      }
      if (next === "__repl_done__") return;
      if (next === "splash") {
        mode = "splash";
        continue;
      }
      if (next === "chat") {
        mode = "chat";
        continue;
      }
      mode = "menu";
    }
  } finally {
    // quitToShell() already process.exit(0). Soft path = REPL handoff / early return.
    tuiShowCursor();
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
    } catch {
      /* ignore */
    }
  }
}

function runWakeSelfTest() {
  const cases = [
    ["alfred report", true],
    ["Alfred.report!", true],
    ["ALFRED PI", true],
    ["wake", true],
    ["hey alfred report", true],
    ["please alfred pi", true],
    ["what is the weather", false],
    ["alfred report status of cluster", false],
  ];
  let fail = 0;
  for (const [input, expect] of cases) {
    const got = isLocalWakeCommand(input);
    const ok = got === expect;
    console.log(`${ok ? "✓" : "✗"} isLocalWakeCommand(${JSON.stringify(input)}) → ${got} (want ${expect})`);
    if (!ok) fail += 1;
  }
  const idChecks = [
    ["wake brand", SYSTEM_PROMPT.includes("Alfred.report!")],
    ["not Alfred Pi person", /NOT .{0,20}Alfred Pi/i.test(SYSTEM_PROMPT)],
    ["package/CLI only", /alfred-pi.{0,40}(package|CLI)/i.test(SYSTEM_PROMPT)],
    ["HAK human", SYSTEM_PROMPT.includes("Hans Alfred Koch")],
    ["no separate Pi person", /not a separate person named Pi/i.test(SYSTEM_PROMPT)],
  ];
  for (const [label, ok] of idChecks) {
    console.log(`${ok ? "✓" : "✗"} identity: ${label}`);
    if (!ok) fail += 1;
  }
  const skills = cloudflareSkillsStatus();
  const skillsChecks = [
    ["skills path is a git checkout", existsSync(join(CLOUDFLARE_SKILLS_DIR, ".git"))],
    ["skills origin is github.com/cloudflare/skills", isCloudflareSkillsRemote(skills.remote)],
    ["skills HEAD is current origin/main", skills.ok && skills.head === skills.originMain],
    [
      "Pi harness sees cloudflare skill",
      existsSync(join(PI_SKILLS_DIR, "cloudflare", "SKILL.md")) ||
        existsSync(join(PI_SKILLS_DIR, "cloudflare", "skill.md")),
    ],
    [
      "Pi harness sees wrangler skill",
      existsSync(join(PI_SKILLS_DIR, "wrangler", "SKILL.md")) ||
        existsSync(join(PI_SKILLS_DIR, "wrangler", "skill.md")),
    ],
  ];
  for (const [label, ok] of skillsChecks) {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) fail += 1;
  }
  console.log(`  skills: ${skills.path}`);
  if (skills.head) console.log(`  skills HEAD: ${skills.head}  ${skills.date || ""}`);

  const slashChecks = [
    ["slash catalog non-empty", SLASH_COMMANDS.length >= 8],
    ["filter /mo → model", filterSlashCommands("/mo").some((c) => c.cmd === "/model")],
    ["slash menu shows /model only (not /models)", SLASH_COMMANDS.some((c) => c.cmd === "/model") && !SLASH_COMMANDS.some((c) => c.cmd === "/models")],
    ["filter /mission", filterSlashCommands("/mission").some((c) => c.cmd === "/mission")],
    ["normalize /model → /models", normalizeSlashCmd("/model") === "/models"],
    ["normalize /mission → /resume", normalizeSlashCmd("/mission") === "/resume"],
    ["normalize /map → /usage", normalizeSlashCmd("/map") === "/usage"],
    ["/map in slash catalog", SLASH_COMMANDS.some((c) => c.cmd === "/map")],
    ["/usage in slash catalog", SLASH_COMMANDS.some((c) => c.cmd === "/usage")],
    ["inline slash helper", typeof tuiSlashInline === "function"],
    ["search pick helper", typeof tuiSearchPick === "function"],
    ["model filter llama", filterModelItems([{ id: "@cf/meta/llama-3.2-1b-instruct", note: "tiny" }], "llama").length === 1],
    [
      "no misleading Cursor-style modal label",
      !readFileSync(fileURLToPath(import.meta.url), "utf8").includes("Cursor" + "-style popup"),
    ],
    [
      "splash home helper",
      typeof paintSplashHome === "function" && typeof runSplashHome === "function",
    ],
    [
      "no splash sleep-then-menu (280ms boot clear)",
      !readFileSync(fileURLToPath(import.meta.url), "utf8").includes("await sleep(" + "280)"),
    ],
    [
      "no timed boot crawl sleeps",
      !readFileSync(fileURLToPath(import.meta.url), "utf8").includes("await sleep(" + "70)"),
    ],
    [
      "slash /login says sign in via alfred.report",
      SLASH_COMMANDS.some((c) => c.cmd === "/login" && /sign in via alfred\.report/i.test(c.desc)),
    ],
    [
      "slash /login does not say from vault",
      !SLASH_COMMANDS.some((c) => c.cmd === "/login" && /from vault/i.test(c.desc)),
    ],
    [
      "usage login is alfred.report not vault-default",
      /sign in via alfred\.report/i.test(usage()) && !/alfred-pi login\s+wire CF alfred-ai-gateway from vault/.test(usage()),
    ],
    [
      "operator vault login exists",
      typeof cmdLoginVault === "function" && /login --vault/.test(usage()),
    ],
    [
      "default resolveGateway ignores vault without operator",
      (() => {
        const prev = process.env.ALFRED_PI_OPERATOR;
        delete process.env.ALFRED_PI_OPERATOR;
        const g = resolveGateway();
        if (prev !== undefined) process.env.ALFRED_PI_OPERATOR = prev;
        return g.operator === false;
      })(),
    ],
    [
      "wordmark colors Al . ! gold and fred report cream",
      (() => {
        const w = brandWordmark(true);
        const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        const p = plain(w);
        return (
          w.includes(C.gold) &&
          w.includes(C.cream) &&
          p === "Alfred.report!" &&
          p.includes("Al") &&
          p.includes("fred") &&
          p.includes("report") &&
          p.includes("!")
        );
      })(),
    ],
    [
      "no exotic math-l in labels (ASCII Alfred-pi / Alfred>)",
      (() => {
        const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
        // split needles so this assertion does not match itself
        const needleL = "DISP_" + "L";
        const needleHex = "1D" + "429";
        const needleBad = "Ap" + "fred";
        const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        return (
          !src.includes("const " + needleL) &&
          !src.includes("\\u{" + needleHex + "}") &&
          plain(alfredPiLabel()) === "Alfred-pi" &&
          plain(alfredPrompt()) === "Alfred> " &&
          !plain(alfredPiLabel() + alfredPrompt()).includes(needleBad)
        );
      })(),
    ],
    [
      "plain Alfred-pi / Alfred> ASCII only",
      (() => {
        const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        const p = plain(alfredPrompt());
        const l = plain(alfredPiLabel());
        return l === "Alfred-pi" && p === "Alfred> " && !/[\u{1D400}-\u{1D7FF}]/u.test(l + p);
      })(),
    ],
    [
      "Alfred-auto is default model mode",
      DEFAULT_MODEL === MODEL_AUTO &&
        CURATED_MODELS[0]?.id === MODEL_AUTO &&
        isAutoModelId(DEFAULT_MODEL) &&
        modelDisplayName(MODEL_AUTO, { cfg: {} }) === "Alfred-auto",
    ],
    [
      "pickAlfredAuto prefers free-first tiny",
      pickAlfredAutoModel({ messages: [{ role: "user", content: "hi" }] }) ===
        DEFAULT_CONCRETE_MODEL,
    ],
    [
      "Go Max only when logged in + max plans (never under NEED LOGIN)",
      modelDisplayName(MODEL_AUTO, { cfg: { maxPlan: true }, loggedIn: true }) === GO_MAX_DISPLAY &&
        modelDisplayName(MODEL_AUTO, { cfg: { maxPlan: true }, loggedIn: false }) === "Alfred-auto" &&
        modelDisplayName(MODEL_AUTO, { cfg: {} }) === "Alfred-auto",
    ],
    [
      "/usage and /map share fetchMapView",
      typeof fetchMapView === "function" && typeof fetchUsageSummary === "function",
    ],
    [
      "block wordmark glyphs: l is vertical stem (no L-foot)",
      Array.isArray(WM_GLYPHS.l) &&
        WM_GLYPHS.l.every((row) => !/███/.test(row.trim()) && /█/.test(row)),
    ],
    [
      "splash uses splashWordmarkRows with block rows + underline",
      (() => {
        const rows = splashWordmarkRows(80);
        const rule = rows[rows.length - 1] || "";
        return (
          typeof splashWordmarkRows === "function" &&
          rows.length >= 6 &&
          (rule.includes("━") || rule.includes("─")) &&
          ansiPlainLen(rows[0]) > 20
        );
      })(),
    ],
    [
      "herdr agent report helper",
      typeof herdrReportAgent === "function" && typeof herdrReleaseAgent === "function",
    ],
    [
      "corner OpenRoyleAl matches site (ASCII Al gold)",
      (() => {
        const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        const c = cornerOpenRoyleAl();
        return plain(c) === "OpenRoyleAl" && c.includes(C.gold) && /OpenRoyle/.test(c);
      })(),
    ],
    [
      "no legacy PIXEL_ + GLYPHS const",
      !readFileSync(fileURLToPath(import.meta.url), "utf8").includes("PIXEL_" + "GLYPHS"),
    ],
    
    [
      "corner is OpenRoyleAl gold Al",
      /OpenRoyle/.test(cornerOpenRoyleAl()) && cornerOpenRoyleAl().includes(C.gold),
    ],
    [
      "mission meat slug not session-YYYYMMDD",
      /^mission-[a-z]{3}\d{1,2}-pi$/.test(timestampMeatSlug()) &&
        !timestampMeatSlug().startsWith("session-"),
    ],
    [
      "meatSlugFromText board brief",
      meatSlugFromText("Board brief for Martin") === "board-brief-martin" ||
        meatSlugFromText("board brief") === "board-brief",
    ],
    [
      "listGatewayModels curated only (no catalog dump)",
      !readFileSync(fileURLToPath(import.meta.url), "utf8").includes(
        "ai/models/search?per_page=" + "50",
      ),
    ],
    [
      "CURATED_MODELS short ladder",
      CURATED_MODELS.length >= 6 && CURATED_MODELS.length <= 10 && CURATED_MODELS[0].id === MODEL_AUTO,
    ],
    [
      "login consumer has numbered steps",
      /Sign in \(Access-first\)/.test(readFileSync(fileURLToPath(import.meta.url), "utf8")) &&
        /1\) Open/.test(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    ],
    [
      "tuiClear clears scrollback (3J)",
      readFileSync(fileURLToPath(import.meta.url), "utf8").includes("[3J"),
    ],
    [
      "UI resume label is mission not session",
      TUI_MENU.some((m) => m.id === "resume" && m.label === "Resume mission"),
    ],
    [
      "slash /resume has no kebab-slug copy",
      SLASH_COMMANDS.some((c) => c.cmd === "/resume" && c.desc === "resume mission") &&
        !SLASH_COMMANDS.some((c) => /kebab slug/i.test(c.desc)),
    ],
    [
      "/rename in slash catalog",
      SLASH_COMMANDS.some((c) => c.cmd === "/rename"),
    ],
    [
      "legacy session slug hidden",
      isLegacySessionSlug("session-20260913-2") &&
        isHiddenMissionSlug("session-20260913-2") &&
        !isHiddenMissionSlug("board-brief"),
    ],
    [
      "migrate + rename helpers",
      typeof migrateLegacySessions === "function" && typeof renameMission === "function",
    ],
    [
      "MIMO + Grok on curated ladder via gateway alfred",
      CURATED_MODELS.some((m) => m.id === MIMO_PRO) &&
        CURATED_MODELS.some((m) => m.id === MIMO_FLASH) &&
        CURATED_MODELS.some((m) => m.id === GROK_DEFAULT),
    ],
    [
      "vision auto-switch picks mimo-v2.6-flash",
      pickAlfredAutoModel({
        messages: [{ role: "user", content: "see https://x.test/shot.png" }],
      }) === MIMO_VISION,
    ],
    [
      "reason auto-switch picks grok-4.7",
      pickAlfredAutoModel({
        messages: [{ role: "user", content: "deep analysis step by step" }],
      }) === GROK_DEFAULT,
    ],
    [
      "vision backup is grok-4.7 multimodal (not text Workers AI)",
      GROK_VISION === GROK_DEFAULT &&
        typeof chatGatewayExternal === "function" &&
        typeof isTransientProviderFail === "function" &&
        isTransientProviderFail(429, "quota exhausted") &&
        isTransientProviderFail(402, "no credits"),
    ],
    [
      "CF Images visionprep always-on helpers",
      CF_IMAGES_VARIANT === "visionprep" &&
        CF_IMAGES_HASH.length > 8 &&
        typeof prepareMessagesVisionCf === "function" &&
        typeof prepOneImageViaCf === "function" &&
        typeof isAlreadyVisionPrepUrl === "function" &&
        isAlreadyVisionPrepUrl(
          `https://imagedelivery.net/${CF_IMAGES_HASH}/abc/${CF_IMAGES_VARIANT}`,
        ) &&
        !isAlreadyVisionPrepUrl("https://example.com/x.png"),
    ],
    [
      "auth menu flips to Log out when wired helper exists",
      typeof authMenuLabel === "function",
    ],
  ];
  for (const [label, ok] of slashChecks) {
    console.log(`${ok ? "✓" : "✗"} slash: ${label}`);
    if (!ok) fail += 1;
  }
  if (fail) {
    process.exitCode = 1;
    console.log(`wake self-test FAILED (${fail})`);
  } else {
    console.log("wake self-test OK (no inference)");
  }
}



async function main(argv) {
  try { printLinkedPiVersion(); } catch { /* ignore */ }
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
    process.stdout.write(usage());
    return;
  }
  if (args.includes("-v") || args.includes("--version") || args[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (args[0] === "login" || args[0] === "/login") {
    await cmdLogin({ flags: args.slice(1) });
    return;
  }
  if (args[0] === "logout" || args[0] === "/logout") {
    cmdLogout();
    return;
  }
  if (args[0] === "status") {
    printStatus({ mode: "status" });
    return;
  }
  if (args[0] === "update") {
    cmdUpdate();
    return;
  }
  if (args[0] === "skills") {
    const action = args[1] || "status";
    if (action === "sync" || action === "update") {
      if (!syncCloudflareSkills({ reason: "manual" })) process.exitCode = 1;
    } else if (action === "status") {
      if (!printCloudflareSkillsStatus()) process.exitCode = 1;
    } else {
      console.error("usage: alfred-pi skills [sync|status]");
      process.exitCode = 2;
    }
    return;
  }

  if (args.includes("--self-test") || args[0] === "self-test") {
    runWakeSelfTest();
    return;
  }

  let slug = "";
  let wantInteractive = true;
  let forceRepl = args.includes("--repl");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume" || args[i] === "-r") {
      slug = args[i + 1] || "";
      i++;
      continue;
    }
    if (args[i] === "--repl") {
      forceRepl = true;
      continue;
    }
    if (args[i] === "--tui") {
      forceRepl = false;
      continue;
    }
    if (args[i] === "--smoke") {
      // non-interactive tiny Workers AI check
      wantInteractive = false;
      (async () => {
        const g = resolveGateway();
        if (!g.inferenceToken) {
          console.error("not wired — alfred-pi login first");
          process.exitCode = 2;
          return;
        }
        console.log(`${WAKE} smoke — Workers AI via alfred-ai-gateway`);
        const r = await chatWorkersAI([{ role: "user", content: "Reply with exactly: pong" }], {
          model: DEFAULT_MODEL,
          maxTokens: 8,
        });
        console.log(`  model: ${r.model}`);
        console.log(`  reply: ${r.content}`);
        console.log(
          `  usage: tokens=${r.usage.totalTokens} neurons=${r.usage.neurons ?? "?"}`,
        );
      })().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
      return;
    }
    if (args[i] === "report" || args[i] === "pi") {
      const next = args[i + 1];
      if (next === "update") {
        cmdUpdate();
        return;
      }
      if (next === "login") {
        await cmdLogin({ flags: args.slice(i + 2) });
        return;
      }
      if (next && !next.startsWith("-")) {
        slug = next;
        i++;
      }
      continue;
    }
  }

  if (wantInteractive) {
    syncCloudflareSkills({ reason: forceRepl ? "REPL start" : "TUI start", quiet: true });
    const start = forceRepl ? runRepl(slug) : runTui(slug);
    start.catch((e) => {
      console.error(e.message || e);
      process.exitCode = 1;
    });
  }
}

main(process.argv).catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
