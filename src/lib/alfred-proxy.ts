import type { Env } from "./env";

async function opsBearer(env: Env): Promise<string> {
  const raw = env.ALFRED_OPS_TOKEN;
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (typeof (raw as { get?: () => Promise<string> }).get === "function") {
    return (raw as { get: () => Promise<string> }).get();
  }
  return "";
}

/** Forward alfred.report /api/proxy/* → alfred-proxy Worker. */
export async function handleAlfredProxy(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/proxy/")) return null;

  // Public probe (no auth) — CF edge reachability only
  if (url.pathname === "/api/proxy/probe-fetch" && req.method === "GET") {
    const target = url.searchParams.get("url") || "https://agentic-football.aws.dev/v2/player/login";
    const started = Date.now();
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": "AlfredProxyProbe/1.0", Accept: "text/html" },
        redirect: "follow",
      });
      const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      return Response.json({
        via: "cloudflare-worker-fetch",
        broker: "https://proxy.alfred.report",
        url: target,
        status: res.status,
        ok: res.ok,
        latencyMs: Date.now() - started,
        snippet,
      });
    } catch (err) {
      return Response.json({ error: String(err), latencyMs: Date.now() - started }, { status: 502 });
    }
  }

  if (!env.ALFRED_PROXY) {
    return Response.json({ error: "ALFRED_PROXY binding missing" }, { status: 503 });
  }

  const token = await opsBearer(env);
  const hdr = req.headers.get("authorization") || "";
  const bearer = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
  const opsHdr = req.headers.get("x-alfred-ops-token") || "";
  if (!token || (bearer !== token && opsHdr !== token)) {
    return Response.json(
      { error: "unauthorized", hint: "Authorization: Bearer <ALFRED_OPS_TOKEN>" },
      { status: 401 },
    );
  }

  const proxyPath = url.pathname.replace(/^\/api\/proxy/, "") || "/";
  const upstreamPath = `${proxyPath}${url.search}`;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", req.headers.get("content-type") || "application/json");
  headers.set("X-Forwarded-By", "alfred.report");

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const upstream = await env.ALFRED_PROXY.fetch(
    new Request(`https://proxy.alfred.report${upstreamPath}`, init),
  );
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "X-Alfred-Proxy": "forwarded",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
