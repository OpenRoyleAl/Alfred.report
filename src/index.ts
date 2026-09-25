import { Alfred } from "./alfred/orchestrator";
import type { Env } from "./lib/env";
import { secretGet } from "./lib/secret";
import { proxyListMissions, proxyGetMission, proxyCreateMission, proxyGoMaxMission, proxyMissionAct, proxyCommandStats, missionBoardAsset } from "./lib/command-proxy";
import { handleKissApi } from "./lib/kiss-routes";
import { handleInboundEmail } from "./lib/mail";

// ─── Exports for Wrangler ──────────────────────────────────────

export { Alfred } from "./alfred/orchestrator";

// ─── User Registry (email → tenant) ───────────────────────────

const TENANT_MAP: Record<string, { name: string; tenant_id: string }> = {
  "hans@icebergmedia.co.uk": { name: "Hans", tenant_id: "hans" },
  "hans@hansakoch.com": { name: "Hans", tenant_id: "hans" },
  "test@alfred.report": { name: "Test User", tenant_id: "test" },
};

// Get user from Cloudflare Access headers (set by Access after OTP/IdP login)
function getAccessUser(req: Request): { email: string; name: string; tenant_id: string } | null {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email") || emailFromAccessCookie(req);
  if (!email) return null;
  const user = TENANT_MAP[email.toLowerCase()];
  if (!user) return { email, name: email.split("@")[0], tenant_id: email.split("@")[0] };
  return { email, name: user.name, tenant_id: user.tenant_id };
}

/** Optional identity on unprotected paths (e.g. /) via Access JWT cookie. */
function emailFromAccessCookie(req: Request): string | null {
  const raw = req.headers.get("Cookie") || "";
  const m = raw.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!m) return null;
  try {
    const payloadB64 = m[1].split(".")[1];
    if (!payloadB64) return null;
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { email?: string };
    return (payload.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function isHansEmail(email: string | null | undefined): boolean {
  const e = (email || "").toLowerCase();
  return e === "hans@icebergmedia.co.uk" || e === "hans@hansakoch.com";
}

function hansFromRequest(req: Request): boolean {
  const access = getAccessUser(req);
  return isHansEmail(access?.email) || isHansEmail(emailFromAccessCookie(req));
}

/** Access email (Hans) or ALFRED_OPS_TOKEN Bearer — dogfood CLI + board. */
async function getVerifiedUser(
  req: Request,
  env: Env
): Promise<{ email: string; tenant_id: string; isHans: boolean } | null> {
  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7).trim();
    const ops = await secretGet(env.ALFRED_OPS_TOKEN as any);
    if (ops && bearer === ops) {
      return { email: "hans@icebergmedia.co.uk", tenant_id: "hans", isHans: true };
    }
    return null;
  }
  const access = getAccessUser(req);
  const email = (access?.email || emailFromAccessCookie(req) || "").toLowerCase().trim();
  if (!email) return null;
  return {
    email,
    tenant_id: email.split("@")[0].replace(/[^a-z0-9]/g, "") || "default",
    isHans: isHansEmail(email),
  };
}

// ─── Content Negotiation & Markdown Helpers ─────────────────────

function wantsMarkdown(req: Request, url: URL): boolean {
  if (url.pathname.endsWith(".md")) return true;
  const accept = (req.headers.get("Accept") || "").toLowerCase();
  return accept.includes("text/markdown") || accept.includes("text/x-markdown");
}

