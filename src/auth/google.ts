import type { Env } from "../types";
import { signSession, setSessionCookie } from "./session";
import { issueSiriToken } from "../siri/tokens";

const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function redirectUri(): string {
  return "https://alfred.report/auth/google/callback";
}

export function googleStart(env: Env, _requestUrl: string): Response {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return Response.json({ error: "Google sign-in is not configured" }, { status: 500 });
  const state = crypto.randomUUID();
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPES.join(" "));
  auth.searchParams.set("state", state);
  auth.searchParams.set("access_type", "online");
  auth.searchParams.set("include_granted_scopes", "false");
  auth.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      "Set-Cookie": `alfred_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

export async function googleCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return Response.redirect(new URL("/?auth=error", url.origin).toString(), 302);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const cookie = request.headers.get("Cookie") || "";
  const expected = cookie.match(/(?:^|; )alfred_oauth_state=([^;]+)/)?.[1] || "";
  if (!code || !state || !expected || state !== expected) {
    return Response.redirect(new URL("/?auth=state", url.origin).toString(), 302);
  }
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    return Response.json({ error: "Google sign-in is not configured" }, { status: 500 });
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokens = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenRes.ok || !tokens.access_token) {
    return Response.redirect(new URL("/?auth=token", url.origin).toString(), 302);
  }
  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await userRes.json<{ email?: string; email_verified?: boolean | string }>();
  const verified = profile.email_verified === true || profile.email_verified === "true";
  if (!profile.email || !verified) {
    return Response.redirect(new URL("/?auth=unverified", url.origin).toString(), 302);
  }
  const email = profile.email.toLowerCase();
  await issueSiriToken(env, email);
  const signed = await signSession(sessionSecret, {
    email,
    userId: email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  });
  const headers = new Headers();
  headers.append("Location", "/board");
  headers.append("Set-Cookie", setSessionCookie(signed));
  headers.append("Set-Cookie", "alfred_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
