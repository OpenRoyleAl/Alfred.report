/**
 * KISS lane — email session, D1 missions/spend/memory. No tokens in responses.
 * Customers mint tokens only on their own Cloudflare account.
 */

import type { Env } from "./env";
import { secretGet } from "./secret.ts";
import { completeText } from "../alfred/models.ts";
import { isOwnerEmail, safeEqual } from "./access.ts";
import { invalidateOwnerCache, ownerTenant } from "./tenant.ts";

/** __Host- prefix: Secure, Path=/, no Domain (no subdomain or http overwrite). */
export const KISS_COOKIE = "__Host-alfred_kiss";
/** Pre-prefix cookie name; still read, re-issued under KISS_COOKIE and cleared (see sessionMigration). */
export const LEGACY_KISS_COOKIE = "alfred_kiss";
/** Sessions signed with the ops token (before ALFRED_SESSION_KEY) verify until here; cookies live 7 days. */
export const LEGACY_SIGNER_UNTIL = Date.parse("2026-11-07T00:00:00Z");
/** Workers caps PBKDF2 at 100k iterations. */
export const PBKDF2_ITERATIONS = 100_000;
const LEGACY_PBKDF2_ITERATIONS = 10_000;
export const NEURON_CAP = 10_000;
export const CHAT_NEURONS_MIN = 17;