const MARKDOWN_DOCS: Record<string, string> = {
  "/": `# Alfred, report! — Voice-First AI Operator & Chief of Staff

> One wake word. Closed work comes back with verified evidence. You stay out of the middle.

Alfred is a voice-first AI Chief of Staff and agent execution engine built on Cloudflare Workers, Durable Objects, D1, and neural voice synthesis. Instead of endless chat windows, Alfred manages durable missions with strict budgets, evidence gates, and instant voice debriefs via Apple Siri and iOS Shortcuts.

## Key Features
- **Voice-First Debriefing:** Say "Hey Siri, Alfred report" to receive an immediate spoken status report of active, gated, and closed missions.
- **Durable Mission Engine:** Bounded missions with explicit acceptance criteria, neuron/token budgets, and verification evidence.
- **Evidence-Gated Completion:** Missions cannot close without verified evidence (attestation, screenshot, test pass, or link). Fake "done" is rejected.
- **Multi-Tenant Isolation:** Supports distinct tenants with dedicated voice styles, Cloudflare AI Gateways, and isolated mission boards.

## Core Navigation & Endpoints
- [Developer API Reference](https://alfred.report/api/docs)
- [OpenAPI 3.1 Specification](https://alfred.report/api/openapi.json)
- [LLM Instructions](https://alfred.report/llms.txt)
- [Extended LLM Context](https://alfred.report/llms-full.txt)
- [About](https://alfred.report/about)
- [Contact & Support](https://alfred.report/contact)
- [Privacy Policy](https://alfred.report/privacy)
- [XML Sitemap](https://alfred.report/sitemap.xml)
- [Go Max Al!](https://alfred.report/go-max)
- [Sign up](https://alfred.report/signup)
- [Sign in](https://alfred.report/login)`,

  "/about": `# About Alfred.report

Alfred is a voice-first AI Chief of Staff designed for business operators who demand closure instead of endless conversation. Built by OpenRoyleAl. Alfred.report replaces chat-based assistant bloat with durable, evidence-gated missions.

## The Problem: Chat Army Fatigue
Most AI agent platforms spawn disconnected chat sessions that treat human principals as message dispatchers. When managing high-scale operations—such as monitoring technical health across 145+ client domains—multi-agent swarms frequently generate hallucinations, false completion reports, and unverified work.

Alfred.report eliminates this friction by operating under four core doctrines:
- **One Wake Word:** "Hey Siri, Alfred report." You speak once, and the system delivers concise, spoken mission debriefs over neural audio.
- **Evidence Before Completion:** An agent cannot mark a mission "complete" without concrete evidence (test suites passing, artifact URLs, screenshot proof, or explicit human sign-off).
- **Hard Token & Dollar Budgets:** Every mission executes within strict spending boundaries. Over-budget processes halt immediately.
- **Ephemeral Execution, Durable State:** Worker subagents spawn to solve specific tasks, deposit verified findings into Cloudflare D1 and Agent Memory, and terminate cleanly.

## Cloudflare-Native Architecture
- **Cloudflare Workers & Durable Objects:** High-throughput, low-latency coordination and distributed state management.
- **Cloudflare D1:** Serverless relational SQL database for mission records, acceptance criteria, and audit histories.
- **Cloudflare Agent Memory:** Durable semantic memory retaining long-term operational context.
- **MiMo Neural TTS:** Ultra-low latency voice synthesis tailored for hands-free Siri debriefs.

## Leadership & Origins
Built by OpenRoyleAl.`,

  "/contact": `# Contact & Support — Alfred.report

Whether you are integrating voice endpoints with iOS Shortcuts, dispatching autonomous agency workflows, or inquiring about enterprise tenancy, our technical operations team is here to assist.

## Direct Operator Channels
- **Product email:** al@alfred.report (Cloudflare Email Routing)
- **Technical Operator Email:** hans@icebergmedia.co.uk (Response time < 4 hours)
- **Telephone Operations Bridge:** +44 (0) 20 8040 4422 (Mon–Fri 08:00–18:00 GMT / UTC+8)
- **Registered Postal Address:**
  Iceberg Media Ltd / OpenRoyleAl
  71-75 Shelton Street, Covent Garden
  London, WC2H 9JQ, United Kingdom

## Machine & Agent Integrations
- Developer Documentation: https://alfred.report/api/docs
- OpenAPI 3.1 Specification: https://alfred.report/api/openapi.json
- Agent Instructions: https://alfred.report/llms.txt
- XML Sitemap: https://alfred.report/sitemap.xml`,

  "/privacy": `# Privacy Policy — Alfred.report

Effective Date: September 8, 2026

At Iceberg Media, protecting the privacy, confidentiality, and integrity of your operational data is fundamental to our software engineering principles.

## 1. Zero Third-Party Tracking
Our public website (alfred.report) does not employ third-party advertising cookies, behavioral tracking pixels, or cross-site tracking scripts. We do not sell, rent, or monetize your personal or operational data under any circumstances.

## 2. Operational Data & Mission Storage
- **Authentication Tokens:** Secure session tokens stored with cryptographic hashing in Cloudflare D1.
- **Mission Context:** Objectives, acceptance criteria, and execution logs recorded to verify task closure.
- **Voice Synthesis Streams:** Real-time text-to-speech without persistent audio retention.

## 3. Cloudflare Security & GDPR
- Edge encryption via TLS 1.3 on Cloudflare edge.
- Full compliance with UK GDPR and EU GDPR statutory data access/erasure rights.
- Data Controller: Iceberg Media Ltd, 71-75 Shelton Street, Covent Garden, London, WC2H 9JQ, UK.`
};

