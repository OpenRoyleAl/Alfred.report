/**
 * Cloudflare Access identity — VERIFIED only.
 *
 * Never trust `Cf-Access-Authenticated-User-Email` or a decoded-but-unverified
 * `CF_Authorization` cookie: both can be forged by any client when a path is not
 * behind Access. We verify the Access JWT signature (RS256, team JWKS), issuer and
 * audience, and only then read the email claim.
 *
 * Per-account config (vars): ACCESS_TEAM_DOMAIN (e.g. "myteam.cloudflareaccess.com"),
 * ACCESS_AUD (the Access application AUD tag), OWNER_EMAILS (comma separated).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAILS?: string;
}

export interface VerifiedIdentity {
  email: string;
  tenant_id: string;
  isOwner: boolean;
  via: "access" | "ops_token" | "agent_token" | "session";
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(team: string) {
  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  return jwks;
}

export function accessToken(req: Request): string | null {
  const header = req.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export function ownerEmails(env: AccessEnv): string[] {
  return (env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(env: AccessEnv, email: string | null | undefined): boolean {
  const e = (email || "").toLowerCase().trim();
  return !!e && ownerEmails(env).includes(e);
}

/**
 * Stable tenant id derived from a VERIFIED email only. Injective: [a-z0-9] kept, every other
 * byte becomes `_xx` (hex), so "jo.bloggs@x.com", "jobloggs@x.com" and "jo.bloggs@y.com" are
 * three tenants. (The old local-part-only id let a sandbox user on another domain share the
 * owner's tenant.)
 */
export function tenantFromEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!e) return "default";
  let out = "";
  for (const b of new TextEncoder().encode(e)) {
    const c = String.fromCharCode(b);
    out += /[a-z0-9]/.test(c) ? c : `_${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** Returns the verified Access email, or null (missing config, missing/invalid token). */
export async function verifyAccessEmail(req: Request, env: AccessEnv): Promise<string | null> {
  const team = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  // ACCESS_AUD may list several Access apps (comma separated), e.g. the site app and an MCP app.
  const aud = (env.ACCESS_AUD || "").split(",").map((a) => a.trim()).filter(Boolean);
  if (!team || !aud.length) return null; // fail closed
  const token = accessToken(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwksFor(team), {
      issuer: `https://${team}`,
      audience: aud,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase().trim() : "";
    return email || null;
  } catch {
    return null;
  }
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
