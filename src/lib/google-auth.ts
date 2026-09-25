/**
 * Google OAuth for Alfred.report! — browser + CLI `alfred-pi login` / `alfred-grok login`.
 * No API-key hell: session cookie after Google; CF account linking is later in /start.
 */
import type { Env } from "./env";
import { secretGet } from "./secret";
import {
  ensureKissSchema,
  mintSession,
  nameAvailable,
  normalizeHandle,
  setSessionCookie,
  type KissUser,
} from "./kiss";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

async function clientId(env: Env): Promise<string> {
  return (await secretGet(env.GOOGLE_CLIENT_ID)) || (await secretGet(env.GOOGLE_OAUTH_CLIENT_ID));
}
async function clientSecret(env: Env): Promise<string> {
  return (await secretGet(env.GOOGLE_CLIENT_SECRET)) || (await secretGet(env.GOOGLE_OAUTH_CLIENT_SECRET));
}

function b64url(buf: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof buf === "string") bytes = new TextEncoder().encode(buf);
  else if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
  else bytes = buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signState(env: Env, payload: object): Promise<string> {
  const secret = (await secretGet(env.JWT_SECRET)) || (await clientSecret(env)) || "alfred-dev-state";
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyState(env: Env, state: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const secret = (await secretGet(env.JWT_SECRET)) || (await clientSecret(env)) || "alfred-dev-state";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expect = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  if (expect !== sig) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function upsertGoogleUser(
  env: Env,
  profile: { email: string; name?: string; sub: string },
  preferredHandle?: string
): Promise<KissUser> {
  const email = profile.email.toLowerCase().trim();
  const name = (profile.name || email.split("@")[0] || "user").slice(0, 80);
  await ensureKissSchema(env.DB);

  try {
    await env.DB.prepare(`ALTER TABLE kiss_users ADD COLUMN google_sub TEXT`).run();
  } catch {
    /* column may exist */
  }

  const existing = await env.DB
    .prepare(`SELECT email, name, tenant_id, billing_paid FROM kiss_users WHERE email = ?`)
    .bind(email)
    .first<{ email: string; name: string; tenant_id: string; billing_paid: number }>();

  if (existing) {
    try {
      await env.DB.prepare(`UPDATE kiss_users SET google_sub = ?, name = COALESCE(NULLIF(?, ''), name) WHERE email = ?`)
        .bind(profile.sub, name, email)
        .run();
    } catch {
      /* ignore */
    }
    return {
      email: existing.email,
      name: existing.name || name,
      tenant_id: existing.tenant_id,
      billing_paid: existing.billing_paid || 0,
    };
  }

  let tenant_id = preferredHandle ? normalizeHandle(preferredHandle) : normalizeHandle(email.split("@")[0] || "user");
  const avail = await nameAvailable(env, tenant_id);
  if (!avail.ok) {
    tenant_id = normalizeHandle(`${tenant_id}${crypto.randomUUID().slice(0, 4)}`);
  } else {
    tenant_id = avail.name;
  }

  const now = Date.now();
  // Google users: empty password hash; login is OAuth-only
  await env.DB.prepare(
    `INSERT INTO kiss_users (email, name, tenant_id, pass_salt, pass_hash, lane, billing_paid, created_at)
     VALUES (?, ?, ?, 'google', ?, 'kiss', 0, ?)`
  )
    .bind(email, name, tenant_id, `google:${profile.sub}`, now)
    .run();

  try {
    await env.DB.prepare(`UPDATE kiss_users SET google_sub = ? WHERE email = ?`).bind(profile.sub, email).run();
  } catch {
    /* ignore */
  }

  return { email, name, tenant_id, billing_paid: 0 };
}

export async function handleGoogleAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/$/, "");
  const isStart =
    path === "/api/auth/google/start" ||
    path === "/api/auth/oauth2/start/grok-google" ||
    path === "/api/auth/oauth2/start/google";
  const isCallback =
    path === "/api/auth/google/callback" ||
    path === "/api/auth/oauth2/callback/grok-google" ||
    path === "/api/auth/oauth2/callback/google";

  if (!isStart && !isCallback) return null;

  const id = await clientId(env);
  const secret = await clientSecret(env);
  if (!id || !secret) {
    return Response.json({ error: "Google sign-in not configured on this deploy" }, { status: 503 });
  }

  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/google/callback`;

  if (isStart && (req.method === "GET" || req.method === "POST")) {
    let callbackURL = "/home";
    let handle = "";
    if (req.method === "POST") {
      try {
        const body = (await req.json()) as { callbackURL?: string; handle?: string };
        if (body.callbackURL && body.callbackURL.startsWith("/")) callbackURL = body.callbackURL;
        if (body.handle) handle = String(body.handle).slice(0, 32);
      } catch {
        /* empty */
      }
    } else {
      callbackURL = url.searchParams.get("callbackURL") || "/home";
      if (!callbackURL.startsWith("/")) callbackURL = "/home";
      handle = url.searchParams.get("handle") || "";
    }
    const state = await signState(env, {
      cb: callbackURL,
      handle,
      t: Date.now(),
      n: crypto.randomUUID(),
    });
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "online",
      include_granted_scopes: "true",
      prompt: "select_account",
      state,
    });
    const authUrl = `${GOOGLE_AUTH}?${q}`;
    if (req.method === "GET" && url.searchParams.get("redirect") === "1") {
      return Response.redirect(authUrl, 302);
    }
    return Response.json({ url: authUrl, ok: true });
  }

  if (isCallback && req.method === "GET") {
    const err = url.searchParams.get("error");
    if (err) {
      return Response.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, origin).toString(), 302);
    }
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state") || "";
    const state = await verifyState(env, stateRaw);
    if (!code || !state) {
      return Response.redirect(new URL("/login?error=bad_state", origin).toString(), 302);
    }
    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token) {
      return Response.redirect(new URL("/login?error=token", origin).toString(), 302);
    }
    const ui = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const profile = (await ui.json()) as { email?: string; name?: string; sub?: string };
    if (!profile.email || !profile.sub) {
      return Response.redirect(new URL("/login?error=profile", origin).toString(), 302);
    }
    const preferred = typeof state.handle === "string" ? state.handle : undefined;
    const user = await upsertGoogleUser(
      env,
      { email: profile.email, name: profile.name, sub: profile.sub },
      preferred
    );
    const session = await mintSession(env, user);
    let cb = typeof state.cb === "string" && state.cb.startsWith("/") ? state.cb : "/home";
    // New unpaid users go to signup/subscribe with their handle
    if (!user.billing_paid && (cb === "/home" || cb === "/")) {
      cb = `/signup?handle=${encodeURIComponent(user.tenant_id)}`;
    }
    const dest = new URL(cb, origin);
    if (preferred) dest.searchParams.set("handle", preferred);
    return new Response(null, {
      status: 302,
      headers: {
        Location: dest.toString(),
        "Set-Cookie": setSessionCookie(session),
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
