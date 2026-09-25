/**
 * KISS lane — email session, D1 missions/spend/memory. No tokens in responses.
 * Users never see Iceberg Token Master. Gateway id stays `alfred`.
 */

import type { Env } from "./env";
import { secretGet } from "./secret";
import { AIGateway } from "./ai-gateway";

export const KISS_COOKIE = "alfred_kiss";
export const NEURON_CAP = 10_000;
export const CHAT_NEURONS_MIN = 17;

export type KissUser = {
  email: string;
  name: string;
  tenant_id: string;
  billing_paid: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function cookieSecret(env: Env): Promise<string> {
  const ops = await secretGet(env.ALFRED_OPS_TOKEN as any);
  if (ops) return ops;
  const aig = await secretGet(env.CF_AIG_TOKEN as any);
  return aig || "kiss-dev-unconfigured";
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

async function hashPassword(password: string, salt: string): Promise<string> {
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
      iterations: 10_000,
    },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RESERVED_NAMES = new Set([
  "alfred",
  "al",
  "oral",
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
  "iceberg",
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
  ]);
}

export function setSessionCookie(token: string): string {
  return `${KISS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

export function clearSessionCookie(): string {
  return `${KISS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function mintSession(env: Env, user: KissUser): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${user.email}|${user.tenant_id}|${exp}`;
  const sig = await hmacHex(await cookieSecret(env), payload);
  return btoa(`${payload}|${sig}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function readSession(req: Request, env: Env): Promise<KissUser | null> {
  const raw = req.headers.get("Cookie") || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${KISS_COOKIE}=([^;]+)`));
  const bearer = req.headers.get("Authorization") || "";
  const token = m?.[1] || (bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "");
  if (!token) return null;
  try {
    const pad = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
    const [email, tenant_id, expStr, sig] = atob(padded).split("|");
    if (!email || !tenant_id || !expStr || !sig) return null;
    if (Number(expStr) < Date.now()) return null;
    const expect = await hmacHex(await cookieSecret(env), `${email}|${tenant_id}|${expStr}`);
    if (expect !== sig) return null;
    await ensureKissSchema(env.DB);
    const row = await env.DB.prepare(
      "SELECT email, name, tenant_id, billing_paid FROM kiss_users WHERE email = ?"
    )
      .bind(email.toLowerCase())
      .first<{ email: string; name: string; tenant_id: string; billing_paid: number }>();
    if (!row) return null;
    return {
      email: row.email,
      name: row.name,
      tenant_id: row.tenant_id,
      billing_paid: row.billing_paid,
    };
  } catch {
    return null;
  }
}

export async function signup(
  env: Env,
  email: string,
  password: string,
  name?: string,
  handle?: string
): Promise<{ user: KissUser } | { error: string; status: number }> {
  const e = email.trim().toLowerCase();
  if (!e.includes("@") || password.length < 8) {
    return { error: "Email and password (8+ chars) required", status: 400 };
  }
  await ensureKissSchema(env.DB);
  const existing = await env.DB.prepare("SELECT email FROM kiss_users WHERE email = ?")
    .bind(e)
    .first();
  if (existing) return { error: "Account exists — sign in", status: 409 };
  let tenant_id = handle?.trim() ? normalizeHandle(handle) : tenantFromEmail(e);
  const avail = await nameAvailable(env, tenant_id);
  if (!avail.ok) return { error: avail.error || "That name is taken.", status: 409 };
  tenant_id = avail.name;
  const salt = crypto.randomUUID();
  const pass_hash = await hashPassword(password, salt);
  const display = (name || tenant_id || e.split("@")[0] || "Operator").slice(0, 80);
  await env.DB.prepare(
    `INSERT INTO kiss_users (email, name, tenant_id, pass_salt, pass_hash, lane, billing_paid, created_at)
     VALUES (?, ?, ?, ?, ?, 'kiss', 0, ?)`
  )
    .bind(e, display, tenant_id, salt, pass_hash, Date.now())
    .run();
  return { user: { email: e, name: display, tenant_id, billing_paid: 0 } };
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
  const h = await hashPassword(password, row.pass_salt);
  if (h !== row.pass_hash) return { error: "Bad password", status: 401 };
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
    const gw = new AIGateway(env);
    const meta = await gw.chatWithMeta(
      [
        {
          role: "system",
          content: "You are Alfred.report KISS operator. One short reply. No secrets. Evidence before done.",
        },
        { role: "user", content: message.slice(0, 2000) },
      ],
      { tenantId: user.tenant_id, maxTokens: 120 }
    );
    reply = meta.content.slice(0, 2000);
    tokens = Math.max(CHAT_NEURONS_MIN, meta.usage.totalTokens || CHAT_NEURONS_MIN);
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

/** Iceberg never mints for customers. Unpaid → 402. */
export function mintBlocked(user: KissUser): Response | null {
  if (!user.billing_paid) {
    return Response.json(
      {
        error: "Payment required",
        code: 402,
        copy: "alfred-mem billing must be active before Token Master mint on your Cloudflare account. Iceberg Token Master never mints for customers.",
      },
      { status: 402 }
    );
  }
  return null;
}

export function jsonAuthRequired(): Response {
  return Response.json({ error: "Sign in at /login" }, { status: 401 });
}