function renderMarkdownResponse(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Vary": "Accept, Accept-Encoding",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function render404(req: Request, url: URL): Response {
  if (wantsMarkdown(req, url)) {
    const md = `# 404 Not Found\n\nThe requested resource \`${url.pathname}\` was not found on Alfred.report.\n\n## Helpful Resources\n- [Homepage](https://alfred.report/): Voice-first AI Operator & Chief of Staff\n- [About](https://alfred.report/about)\n- [Contact & Support](https://alfred.report/contact)\n- [Privacy Policy](https://alfred.report/privacy)\n- [API Documentation](https://alfred.report/api/docs)\n- [OpenAPI 3.1 Specification](https://alfred.report/api/openapi.json)\n- [LLM Instructions](https://alfred.report/llms.txt)\n- [XML Sitemap](https://alfred.report/sitemap.xml)\n`;
    return renderMarkdownResponse(md, 404);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 Not Found — Alfred.report</title>
  <link rel="icon" href="/favicon.svg">
  <style>
    :root { --bg:#0a0a0a; --fg:#eceae4; --muted:#9a958c; --gold:#c9a227; --card:#161922; --border:#2a2a2a; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); line-height:1.6; font-size:17px; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem; text-align:center; }
    .card { max-width:480px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:2rem 1.5rem; }
    h1 { font-size:2rem; margin-bottom:0.5rem; color:var(--gold); }
    p { color:var(--muted); margin-bottom:1.5rem; }
    .links { display:flex; flex-direction:column; gap:0.75rem; text-align:left; }
    .links a { color:var(--fg); text-decoration:none; padding:0.75rem 1rem; background:#0e1015; border:1px solid var(--border); border-radius:10px; font-size:0.95rem; }
    .links a:hover { border-color:var(--gold); color:var(--gold); }
  </style>
</head>
<body>
  <div class="card">
    <h1>404 — Not Found</h1>
    <p>The requested page or endpoint does not exist on Alfred.report.</p>
    <div class="links">
      <a href="/">← Return to Homepage</a>
      <a href="/api/docs">📖 API Documentation</a>
      <a href="/llms.txt">🤖 Agent Guide (llms.txt)</a>
      <a href="/sitemap.xml">🗺️ Sitemap</a>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Vary": "Accept, Accept-Encoding",
    },
  });
}

// ─── Main Entry ────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const hostname = url.hostname;

    // Canonical host is alfred.report. www is a 301 trampoline only (SEO).
    if (hostname === "www.alfred.report") {
      return new Response(null, {
        status: 301,
        headers: { Location: "https://alfred.report" + url.pathname + url.search },
      });
    }

    // Legacy Siri hostname — not a product. One page lives at /iphone.
    if (hostname === "iphone.alfred.report") {
      return new Response(null, {
        status: 301,
        headers: { Location: "https://alfred.report/iphone" + url.search },
      });
    }

    // Signal plane
    if (hostname === env.SIGNAL_DOMAIN || hostname === "signal.alfred-report.iceberg.workers.dev") {
      return handleSignal(req, env);
    }

    // Vault plane
    if (hostname === env.VAULT_DOMAIN || hostname === "vault.alfred-report.iceberg.workers.dev") {
      return handleVault(req, env);
    }

    // Ledger plane
    if (hostname === env.LEDGER_DOMAIN || hostname === "ledger.alfred-report.iceberg.workers.dev") {
      return handleLedger(req, env);
    }

    // Dashboard
    if (hostname === env.DOMAIN || hostname === "alfred-report.iceberg.workers.dev") {
      return handleDashboard(req, env);
    }

    return render404(req, url);
  },

  async email(message: { from: string; to: string; headers: Headers; setReject?: (reason: string) => void }, env: Env): Promise<void> {
    await handleInboundEmail(message, env);
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Frozen: farmer/curator/distiller/janitor/builder. See docs/ARCHITECTURE-FREEZE.md
  },
};

