/// <reference path="./wasm.d.ts" />
import coreWasm from "./alfred/wasm/alfred_core.wasm";
import { initCore } from "./alfred/core.ts";
import { clefGates } from "./alfred/extensions/clef";
import { Alfred } from "./alfred/orchestrator";
import type { Env } from "./lib/env";
import { secretGet } from "./lib/secret";
import {
  isOwnerEmail,
  safeEqual,
  tenantFromEmail,
  verifyAccessEmail,
  type VerifiedIdentity,
} from "./lib/access";
import { proxyListMissions, proxyGetMission, proxyCreateMission, proxyGoMaxMission, proxyMissionAct, proxyMissionsStats, missionBoardAsset } from "./lib/missions-proxy";
import { handleKissApi } from "./lib/kiss-routes";
import { handleInboundEmail } from "./lib/mail";
import { BRAND, brandContext } from "./brand";
import { listAgentTokens, mintAgentToken, parseScopes, revokeAgentToken, verifyAgentToken } from "./lib/agent-tokens";
import { fullScopes, mcpError, type MCPIdentity } from "./mcp/server";

// Instantiate the Rust core in the entry module (a side-effect import is tree-shaken: sideEffects=false).
initCore(coreWasm);

// ─── Worker exports (see deploy/web/cloudflare.config.ts) ──────────────────────────────────────

export { Alfred } from "./alfred/orchestrator";

// ─── Identity (verified only) ─────────────────────────────────
// Tenant comes from a verified Cloudflare Access JWT or the owner ops token.
// No hard-coded emails: owners are listed in the OWNER_EMAILS var (per account).


async function ownerFromRequest(req: Request, env: Env): Promise<boolean> {
  const user = await getVerifiedUser(req, env);
  return !!user?.isOwner;
}

/** Verified Access email, or ALFRED_OPS_TOKEN Bearer (owner CLI). */
async function getVerifiedUser(
  req: Request,
  env: Env
): Promise<(VerifiedIdentity & { isOwnerUser: boolean }) | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7).trim();
    const ops = await secretGet(env.ALFRED_OPS_TOKEN as any);
    const owner = (env.OWNER_EMAILS || "").split(",")[0]?.trim().toLowerCase();
    // ALFRED_AGENT_TOKEN: a second owner bearer for the owner's own agents (deploy smoke tests);
    // separate from ALFRED_OPS_TOKEN so it can be revoked without touching other automations.
    const agent = await secretGet(env.ALFRED_AGENT_TOKEN as any);
    if (owner && ((ops && safeEqual(bearer, ops)) || (agent && safeEqual(bearer, agent)))) {
      return { email: owner, tenant_id: tenantFromEmail(owner), isOwner: true, isOwnerUser: true, via: "ops_token" };
    }
    return null;
  }
  const email = await verifyAccessEmail(req, env);
  if (!email) return null;
  const isOwner = isOwnerEmail(env, email);
  return { email, tenant_id: tenantFromEmail(email), isOwner, isOwnerUser: isOwner, via: "access" };
}

