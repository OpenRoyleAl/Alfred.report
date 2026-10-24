/**
 * Signed, expiring OAuth `state` (Google sign-in). Fail closed with no secret;
 * compare HMAC in constant time; reject states older than 15 minutes.
 */
import { safeEqual } from "./access.ts";
import { secretGet, type SecretValue } from "./secret.ts";

export const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

export type OAuthStateEnv = {
  JWT_SECRET?: SecretValue;
  GOOGLE_CLIENT_SECRET?: SecretValue;
};

function b64url(buf: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof buf === "string") bytes = new TextEncoder().encode(buf);
  else if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
  else bytes = buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function stateSecret(env: OAuthStateEnv): Promise<string> {
  const jwt = await secretGet(env.JWT_SECRET);
  if (jwt) return jwt;
  return (await secretGet(env.GOOGLE_CLIENT_SECRET)) || "";
}

export async function signOAuthState(env: OAuthStateEnv, payload: object): Promise<string> {
  const secret = await stateSecret(env);
  if (!secret) throw new Error("oauth state secret not configured");
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

export async function verifyOAuthState(env: OAuthStateEnv, state: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const secret = await stateSecret(env);
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expect = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  if (!safeEqual(expect, sig)) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const t = typeof parsed.t === "number" ? parsed.t : 0;
    if (!t || Date.now() - t > OAUTH_STATE_MAX_AGE_MS || t > Date.now() + 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}