// ─── Signal Plane ──────────────────────────────────────────────

async function handleSignal(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/ingest" && req.method === "POST") {
    try {
      const body = await req.json() as { kind: string; source: string; headline: string; body?: string; tenant_id?: string };
      if (!body.kind || !body.source || !body.headline) {
        return Response.json({ error: "Missing required fields: kind, source, headline" }, { status: 400 });
      }
      const id = env.ALFRED.idFromName(body.tenant_id || "default");
      const stub = env.ALFRED.get(id);
      return stub.fetch(new Request("https://internal/signal/ingest", { method: "POST", body: JSON.stringify(body) }));
    } catch (error) {
      return Response.json({ error: "Failed to ingest signal", detail: String(error) }, { status: 500 });
    }
  }

  if (url.pathname === "/health") return Response.json({ status: "ok", plane: "signal" });
  return new Response("Signal Plane", { status: 200 });
}

// ─── Vault Plane ───────────────────────────────────────────────

async function handleVault(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return Response.json({ status: "ok", plane: "vault" });
  return new Response("Vault Plane", { status: 200 });
}

// ─── Ledger Plane ──────────────────────────────────────────────

async function handleLedger(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return Response.json({ status: "ok", plane: "ledger" });
  return new Response("Ledger Plane", { status: 200 });
}

// ─── Dashboard ─────────────────────────────────────────────────

/** CSS, fonts, logos — must pass through ASSETS (Worker lists routes explicitly). */
async function tryPublicAsset(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const p = url.pathname;
  if (!p.startsWith("/fonts/") && !/\.(css|js|svg|png|woff2|ico|webp|mp3|wav|txt)(\?|$)/i.test(p)) {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(new URL(p + url.search, url.origin), req));
  return res.status === 404 ? null : res;
}