function sandboxLimit(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ─── Content Negotiation & Markdown Helpers ─────────────────────

function wantsMarkdown(req: Request, url: URL): boolean {
  if (url.pathname.endsWith(".md")) return true;
  const accept = (req.headers.get("Accept") || "").toLowerCase();
  return accept.includes("text/markdown") || accept.includes("text/x-markdown");
}

/** Markdown views of the public pages, branded per instance (DOMAIN). No operator details are hard-coded. */
function markdownDocs(env: Env): Record<string, string> {
  const b = brandContext(env);
  const host = env.DOMAIN || "localhost";
  return {
    "/": `# ${b.instanceBrand}\n\n${BRAND.tagline}\n\n${b.byline}.\n\n- [About](https://${host}/about)\n- [Contact](https://${host}/contact)\n- [Privacy](https://${host}/privacy)\n- [API docs](https://${host}/api/docs)\n- [llms.txt](https://${host}/llms.txt)`,
    "/contact": `# Contact - ${b.instanceBrand}\n\n- Email: ${BRAND.senderLocalPart}@${host}\n- Web: https://${host}/contact\n\n${b.byline}.`,
    "/privacy": `# Privacy - ${b.instanceBrand}\n\nThis instance runs on its owner's own Cloudflare account. ${BRAND.platformBrand} is the platform and Sovereign Custodian behind it.\n\n- No third-party advertising or tracking cookies.\n- Session tokens are stored hashed in Cloudflare D1.\n- Mission objectives, acceptance criteria and logs are kept to verify that work was done.\n- Voice audio is transcribed and not retained.\n\nThe data controller is the owner of ${host}; contact ${BRAND.senderLocalPart}@${host} for access or erasure requests.`,
  };
}

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
    const md = `# 404 Not Found

\`${url.pathname}\` was not found.

- [Home](/)
- [API docs](/api/docs)
- [llms.txt](/llms.txt)
`;
    return renderMarkdownResponse(md, 404);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 Not Found</title>
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
    <p>The requested page or endpoint does not exist.</p>
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

    // Canonical host is DOMAIN. www is a 301 trampoline only (SEO).
    if (env.DOMAIN && hostname === `www.${env.DOMAIN}`) {
      return new Response(null, {
        status: 301,
        headers: { Location: `https://${env.DOMAIN}` + url.pathname + url.search },
      });
    }

    // Alfred's MCP host for agents: mcp.<DOMAIN>. Only the MCP endpoint lives here.
    if (env.DOMAIN && hostname === `mcp.${env.DOMAIN}`) {
      return handleMcpHost(req, env, url);
    }

    // One web plane: the instance domain (routes in deploy/web/cloudflare.config.ts).
    if (hostname === env.DOMAIN || hostname === "localhost" || hostname === "127.0.0.1") {
      return handleDashboard(req, env);
    }

    return render404(req, url);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(message, env);
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Scheduled work runs in the Missions Worker (apps/missions).
  },
};

// ─── Signal ingest (/api/signal/ingest) ───────────────────────