export type KissUser = {
  email: string;
  name: string;
  tenant_id: string;
  billing_paid: number;
  /** Row created by Google sign-in (verified email). */
  google?: boolean;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Session signing keys. ALFRED_SESSION_KEY may hold "new,old": the first signs, every one verifies,
 * so a rotation keeps users signed in. The ops token verifies (never signs) until LEGACY_SIGNER_UNTIL.
 */
export async function sessionKeys(env: Env, now = Date.now()): Promise<{ sign: string; verify: string[]; legacy: string[] }> {
  const keys = (await secretGet(env.ALFRED_SESSION_KEY as any)).split(",").map((k) => k.trim()).filter((k) => k.length >= 32);
  const legacy: string[] = [];
  if (now < LEGACY_SIGNER_UNTIL) {
    const ops = await secretGet(env.ALFRED_OPS_TOKEN as any);
    if (ops) legacy.push(ops);
  }
  return { sign: keys[0] || "", verify: keys, legacy };
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string, iterations = LEGACY_PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations,
    },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stored hash: "p2$<iterations>$<hex>"; a bare hex hash is the legacy 10k-iteration format. */
export async function makePasswordHash(password: string, salt: string): Promise<string> {
  return `p2$${PBKDF2_ITERATIONS}$${await hashPassword(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function checkPassword(password: string, salt: string, stored: string): Promise<{ ok: boolean; upgrade: boolean }> {
  const m = stored.match(/^p2\$(\d+)\$([0-9a-f]+)$/);
  if (m) {
    const it = Number(m[1]);
    if (!(it >= LEGACY_PBKDF2_ITERATIONS && it <= PBKDF2_ITERATIONS)) return { ok: false, upgrade: false };
    const ok = safeEqual(await hashPassword(password, salt, it), m[2]);
    return { ok, upgrade: ok && it < PBKDF2_ITERATIONS };
  }
  const ok = safeEqual(await hashPassword(password, salt, LEGACY_PBKDF2_ITERATIONS), stored);
  return { ok, upgrade: ok };
}

const RESERVED_NAMES = new Set([
  "alfred",
  "al",
  "oral",
  "wake",
  "voice",
  "command",
  "report",
  "map",
  "mission",
  "missions",
  "admin",
  "root",
  "www",
  "mail",
  "api",
  "pi",
  "start",
  "login",
  "signup",
  "home",
  "openroyleal",
]);

function tenantFromEmail(email: string): string {
  const local = email.split("@")[0] || "user";
  return local.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 32) || "user";
}

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
}

export async function nameAvailable(
  env: Env,
  raw: string
): Promise<{ ok: boolean; name: string; error?: string }> {
  const name = normalizeHandle(raw);
  if (name.length < 3) return { ok: false, name, error: "At least 3 letters or numbers." };
  if (RESERVED_NAMES.has(name)) return { ok: false, name, error: "That name is taken." };
  await ensureKissSchema(env.DB);
  const row = await env.DB.prepare("SELECT tenant_id FROM kiss_users WHERE tenant_id = ?")
    .bind(name)
    .first();
  if (row) return { ok: false, name, error: "That name is taken." };
  return { ok: true, name };
}

export async function ensureKissSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'kiss',
      billing_paid INTEGER NOT NULL DEFAULT 0,
      byok_fp TEXT,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_missions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_spend (
      tenant_id TEXT NOT NULL,
      day TEXT NOT NULL,
      neurons INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, day)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_memory (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_wizard (
      tenant_id TEXT PRIMARY KEY,
      step INTEGER NOT NULL DEFAULT 1,
      invited_al INTEGER NOT NULL DEFAULT 0,
      domain TEXT,
      notes TEXT,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS kiss_users_tenant_id ON kiss_users(tenant_id)`),
    // Password signups wait here until the email link is opened; the tenant is claimed only then.
    db.prepare(`CREATE TABLE IF NOT EXISTS kiss_pending (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
}

export function setSessionCookie(token: string): string {
  return `${KISS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

/** Clears the legacy (unprefixed) cookie. */
export function clearLegacyCookie(): string {
  return `${LEGACY_KISS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function clearSessionCookie(): string {
  return `${KISS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Both Set-Cookie headers for logout. */
export function clearSessionCookies(): string[] {
  return [clearSessionCookie(), clearLegacyCookie()];
}

function cookieValue(raw: string, name: string): string {
  const esc = name.replace(/[-]/g, "\\-");
  return raw.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]+)`))?.[1] || "";
}

export async function mintSession(env: Env, user: KissUser): Promise<string> {
  const secret = (await sessionKeys(env)).sign;
  if (!secret) throw new Error("session secret not configured");
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${user.email}|${user.tenant_id}|${exp}`;
  const sig = await hmacHex(secret, payload);
  return btoa(`${payload}|${sig}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type SessionRead = { user: KissUser; reissue: boolean };

/**
 * Verify a session token. `reissue` is true when it came from the legacy cookie name or a non-primary key,
 * so the caller can re-mint it under the current cookie and key (no forced logout during migration/rotation).
 */
export async function readSessionEx(req: Request, env: Env): Promise<SessionRead | null> {
  const raw = req.headers.get("Cookie") || "";
  const current = cookieValue(raw, KISS_COOKIE);
  const legacyCookie = current ? "" : cookieValue(raw, LEGACY_KISS_COOKIE);
  const bearer = req.headers.get("Authorization") || "";
  const token = current || legacyCookie || (bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "");
  if (!token) return null;
  try {
    const pad = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
    const [email, tenant_id, expStr, sig] = atob(padded).split("|");
    if (!email || !tenant_id || !expStr || !sig) return null;
    if (Number(expStr) < Date.now()) return null;
    const keys = await sessionKeys(env);
    const msg = `${email}|${tenant_id}|${expStr}`;
    let idx = -1;
    const all = [...keys.verify, ...keys.legacy];
    for (let i = 0; i < all.length; i++) {
      if (safeEqual(await hmacHex(all[i], msg), sig)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    const reissue = Boolean(legacyCookie) || idx > 0;
    await ensureKissSchema(env.DB);
    const row = await env.DB.prepare(
      "SELECT email, name, tenant_id, billing_paid, pass_salt FROM kiss_users WHERE email = ?"
    )
      .bind(email.toLowerCase())
      .first<{ email: string; name: string; tenant_id: string; billing_paid: number; pass_salt: string }>();
    const owner = isOwnerEmail(env, email);
    // Owner emails always land on the ONE owner tenant (existing data), never a new/paywalled one.
    // A row-less owner session can only come from Google sign-in (password signup creates a row).
    if (owner && (!row || row.pass_salt === "google")) {
      return { user: { email: email.toLowerCase(), name: row?.name || "", tenant_id: await ownerTenant(env), billing_paid: 1, google: true }, reissue };
    }
    if (!row) return null;
    return {
      user: { email: row.email, name: row.name, tenant_id: row.tenant_id, billing_paid: row.billing_paid, google: row.pass_salt === "google" },
      reissue,
    };
  } catch {
    return null;
  }
}

export async function readSession(req: Request, env: Env): Promise<KissUser | null> {
  return (await readSessionEx(req, env))?.user ?? null;
}

/** Set-Cookie headers that move a legacy/old-key cookie session onto the current cookie and key. */
export async function sessionMigration(req: Request, env: Env): Promise<string[] | null> {
  const raw = req.headers.get("Cookie") || "";
  if (!raw.includes(LEGACY_KISS_COOKIE)) return null;
  const s = await readSessionEx(new Request(req.url, { headers: { Cookie: raw } }), env);
  if (!s?.reissue) return null;
  try {
    const out = [setSessionCookie(await mintSession(env, s.user))];
    if (cookieValue(raw, LEGACY_KISS_COOKIE)) out.push(clearLegacyCookie());
    return out;
  } catch {
    return null;
  }
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Password signup step 1: validate, hash, and park the request in kiss_pending. Nothing is claimed
 * (no kiss_users row, no tenant) until verifySignup runs with the emailed token.
 */
export async function signup(
  env: Env,
  email: string,
  password: string,
  name?: string,
  handle?: string
): Promise<{ pending: { email: string; tenant_id: string; token: string } } | { error: string; status: number }> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254 || password.length < 8 || password.length > 1024) {
    return { error: "Email and password (8+ chars) required", status: 400 };
  }
  await ensureKissSchema(env.DB);
  const existing = await env.DB.prepare("SELECT email FROM kiss_users WHERE email = ?")
    .bind(e)
    .first();
  if (existing) return { error: "Account exists — sign in", status: 409 };
  // Owner emails sign in with Google/Access only (a password signup would be an unverified claim).
  if (isOwnerEmail(env, e)) return { error: "Account exists — sign in with Google", status: 409 };
  let tenant_id = handle?.trim() ? normalizeHandle(handle) : tenantFromEmail(e);
  const avail = await nameAvailable(env, tenant_id);
  if (!avail.ok) return { error: avail.error || "That name is taken.", status: 409 };
  tenant_id = avail.name;
  const salt = crypto.randomUUID();
  const pass_hash = await makePasswordHash(password, salt);
  const display = (name || tenant_id || e.split("@")[0] || "Operator").slice(0, 80);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kiss_pending WHERE expires_at < ? OR email = ?").bind(now, e),
    env.DB.prepare(
      `INSERT INTO kiss_pending (token_hash, email, name, tenant_id, pass_salt, pass_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(await sha256Hex(token), e, display, tenant_id, salt, pass_hash, now + PENDING_TTL_MS, now),
  ]);
  return { pending: { email: e, tenant_id, token } };
}

/** Password signup step 2: the emailed token claims the tenant (re-checked: first verified wins). */
export async function verifySignup(env: Env, token: string): Promise<{ user: KissUser } | { error: string; status: number }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: "Invalid or expired link", status: 400 };
  await ensureKissSchema(env.DB);
  const th = await sha256Hex(token);
  const p = await env.DB.prepare("SELECT * FROM kiss_pending WHERE token_hash = ?")
    .bind(th)
    .first<{ email: string; name: string; tenant_id: string; pass_salt: string; pass_hash: string; expires_at: number }>();
  if (!p || p.expires_at < Date.now()) return { error: "Invalid or expired link", status: 400 };
  if (isOwnerEmail(env, p.email)) return { error: "Account exists — sign in with Google", status: 409 };
  const taken = await env.DB.prepare("SELECT email FROM kiss_users WHERE email = ? OR tenant_id = ?")
    .bind(p.email, p.tenant_id)
    .first();
  if (taken) {
    await env.DB.prepare("DELETE FROM kiss_pending WHERE token_hash = ?").bind(th).run();
    return { error: "That account or name was claimed first — sign up again", status: 409 };
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO kiss_users (email, name, tenant_id, pass_salt, pass_hash, lane, billing_paid, created_at)
       VALUES (?, ?, ?, ?, ?, 'kiss', 0, ?)`
    ).bind(p.email, p.name, p.tenant_id, p.pass_salt, p.pass_hash, Date.now()),
    env.DB.prepare("DELETE FROM kiss_pending WHERE email = ?").bind(p.email),
  ]);
  invalidateOwnerCache();
  return { user: { email: p.email, name: p.name, tenant_id: p.tenant_id, billing_paid: 0 } };
}

export async function login(
  env: Env,
  email: string,
  password: string
): Promise<{ user: KissUser } | { error: string; status: number }> {
  const e = email.trim().toLowerCase();
  await ensureKissSchema(env.DB);
  const row = await env.DB.prepare(
    "SELECT email, name, tenant_id, pass_salt, pass_hash, billing_paid FROM kiss_users WHERE email = ?"
  )
    .bind(e)
    .first<{
      email: string;
      name: string;
      tenant_id: string;
      pass_salt: string;
      pass_hash: string;
      billing_paid: number;
    }>();
  if (!row) return { error: "Unknown account", status: 401 };
  if (row.pass_salt === "google") return { error: "Sign in with Google", status: 401 };
  const chk = await checkPassword(password, row.pass_salt, row.pass_hash);
  if (!chk.ok) return { error: "Bad password", status: 401 };
  if (chk.upgrade) {
    // Upgrade-on-login: rehash at the current iteration count with a fresh salt.
    const salt = crypto.randomUUID();
    await env.DB.prepare("UPDATE kiss_users SET pass_salt = ?, pass_hash = ? WHERE email = ? AND pass_hash = ?")
      .bind(salt, await makePasswordHash(password, salt), row.email, row.pass_hash)
      .run();
  }
  return {
    user: {
      email: row.email,
      name: row.name,
      tenant_id: row.tenant_id,
      billing_paid: row.billing_paid,
    },
  };
}

export async function addSpend(env: Env, tenant_id: string, neurons: number, tokens: number): Promise<number> {
  const day = todayUtc();
  await env.DB.prepare(
    `INSERT INTO kiss_spend (tenant_id, day, neurons, tokens) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, day) DO UPDATE SET neurons = neurons + excluded.neurons, tokens = tokens + excluded.tokens`
  )
    .bind(tenant_id, day, neurons, tokens)
    .run();
  const row = await env.DB.prepare("SELECT neurons FROM kiss_spend WHERE tenant_id = ? AND day = ?")
    .bind(tenant_id, day)
    .first<{ neurons: number }>();
  return row?.neurons ?? neurons;
}

export async function getSpendToday(env: Env, tenant_id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT neurons FROM kiss_spend WHERE tenant_id = ? AND day = ?")
    .bind(tenant_id, todayUtc())
    .first<{ neurons: number }>();
  return row?.neurons ?? 0;
}

export async function createMission(env: Env, tenant_id: string, objective: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO kiss_missions (id, tenant_id, objective, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)"
  )
    .bind(id, tenant_id, objective.slice(0, 500), now, now)
    .run();
  return { id, tenant_id, objective: objective.slice(0, 500), state: "open", created_at: now };
}

export async function listMissions(env: Env, tenant_id: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, objective, state, created_at, updated_at FROM kiss_missions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50"
  )
    .bind(tenant_id)
    .all();
  return results || [];
}

export async function actMission(env: Env, tenant_id: string, id: string, act: string) {
  const state = act === "close" ? "closed" : act === "archive" ? "archived" : "open";
  await env.DB.prepare(
    "UPDATE kiss_missions SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  )
    .bind(state, Date.now(), id, tenant_id)
    .run();
  return { id, state };
}

export async function recallMemory(env: Env, tenant_id: string, limit = 10) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, created_at FROM kiss_memory WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(tenant_id, limit)
    .all();
  return results || [];
}

export async function remember(env: Env, tenant_id: string, text: string) {
  await env.DB.prepare("INSERT INTO kiss_memory (id, tenant_id, text, created_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), tenant_id, text.slice(0, 2000), Date.now())
    .run();
}

export async function memoryStatus(env: Env, tenant_id: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM kiss_memory WHERE tenant_id = ?")
    .bind(tenant_id)
    .first<{ n: number }>();
  return { adapter: "d1", rows: row?.n ?? 0, note: "Agent Memory when CF grants the product account." };
}

export async function dashboard(env: Env, user: KissUser) {
  const spent = await getSpendToday(env, user.tenant_id);
  const missions = await listMissions(env, user.tenant_id);
  const memory = await memoryStatus(env, user.tenant_id);
  const left = Math.max(0, NEURON_CAP - spent);
  return {
    name: user.name,
    email: user.email,
    tenant_id: user.tenant_id,
    lane: "kiss",
    gateway: "alfred",
    spend: { neurons_today: spent, daily_cap: NEURON_CAP, neurons_left: left },
    missions,
    memory,
    connect_cloudflare: { enabled: false, href: "/start", copy: "Connect Cloudflare (lane 2) — own account, invite al@alfred.report" },
  };
}

export async function chatTurn(env: Env, user: KissUser, message: string) {
  const spent = await getSpendToday(env, user.tenant_id);
  if (spent >= NEURON_CAP) {
    return {
      error: "Daily neuron cap",
      status: 429,
      upgrade: "Connect your Cloudflare — Workers Paid $5 when you outgrow this KISS pool.",
    };
  }
  let reply =
    "Noted. Mission recorded in your report. Spend ticks on the map. Connect Cloudflare when you want your own account.";
  let tokens = CHAT_NEURONS_MIN;
  try {
    const out = await completeText(
      env,
      "You are Alfred.report KISS operator. One short reply. No secrets. Evidence before done.",
      message.slice(0, 2000),
      { maxTokens: 120, sessionId: `kiss-${user.tenant_id}` }
    );
    reply = out.text.slice(0, 2000) || reply;
    tokens = Math.max(CHAT_NEURONS_MIN, out.totalTokens || CHAT_NEURONS_MIN);
  } catch {
    /* metered stub — spend still increments */
  }
  const neurons = await addSpend(env, user.tenant_id, tokens, tokens);
  await remember(env, user.tenant_id, `user: ${message.slice(0, 400)}`);
  await remember(env, user.tenant_id, `alfred: ${reply.slice(0, 400)}`);
  return { reply, spend: { neurons_today: neurons, daily_cap: NEURON_CAP } };
}

export async function storeByokFingerprint(env: Env, tenant_id: string, key: string) {
  const enc = new TextEncoder().encode(key.trim());
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const fp = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  await env.DB.prepare("UPDATE kiss_users SET byok_fp = ? WHERE tenant_id = ?")
    .bind(fp, tenant_id)
    .run();
  return { stored: true, fingerprint: fp, route: "gateway alfred — key never returned" };
}

export async function wizardGet(env: Env, tenant_id: string) {
  await ensureKissSchema(env.DB);
  const row = await env.DB.prepare(
    "SELECT step, invited_al, domain, notes FROM kiss_wizard WHERE tenant_id = ?"
  )
    .bind(tenant_id)
    .first<{ step: number; invited_al: number; domain: string | null; notes: string | null }>();
  return (
    row || {
      step: 1,
      invited_al: 0,
      domain: "ffm.report",
      notes: null,
    }
  );
}

export async function wizardPatch(
  env: Env,
  tenant_id: string,
  body: { step?: number; invited_al?: boolean; domain?: string; notes?: string }
) {
  const cur = await wizardGet(env, tenant_id);
  const step = body.step ?? cur.step;
  const invited = body.invited_al ? 1 : (cur.invited_al || 0);
  const domain = body.domain ?? cur.domain ?? "ffm.report";
  const notes = body.notes ?? cur.notes;
  await env.DB.prepare(
    `INSERT INTO kiss_wizard (tenant_id, step, invited_al, domain, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET step=excluded.step, invited_al=excluded.invited_al, domain=excluded.domain, notes=excluded.notes, updated_at=excluded.updated_at`
  )
    .bind(tenant_id, step, invited, domain, notes, Date.now())
    .run();
  return wizardGet(env, tenant_id);
}

/** Tokens are minted only on the customer account, and only once billing is active. Unpaid → 402. */
export function mintBlocked(user: KissUser): Response | null {
  if (!user.billing_paid) {
    return Response.json(
      {
        error: "Payment required",
        code: 402,
        copy: "alfred-mem billing must be active before Token Master mint on your Cloudflare account.",
      },
      { status: 402 }
    );
  }
  return null;
}

export function jsonAuthRequired(): Response {
  return Response.json({ error: "Sign in at /login" }, { status: 401 });
}