async function handleDashboard(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // alfred-proxy mirror — lease/release for any agent (ops bearer)
  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/proxy/")) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Alfred-Ops-Token, X-Alfred-Holder",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  const { handleAlfredProxy } = await import("./lib/alfred-proxy");
  const proxyRes = await handleAlfredProxy(req, env);
  if (proxyRes) return proxyRes;

  const kissApi = await handleKissApi(req, env, url);
  if (kissApi) return kissApi;

  // Google OAuth (browser + alfred-pi / alfred-grok CLI login)
  {
    const { handleGoogleAuth } = await import("./lib/google-auth");
    const googleRes = await handleGoogleAuth(req, env, url);
    if (googleRes) return googleRes;
  }

  // Static demo audio + assets (Speak it! must never 404)
  if (url.pathname.startsWith("/audio/") && (req.method === "GET" || req.method === "HEAD")) {
    const asset = await env.ASSETS.fetch(new Request(new URL(url.pathname + url.search, url.origin), req));
    if (asset.status !== 404) {
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(asset.body, { status: asset.status, headers });
    }
  }

  const staticAsset = await tryPublicAsset(req, env, url);
  if (staticAsset) return staticAsset;


  // Health (no auth)
  if (url.pathname === "/api/health") {
    return Response.json({
      status: "ok",
      plane: "dashboard",
      domain: env.DOMAIN,
      images: Boolean((env as Env & { IMAGES?: unknown }).IMAGES),
      visionprep: "visionprep",
    });
  }

  // CF Images vision token prep — always-on resize/encode before multimodal LLMs
  if (url.pathname === "/api/vision-prep" && req.method === "POST") {
    const user = await getVerifiedUser(req, env);
    if (!user) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const { handleVisionPrepRequest } = await import("./lib/cf-images-vision");
    return handleVisionPrepRequest(req, env);
  }

  // MCP protocol (no Access auth — uses bearer token)
  if (url.pathname === "/mcp" && req.method === "POST") {
    const { handleMCP } = await import("./mcp/server");
    return handleMCP(req, env);
  }

  // Legacy paths → KISS /
  if (url.pathname === "/now" || url.pathname === "/now/") {
    return Response.redirect(new URL("/", url.origin).toString(), 302);
  }
  if (url.pathname === "/app" || url.pathname === "/app/") {
    return Response.redirect(new URL("/", url.origin).toString(), 302);
  }
  if (url.pathname === "/app/new" || url.pathname === "/app/new/") {
    return Response.redirect(new URL("/new", url.origin).toString(), 302);
  }
  if (url.pathname.startsWith("/app/m/")) {
    return Response.redirect(new URL(url.pathname.replace(/^\/app/, ""), url.origin).toString(), 302);
  }
  if (url.pathname === "/app/closed" || url.pathname === "/app/burn") {
    return Response.redirect(new URL(url.pathname.replace(/^\/app/, ""), url.origin).toString(), 302);
  }
  if (url.pathname.startsWith("/now/m/")) {
    return Response.redirect(new URL(url.pathname.replace(/^\/now/, ""), url.origin).toString(), 302);
  }

  // ─── Public Content & Discovery Routes ─────────────────────────

  // Home: logged-in Hans → board; markdown request → markdown; everyone else → marketing
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(MARKDOWN_DOCS["/"]);
    }
    if (hansFromRequest(req)) {
      return env.ASSETS.fetch(new Request(new URL("/app.html", url.origin), req));
    }
    return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
  }

  // About page
  if (url.pathname === "/about" || url.pathname === "/about.html" || url.pathname === "/about.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(MARKDOWN_DOCS["/about"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/about.html", url.origin), req));
  }

  // Contact page
  if (url.pathname === "/contact" || url.pathname === "/contact.html" || url.pathname === "/contact.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(MARKDOWN_DOCS["/contact"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/contact.html", url.origin), req));
  }

  // Privacy policy page
  if (url.pathname === "/terms" || url.pathname === "/terms/" || url.pathname === "/terms.html") {
    return env.ASSETS.fetch(new Request(new URL("/terms.html", url.origin), req));
  }

  if (url.pathname === "/privacy" || url.pathname === "/privacy.html" || url.pathname === "/privacy.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(MARKDOWN_DOCS["/privacy"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/privacy.html", url.origin), req));
  }

  // iPhone setup page is public
  if (url.pathname === "/iphone" || url.pathname === "/iphone.html" || url.pathname === "/siri" || url.pathname === "/siri.html") {
    return env.ASSETS.fetch(new Request(new URL("/iphone.html", url.origin), req));
  }

  // Setup is automatic — old /setup and /download paths go to signup
  if (url.pathname === "/setup" || url.pathname === "/setup/" || url.pathname === "/setup.html") {
    return Response.redirect(new URL("https://alfred.report/signup", url.origin).toString(), 301);
  }
  if (url.pathname === "/go-max" || url.pathname === "/go-max/" || url.pathname === "/gomax") {
    return env.ASSETS.fetch(new Request(new URL("/go-max.html", url.origin), req));
  }
  if (url.pathname === "/download" || url.pathname === "/download/") {
    return Response.redirect(new URL("https://alfred.report/signup", url.origin).toString(), 301);
  }
  if (url.pathname === "/pi" || url.pathname === "/pi/") {
    return Response.redirect(new URL("https://github.com/OpenRoyleAl/Alfred.report", url.origin).toString(), 302);
  }
  if (url.pathname === "/install.sh" || url.pathname === "/install.ps1") {
    return Response.redirect("https://github.com/OpenRoyleAl/Alfred.report", 302);
  }

  // Developer documentation
  if (url.pathname === "/api/docs" || url.pathname === "/api/docs.html") {
    return env.ASSETS.fetch(new Request(new URL("/api/docs.html", url.origin), req));
  }

  // OpenAPI Specification
  if (url.pathname === "/api/openapi.json") {
    return env.ASSETS.fetch(new Request(new URL("/api/openapi.json", url.origin), req));
  }

  // LLM agent instructions
  if (url.pathname === "/llms.txt") {
    return env.ASSETS.fetch(new Request(new URL("/llms.txt", url.origin), req));
  }
  if (url.pathname === "/llms-full.txt") {
    return env.ASSETS.fetch(new Request(new URL("/llms-full.txt", url.origin), req));
  }
  if (url.pathname === "/for-agents" || url.pathname === "/for-agents/" || url.pathname === "/for-agents.txt") {
    return env.ASSETS.fetch(new Request(new URL("/for-agents.txt", url.origin), req));
  }

  // Robots & Sitemap
  if (url.pathname === "/robots.txt") {
    return env.ASSETS.fetch(new Request(new URL("/robots.txt", url.origin), req));
  }
  if (url.pathname === "/sitemap.xml") {
    return env.ASSETS.fetch(new Request(new URL("/sitemap.xml", url.origin), req));
  }

  // Favicon & Assets
  if (url.pathname === "/favicon.svg") {
    return env.ASSETS.fetch(new Request(new URL("/favicon.svg", url.origin), req));
  }

  // Auth redirect to voice auth for iPhone/Siri shortcuts
  if (url.pathname === "/auth" || url.pathname === "/auth/") {
    return Response.redirect(new URL("/login", url.origin).toString(), 302);
  }

  // Product paths — ORAL sales page
  if (url.pathname === "/oral" || url.pathname === "/oral/" || url.pathname === "/oral.html") {
    return env.ASSETS.fetch(new Request(new URL("/oral.html", url.origin), req));
  }
  if (url.pathname === "/missions" || url.pathname === "/missions/") {
    return Response.redirect(new URL("/home", url.origin).toString(), 302);
  }
  if (url.pathname === "/map" || url.pathname === "/map/") {
    return Response.redirect(new URL("/home", url.origin).toString(), 302);
  }
  if (url.pathname === "/board" || url.pathname === "/board/") {
    return Response.redirect(new URL("/home", url.origin).toString(), 302);
  }
  if (url.pathname === "/evidence" || url.pathname === "/evidence/") {
    return Response.redirect(new URL("/home", url.origin).toString(), 302);
  }
  if (url.pathname === "/brief" || url.pathname === "/brief/") {
    return Response.redirect(new URL("/", url.origin).toString(), 302);
  }

  // Login / signup / tenant dashboard / sovereign start (KISS — no Access)
  if (url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/login.html") {
    return env.ASSETS.fetch(new Request(new URL("/login.html", url.origin), req));
  }
  if (url.pathname === "/signup" || url.pathname === "/signup/" || url.pathname === "/signup.html") {
    return env.ASSETS.fetch(new Request(new URL("/signup.html", url.origin), req));
  }
  if (url.pathname === "/home" || url.pathname === "/home/" || url.pathname === "/home.html") {
    return env.ASSETS.fetch(new Request(new URL("/home.html", url.origin), req));
  }
  if (url.pathname === "/start" || url.pathname === "/start/" || url.pathname === "/start.html") {
    return env.ASSETS.fetch(new Request(new URL("/start.html", url.origin), req));
  }
  if (url.pathname === "/wizard" || url.pathname === "/wizard/" || url.pathname === "/wizard.html") {
    return Response.redirect(new URL("/start" + url.search, url.origin).toString(), 301);
  }
  if (url.pathname.match(/^\/t\/[^/]+\/?$/)) {
    return Response.redirect(new URL("/home", url.origin).toString(), 302);
  }

  const boardAsset = missionBoardAsset(url.pathname);
  const isBoardHtml =
    Boolean(boardAsset) ||
    url.pathname === "/app.html" ||
    url.pathname === "/all.html" ||
    url.pathname === "/new.html";
  const isMissionsEndpoint =
    url.pathname === "/api/command/missions" ||
    url.pathname === "/api/v1/missions" ||
    url.pathname === "/api/missions";
  const isStatsEndpoint =
    url.pathname === "/api/command/stats" ||
    url.pathname === "/api/v1/stats" ||
    url.pathname === "/api/stats";
  const missionDetailMatch = url.pathname.match(
    /^\/api\/(?:command\/missions|v1\/missions|missions)\/([^/]+)$/
  );
  const missionGoMaxMatch = url.pathname.match(
    /^\/api\/(?:command\/missions|v1\/missions|missions)\/([^/]+)\/go-max$/
  );
  const missionActMatch = url.pathname.match(
    /^\/api\/(?:command\/missions|v1\/missions|missions)\/([^/]+)\/act$/
  );
  const isCommandApi =
    isMissionsEndpoint ||
    isStatsEndpoint ||
    Boolean(missionDetailMatch) ||
    Boolean(missionGoMaxMatch) ||
    Boolean(missionActMatch);

  if (isBoardHtml || isCommandApi) {
    const verified = await getVerifiedUser(req, env);
    if (!verified || !verified.isHans) {
      if (isCommandApi) {
        return Response.json(
          { error: "Forbidden — Hans only. Sign in at /login/ or Bearer ALFRED_OPS_TOKEN" },
          { status: 403 }
        );
      }
      return Response.redirect(new URL("/login/", url.origin).toString(), 302);
    }
    if (boardAsset) {
      return env.ASSETS.fetch(new Request(new URL(boardAsset, url.origin), req));
    }
    if (url.pathname === "/app.html" || url.pathname === "/all.html" || url.pathname === "/new.html") {
      return env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin), req));
    }
    if (isStatsEndpoint && req.method === "GET") {
      return proxyCommandStats(env);
    }
    if (isMissionsEndpoint && req.method === "GET") {
      return proxyListMissions(req, env);
    }
    if (isMissionsEndpoint && req.method === "POST") {
      return proxyCreateMission(req, env);
    }
    if (missionGoMaxMatch && req.method === "POST") {
      return proxyGoMaxMission(decodeURIComponent(missionGoMaxMatch[1]), req, env);
    }
    if (missionActMatch && req.method === "POST") {
      return proxyMissionAct(decodeURIComponent(missionActMatch[1]), req, env);
    }
    if (missionDetailMatch && req.method === "GET") {
      return proxyGetMission(decodeURIComponent(missionDetailMatch[1]), env);
    }
  }

  // Everything else requires Cloudflare Access auth
  const user = getAccessUser(req);
  if (!user) {
    // If not matching any authenticated route, return a friendly 404
    return render404(req, url);
  }

  // Authenticated routes
  const tenant_id = user.tenant_id;
  const id = env.ALFRED.idFromName(tenant_id);
  const stub = env.ALFRED.get(id);

  // Authenticated home → Command board (KISS)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (hansFromRequest(req)) {
      return env.ASSETS.fetch(new Request(new URL("/app.html", url.origin), req));
    }
    return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
  }

  // User info
  if (url.pathname === "/api/me") {
    return Response.json({ name: user.name, tenant_id: user.tenant_id, email: user.email });
  }

  // Stats
  if (url.pathname === "/api/stats") {
    return stub.fetch(new Request(`https://internal/stats?tenant=${tenant_id}`));
  }

  // Signals
  if (url.pathname === "/api/signals") {
    return stub.fetch(new Request(`https://internal/signals?tenant=${tenant_id}`));
  }

  // Audit
  if (url.pathname === "/api/audit") {
    return stub.fetch(new Request(`https://internal/audit?tenant=${tenant_id}`));
  }

  // Chat
  if (url.pathname === "/api/chat" && req.method === "POST") {
    const body = await req.json() as { message: string };
    return stub.fetch(new Request("https://internal/chat", {
      method: "POST",
      body: JSON.stringify({ message: body.message }),
    }));
  }

  // GBP — list locations
  if (url.pathname === "/api/gbp/locations") {
    const { fetchGBPLocations } = await import("./lib/gbp");
    const locations = await fetchGBPLocations(env);
    return Response.json({ locations });
  }

  // GBP — reviews + posts + keywords for a location
  if (url.pathname === "/api/gbp/reviews") {
    const locationId = url.searchParams.get("locationId");
    if (!locationId) return Response.json({ error: "locationId required" }, { status: 400 });
    const { fetchGBPReviews } = await import("./lib/gbp");
    const data = await fetchGBPReviews(env, locationId);
    return Response.json(data);
  }

  if (url.pathname === "/api/run") {
    return Response.json(
      { error: "Gone — farmer/curator army frozen", see: "/docs freeze: ARCHITECTURE-FREEZE.md" },
      { status: 410 }
    );
  }

  // Build dashboard
  if (url.pathname === "/build" || url.pathname === "/build/") {
    return Response.redirect("https://alfred-ai-gateway.iceberg.workers.dev/build", 302);
  }

  return render404(req, url);
}