async function handleSignalIngest(req: Request, env: Env): Promise<Response> {
  try {
    const body = (await req.json()) as { kind: string; source: string; headline: string; body?: string };
    if (!body.kind || !body.source || !body.headline) {
      return Response.json({ error: "Missing required fields: kind, source, headline" }, { status: 400 });
    }
    // Tenant from verified identity only.
    const identity = await getVerifiedUser(req, env);
    if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const stub = env.ALFRED.getByName(identity.tenant_id);
    return stub.fetch(new Request("https://internal/signal/ingest", { method: "POST", body: JSON.stringify(body) }));
  } catch (error) {
    return Response.json({ error: "Failed to ingest signal", detail: String(error) }, { status: 500 });
  }
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

  if (url.pathname === "/api/signal/ingest" && req.method === "POST") {
    return handleSignalIngest(req, env);
  }

  const kissApi = await handleKissApi(req, env, url);
  if (kissApi) return kissApi;

  // Google OAuth (browser + CLI login)
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

  // MCP on the main host (behind the Access app on /mcp): same handler and auth as mcp.<DOMAIN>.
  if (url.pathname === "/mcp") {
    return serveMcp(req, env);
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

  // Home: logged-in owner → board; markdown request → markdown; everyone else → marketing
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(markdownDocs(env)["/"]);
    }
    if ((await ownerFromRequest(req, env))) {
      return env.ASSETS.fetch(new Request(new URL("/app.html", url.origin), req));
    }
    return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
  }

  // About page
  if (url.pathname === "/about" || url.pathname === "/about.html" || url.pathname === "/about.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(markdownDocs(env)["/about"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/about.html", url.origin), req));
  }

  // Contact page
  if (url.pathname === "/contact" || url.pathname === "/contact.html" || url.pathname === "/contact.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(markdownDocs(env)["/contact"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/contact.html", url.origin), req));
  }

  // Privacy policy page
  if (url.pathname === "/terms" || url.pathname === "/terms/" || url.pathname === "/terms.html") {
    return env.ASSETS.fetch(new Request(new URL("/terms.html", url.origin), req));
  }

  if (url.pathname === "/privacy" || url.pathname === "/privacy.html" || url.pathname === "/privacy.md") {
    if (wantsMarkdown(req, url)) {
      return renderMarkdownResponse(markdownDocs(env)["/privacy"]);
    }
    return env.ASSETS.fetch(new Request(new URL("/privacy.html", url.origin), req));
  }

  // iPhone setup page is public
  if (url.pathname === "/iphone" || url.pathname === "/iphone.html" || url.pathname === "/siri" || url.pathname === "/siri.html") {
    return env.ASSETS.fetch(new Request(new URL("/iphone.html", url.origin), req));
  }

  // Setup is automatic — old /setup and /download paths go to signup
  if (url.pathname === "/setup" || url.pathname === "/setup/" || url.pathname === "/setup.html") {
    return Response.redirect(new URL("/signup", url.origin).toString(), 301);
  }
  if (url.pathname === "/go-max" || url.pathname === "/go-max/" || url.pathname === "/gomax") {
    return env.ASSETS.fetch(new Request(new URL("/go-max.html", url.origin), req));
  }
  if (url.pathname === "/download" || url.pathname === "/download/") {
    return Response.redirect(new URL("/signup", url.origin).toString(), 301);
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

  // ORAL (voice-listen stage) product page
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
    url.pathname === "/api/missions" ||
    url.pathname === "/api/v1/missions" ||
    url.pathname === "/api/missions";
  const isStatsEndpoint =
    url.pathname === "/api/stats" ||
    url.pathname === "/api/v1/stats" ||
    url.pathname === "/api/stats";
  const missionDetailMatch = url.pathname.match(
    /^\/api\/(?:v1\/missions|missions)\/([^/]+)$/
  );
  const missionGoMaxMatch = url.pathname.match(
    /^\/api\/(?:v1\/missions|missions)\/([^/]+)\/go-max$/
  );
  const missionActMatch = url.pathname.match(
    /^\/api\/(?:v1\/missions|missions)\/([^/]+)\/act$/
  );
  const isMissionsApi =
    isMissionsEndpoint ||
    isStatsEndpoint ||
    Boolean(missionDetailMatch) ||
    Boolean(missionGoMaxMatch) ||
    Boolean(missionActMatch);

  if (isBoardHtml || isMissionsApi) {
    const verified = await getVerifiedUser(req, env);
    if (!verified || !verified.isOwnerUser) {
      if (isMissionsApi) {
        return Response.json(
          { error: "Forbidden - owner only. Sign in at /login/ or Bearer ALFRED_OPS_TOKEN" },
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
      return proxyMissionsStats(env);
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
  const user = await getVerifiedUser(req, env);
  if (!user) {
    // If not matching any authenticated route, return a friendly 404
    return render404(req, url);
  }

  // Authenticated routes
  const tenant_id = user.tenant_id;
  const stub = env.ALFRED.getByName(tenant_id);

  // ─── Agent tokens for the MCP (per tenant, scoped; owner may mint for any tenant) ───
  if (url.pathname === "/api/alfred/agent-tokens" || url.pathname.startsWith("/api/alfred/agent-tokens/")) {
    return handleAgentTokens(req, env, url, user);
  }

  // ─── Alfred (Pi harness in the tenant's Durable Object) ──────────
  if (url.pathname.startsWith("/api/alfred/")) {
    await stub.bind(tenant_id, user.isOwner);
    // Sandbox tenants (every signed-in non-owner): chat/ask within a daily quota only.
    const ownerOnly = req.method === "POST" && (url.pathname === "/api/alfred/missions" || url.pathname === "/api/alfred/intake");
    if (ownerOnly && !user.isOwner) {
      return Response.json({ error: "sandbox", message: "Missions and intake are for the instance owner. Your sandbox can ask." }, { status: 403 });
    }
    if (url.pathname === "/api/alfred/missions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { objective?: string; wait?: boolean; requireEvidence?: boolean };
      const objective = (body.objective || "").trim().slice(0, 4000);
      if (objective.length < 3) return Response.json({ error: "objective required" }, { status: 400 });
      const opts = { requireEvidence: body.requireEvidence ?? false };
      return Response.json(body.wait ? await stub.runMission(objective, opts) : await stub.startMission(objective, opts));
    }
    const m = url.pathname.match(/^\/api\/alfred\/missions\/([A-Za-z0-9-]{8,64})$/);
    if (m && req.method === "GET") {
      const mission = await stub.getMission(m[1]);
      return mission ? Response.json(mission) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === "/api/alfred/gates" && req.method === "GET" && user.isOwner) {
      // Owner health check of the Clef gates, from the Worker and from the tenant object.
      const worker = await clefGates(env as never).done("say hi", "hi", "replied hi");
      return Response.json({ worker, agent: await stub.gateHealth() });
    }
    if (url.pathname === "/api/alfred/report" && req.method === "GET") {
      // The Report (what WAKE speaks): recent missions, success/fail, synopsis, attention.
      return Response.json(await stub.report());
    }
    const lm = url.pathname.match(/^\/api\/alfred\/lessons\/([A-Za-z0-9-]{8,64})$/);
    if (lm && req.method === "DELETE") {
      if (!user.isOwner) return Response.json({ error: "owner only" }, { status: 403 });
      return Response.json(await stub.forgetLesson(lm[1]));
    }
    if (url.pathname === "/api/alfred/lessons" && req.method === "GET") {
      return Response.json({ lessons: await stub.listLessons(20) });
    }
    if (url.pathname === "/api/alfred/ask" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { prompt?: string };
      const prompt = (body.prompt || "").trim().slice(0, 8000);
      if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
      const q = await stub.consumeQuota("ask", sandboxLimit(env.SANDBOX_ASKS_PER_DAY, 30));
      if (!q.ok) return Response.json({ error: "quota", used: q.used, limit: q.limit }, { status: 429 });
      return Response.json(await stub.ask(prompt));
    }
    if (url.pathname === "/api/alfred/intake" && req.method === "POST") {
      // Clairic extraction. Body: {kind:"email",subject?,body} | {kind:"voice",transcript?|audioBase64?}
      //   | {kind:"image",images:[{content_type,base64}],caption?}. Max 16 MiB (Clairic request limit).
      const len = Number(req.headers.get("content-length") || 0);
      if (len > 16 * 1024 * 1024) return Response.json({ error: "too large" }, { status: 413 });
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const kind = body?.kind;
      if (kind === "email" && typeof body?.body === "string") {
        return Response.json(await stub.intake({ kind, body: body.body, subject: typeof body.subject === "string" ? body.subject : undefined }));
      }
      if (kind === "voice" && (typeof body?.transcript === "string" || typeof body?.audioBase64 === "string")) {
        return Response.json(await stub.intake({ kind, transcript: body.transcript as string | undefined, audioBase64: body.audioBase64 as string | undefined }));
      }
      if (kind === "image" && Array.isArray(body?.images) && body.images.length) {
        const images = (body.images as Array<{ content_type?: unknown; base64?: unknown }>)
          .filter((i) => typeof i?.base64 === "string" && typeof i?.content_type === "string")
          .slice(0, 4)
          .map((i) => ({ content_type: String(i.content_type), base64: String(i.base64) }));
        if (!images.length) return Response.json({ error: "images[{content_type,base64}] required" }, { status: 400 });
        return Response.json(await stub.intake({ kind, images, caption: typeof body.caption === "string" ? body.caption : undefined }));
      }
      return Response.json({ error: "kind email|voice|image with matching fields required" }, { status: 400 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Authenticated home → Missions board (KISS)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if ((await ownerFromRequest(req, env))) {
      return env.ASSETS.fetch(new Request(new URL("/app.html", url.origin), req));
    }
    return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
  }

  // User info
  if (url.pathname === "/api/me") {
    return Response.json({ name: user.email.split("@")[0], tenant_id: user.tenant_id, email: user.email });
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
    return render404(req, url);
  }

  return render404(req, url);
}

// ─── MCP (Alfred for agents) ────────────────────────────────────

const MCP_REALM = 'Bearer realm="alfred-mcp", error="invalid_token"';

/** Access JWT / owner ops token (all scopes) or a per-tenant scoped agent token. No anonymous access. */
async function mcpIdentity(req: Request, env: Env): Promise<MCPIdentity | null> {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const tok = await verifyAgentToken(env, auth.slice(7).trim());
    if (tok) {
      return { email: `agent:${tok.name}`, tenant_id: tok.tenant_id, isOwner: false, via: "agent_token", scopes: tok.scopes, tokenId: tok.id };
    }
  }
  const user = await getVerifiedUser(req, env);
  return user ? { ...user, scopes: fullScopes() } : null;
}

async function serveMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: "POST, GET, OPTIONS" } });
  const who = await mcpIdentity(req, env);
  if (!who) return mcpError(null, -32001, "unauthorized", 401, { "WWW-Authenticate": MCP_REALM });
  if (req.method === "GET") {
    // No server-initiated stream; describe the endpoint to the authenticated caller.
    return Response.json({ name: "alfred-report", transport: "streamable-http (POST JSON-RPC)", tenant: who.tenant_id, scopes: who.scopes }, { headers: { Allow: "POST, GET" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, GET" } });
  const { handleMCP } = await import("./mcp/server");
  return handleMCP(req, env, who);
}

async function handleMcpHost(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/mcp" || url.pathname === "/") return serveMcp(req, env);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "alfred-mcp", endpoint: `https://mcp.${env.DOMAIN}/mcp`, auth: "bearer (agent token or owner token) or Cloudflare Access" });
  return Response.json({ error: "not found", endpoint: `https://mcp.${env.DOMAIN}/mcp` }, { status: 404 });
}

async function handleAgentTokens(
  req: Request,
  env: Env,
  url: URL,
  user: VerifiedIdentity & { isOwnerUser: boolean }
): Promise<Response> {
  const scopeTenant = user.isOwner ? undefined : user.tenant_id;
  const one = url.pathname.match(/^\/api\/alfred\/agent-tokens\/([0-9a-f-]{36})$/);
  if (one && req.method === "DELETE") {
    const ok = await revokeAgentToken(env, one[1], scopeTenant);
    return Response.json({ revoked: ok }, { status: ok ? 200 : 404 });
  }
  if (url.pathname !== "/api/alfred/agent-tokens") return Response.json({ error: "not found" }, { status: 404 });
  if (req.method === "GET") {
    const tenant = user.isOwner ? url.searchParams.get("tenant") || undefined : user.tenant_id;
    return Response.json({ tokens: await listAgentTokens(env, tenant) });
  }
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; scopes?: unknown; tenant_id?: string };
    const name = String(body.name || "").trim();
    if (!name) return Response.json({ error: "name required" }, { status: 400 });
    let scopes;
    try {
      scopes = parseScopes(body.scopes ?? ["missions:read", "report:read"]);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    // Only the owner can mint for another tenant (or grant missions:write on the owner tenant).
    const tenant_id = user.isOwner && body.tenant_id ? String(body.tenant_id) : user.tenant_id;
    if (!/^[a-z0-9_-]{1,200}$/i.test(tenant_id)) return Response.json({ error: "invalid tenant_id" }, { status: 400 });
    const minted = await mintAgentToken(env, { tenant_id, name, scopes, created_by: user.email });
    return Response.json({ ...minted, endpoint: `https://mcp.${env.DOMAIN}/mcp`, note: "Shown once; store it as a secret." }, { status: 201 });
  }
  return new Response(null, { status: 405 });
}
