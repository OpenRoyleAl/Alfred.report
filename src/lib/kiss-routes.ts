import type { Env } from "./env";
import { checkDomainAvailability, createCheckoutSession, handleStripeWebhook } from "./billing";
import {
  chatTurn,
  clearSessionCookie,
  createMission,
  dashboard,
  jsonAuthRequired,
  login,
  mintBlocked,
  mintSession,
  nameAvailable,
  readSession,
  setSessionCookie,
  signup,
  storeByokFingerprint,
  wizardGet,
  wizardPatch,
} from "./kiss";

function cookieHeaders(token: string, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set("Set-Cookie", setSessionCookie(token));
  h.set("Cache-Control", "no-store");
  return h;
}

export async function handleKissApi(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (
    (url.pathname === "/api/billing/webhook" || url.pathname === "/api/stripe/webhook") &&
    req.method === "POST"
  ) {
    return handleStripeWebhook(req, env);
  }

  // Domain availability + at-cost estimate (public; aliases outside /api/kiss/)
  if (
    (url.pathname === "/api/kiss/domain-check" || url.pathname === "/api/domain/check") &&
    req.method === "GET"
  ) {
    const q = url.searchParams.get("domain") || url.searchParams.get("name") || "";
    const result = await checkDomainAvailability(env, q);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  // Stripe Checkout: subscription ($99/mo) + domain at cost (public; email optional)
  if (
    (url.pathname === "/api/kiss/checkout" || url.pathname === "/api/billing/checkout") &&
    req.method === "POST"
  ) {
    const body = (await req.json().catch(() => ({}))) as {
      domain?: string;
      handle?: string;
      email?: string;
      country?: string;
    };
    const domainRaw = body.domain || body.handle || "";
    const check = await checkDomainAvailability(env, domainRaw);
    if (!check.ok || !check.domain) {
      return Response.json({ error: check.error || "Invalid domain" }, { status: 400 });
    }
    if (check.available === false) {
      return Response.json({ error: "Domain not available", domain: check.domain }, { status: 409 });
    }
    const origin = new URL(req.url).origin;
    const handle = (body.handle || check.domain.split(".")[0] || "").toLowerCase();
    const session = await createCheckoutSession(env, {
      domain: check.domain,
      email: body.email,
      handle,
      country: body.country || req.headers.get("CF-IPCountry") || undefined,
      domainCostCents: check.cost_cents || 1200,
      successUrl: `${origin}/home?paid=1&domain=${encodeURIComponent(check.domain)}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/signup?handle=${encodeURIComponent(handle)}&domain=${encodeURIComponent(check.domain)}&cancelled=1`,
    });
    if (!session.ok) return Response.json({ error: session.error }, { status: session.status });
    return Response.json({
      ok: true,
      url: session.url,
      session_id: session.session_id,
      domain: check.domain,
      cost_cents: check.cost_cents,
      hold_note: check.hold_note,
    });
  }

  // Remaining KISS API is under /api/kiss/ only
  if (!url.pathname.startsWith("/api/kiss/")) return null;

  if (url.pathname === "/api/kiss/name-available" && req.method === "GET") {
    const q = url.searchParams.get("name") || "";
    const result = await nameAvailable(env, q);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  }

  if (url.pathname === "/api/kiss/signup" && req.method === "POST") {
    const body = (await req.json()) as { email?: string; password?: string; name?: string; handle?: string };
    const result = await signup(env, body.email || "", body.password || "", body.name, body.handle);
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    const token = await mintSession(env, result.user);
    return Response.json(
      { ok: true, tenant_id: result.user.tenant_id, name: result.user.name, email: result.user.email },
      { headers: cookieHeaders(token, { "Content-Type": "application/json" }) }
    );
  }

  if (url.pathname === "/api/kiss/login" && req.method === "POST") {
    const body = (await req.json()) as { email?: string; password?: string };
    const result = await login(env, body.email || "", body.password || "");
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    const token = await mintSession(env, result.user);
    return Response.json(
      { ok: true, tenant_id: result.user.tenant_id, name: result.user.name, email: result.user.email },
      { headers: cookieHeaders(token, { "Content-Type": "application/json" }) }
    );
  }

  if (url.pathname === "/api/kiss/logout" && req.method === "POST") {
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" } }
    );
  }

  const user = await readSession(req, env);
  if (!user) return jsonAuthRequired();

  if (url.pathname === "/api/kiss/me" && req.method === "GET") {
    return Response.json({ name: user.name, email: user.email, tenant_id: user.tenant_id, lane: "kiss" });
  }

  if (url.pathname === "/api/kiss/dashboard" && req.method === "GET") {
    return Response.json(await dashboard(env, user));
  }

  if (url.pathname === "/api/kiss/missions" && req.method === "POST") {
    const body = (await req.json()) as { objective?: string };
    if (!body.objective?.trim()) return Response.json({ error: "objective required" }, { status: 400 });
    return Response.json(await createMission(env, user.tenant_id, body.objective.trim()));
  }

  if (url.pathname === "/api/kiss/chat" && req.method === "POST") {
    const body = (await req.json()) as { message?: string };
    if (!body.message?.trim()) return Response.json({ error: "message required" }, { status: 400 });
    const result = await chatTurn(env, user, body.message.trim());
    if ("error" in result) {
      return Response.json(result, { status: result.status || 429 });
    }
    return Response.json(result);
  }

  if (url.pathname === "/api/kiss/byok" && req.method === "POST") {
    const body = (await req.json()) as { key?: string };
    if (!body.key?.trim()) return Response.json({ error: "key required" }, { status: 400 });
    return Response.json(await storeByokFingerprint(env, user.tenant_id, body.key));
  }

  if ((url.pathname === "/api/kiss/start" || url.pathname === "/api/kiss/wizard") && req.method === "GET") {
    return Response.json(await wizardGet(env, user.tenant_id));
  }

  if ((url.pathname === "/api/kiss/start" || url.pathname === "/api/kiss/wizard") && req.method === "POST") {
    const body = (await req.json()) as {
      step?: number;
      invited_al?: boolean;
      domain?: string;
      notes?: string;
    };
    return Response.json(await wizardPatch(env, user.tenant_id, body));
  }

  if (url.pathname === "/api/kiss/mint" && (req.method === "POST" || req.method === "GET")) {
    const blocked = mintBlocked(user);
    if (blocked) return blocked;
    return Response.json({
      error: "Iceberg Token Master never mints for customers. Use Token Master on your Cloudflare account.",
    }, { status: 403 });
  }

  return Response.json({ error: "Unknown KISS route" }, { status: 404 });
}
