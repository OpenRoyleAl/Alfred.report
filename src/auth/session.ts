import type { Env } from "../types";

export type Session = { email: string; userId: string; exp: number };

const COOKIE = "alfred_session";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of bin) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(secret: string, session: Session): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(session)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function readSession(secret: string, token: string | undefined): Promise<Session | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)));
  const given = b64urlDecode(sig);
  if (expected.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
  if (diff !== 0) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Session;
    if (!session.email || session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

export function sessionCookieValue(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/(?:^|; )alfred_session=([^;]+)/);
  return match?.[1];
}

export async function getSession(env: Env, c: { req: { header: (name: string) => string | undefined } }): Promise<Session | null> {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  return readSession(secret, sessionCookieValue(c));
}

export function setSessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function hasAccessServiceToken(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return Boolean(c.req.header("CF-Access-Client-Id") && c.req.header("CF-Access-Client-Secret"));
}
