import { secretGet } from "./secret";
import type { Env } from "./env";
import { KNOWN_MISSION_IDS } from "./known-missions";

const ORAL = "https://agent-alfred.iceberg.workers.dev";
const UA = "AlfredReport/1.0";
const DAY_MS = 24 * 60 * 60 * 1000;
const METERING_NOTE =
  "Metering law: used_tokens/neurons/usd when known; spend_class=legacy_unmetered for pre-metering history.";

async function oralHeaders(env: Env): Promise<HeadersInit> {
  const token = await secretGet(env.ALFRED_OPS_TOKEN as any);
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": UA,
    Accept: "application/json",
  };
}

async function fetchKnownMissions(env: Env): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const id of KNOWN_MISSION_IDS) {
    try {
      const r = await fetch(`${ORAL}/missions/${encodeURIComponent(id)}`, {
        headers: await oralHeaders(env),
      });
      if (r.ok) out.push(await r.json());
    } catch {
      /* skip */
    }
  }
  return out;
}

type MissionBudget = {
  used_tokens?: number;
  used_neurons?: number;
  spend_usd?: number;
  max_tokens?: number;
  max_neurons?: number;
  [key: string]: unknown;
};

type MissionRow = {
  id?: string;
  objective?: string;
  state?: string;
  updated_at?: number;
  created_at?: number;
  budget?: MissionBudget;
  [key: string]: unknown;
};

function num(n: unknown): number {
  const x = Number(n ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function inWindow(ts: number, lo: number, hi: number): boolean {
  return ts >= lo && ts < hi;
}

function burnRollup(missions: MissionRow[]) {
  let tokens = 0;
  let neurons = 0;
  let usd = 0;
  for (const m of missions) {
    const b = m.budget || {};
    tokens += num(b.used_tokens);
    neurons += num(b.used_neurons);
    usd += num(b.spend_usd);
  }
  return {
    tokens,
    neurons,
    usd,
    missions_touched: missions.length,
  };
}

function humanTitle(m: MissionRow): string {
  const b = (m.budget || {}) as Record<string, unknown>;
  const titled = (b.human_title || (m as any).title) as string | undefined;
  if (titled && !/^msn_/i.test(titled) && !/^[0-9a-f-]{36}$/i.test(titled)) return String(titled).slice(0, 72);
  const o = String(m.objective || "");
  const sub = o.match(/Subject:\s*([^|]+)/i);
  if (sub) return sub[1].trim().replace(/^Fwd:\s*/i, "").slice(0, 72);
  for (const part of o.split("|").map((x) => x.trim())) {
    if (!part || /^(mb-|msn_|gmail:|thread:|https?:)/i.test(part)) continue;
    return part.slice(0, 72);
  }
  return (o || "Untitled mission").slice(0, 72);
}

function slimMission(m: MissionRow) {
  return {
    id: m.id || "",
    title: humanTitle(m),
    objective: m.objective || "",
    updated_at: num(m.updated_at),
    budget: m.budget || {},
  };
}

function slimBurnMission(m: MissionRow) {
  const b = m.budget || {};
  return {
    id: m.id || "",
    objective: m.objective || "",
    updated_at: num(m.updated_at),
    budget: b,
    state: m.state || "",
    spend_class: (b as MissionBudget).spend_class || (num(b.used_tokens) + num(b.used_neurons) + num(b.spend_usd) > 0 ? "metered" : "unknown"),
  };
}

function healthSubset(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const llm = (h.llm && typeof h.llm === "object" ? h.llm : {}) as Record<
    string,
    unknown
  >;
  const metering =
    h.metering && typeof h.metering === "object"
      ? (h.metering as Record<string, unknown>)
      : null;
  return {
    ok: h.ok,
    service: h.service,
    brand: h.brand,
    free_neurons_per_day: llm.free_neurons_per_day ?? null,
    paid_neurons_usd_per_1k: llm.paid_neurons_usd_per_1k ?? null,
    doctrine: typeof llm.doctrine === "string" ? llm.doctrine : null,
    mimo_pipes: llm.mimo_pipes ?? null,
    workers_ai_pool_enabled_default:
      llm.workers_ai_pool && typeof llm.workers_ai_pool === "object"
        ? (llm.workers_ai_pool as Record<string, unknown>).enabled_default
        : null,
    metering,
    hold_new_missions: metering ? Boolean(metering.hold_new_missions) : null,
  };
}


async function listMissionsFromD1(env: Env, limit = 50): Promise<MissionRow[]> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT id, objective, state, budget, acceptance, evidence, report, created_at, updated_at, tenant_id
       FROM missions ORDER BY updated_at DESC LIMIT ?`
    )
      .bind(Math.min(Math.max(limit, 1), 200))
      .all<MissionRow & { budget?: string | null; acceptance?: string; evidence?: string }>();
    const out: MissionRow[] = [];
    for (const r of rows.results || []) {
      let budget: MissionBudget = {};
      try {
        budget = r.budget && typeof r.budget === "string" ? JSON.parse(r.budget) : (r.budget as MissionBudget) || {};
      } catch {
        budget = {};
      }
      out.push({
        id: r.id,
        objective: r.objective,
        state: r.state,
        updated_at: num(r.updated_at),
        created_at: num(r.created_at),
        budget,
        tenant_id: (r as any).tenant_id,
      });
    }
    return out;
  } catch (e) {
    console.error("listMissionsFromD1", e);
    return [];
  }
}

export async function proxyListMissions(req: Request, env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const upstream = new URL(`${ORAL}/missions`);
  for (const key of ["state", "limit"]) {
    const v = url.searchParams.get(key);
    if (v) upstream.searchParams.set(key, v);
  }
  let missions: MissionRow[] = [];
  let oralOk = false;
  try {
    const r = await fetch(upstream.toString(), { headers: await oralHeaders(env) });
    const text = await r.text();
    if (r.ok) {
      try {
        const data = JSON.parse(text) as { missions?: unknown[] };
        if (Array.isArray(data.missions)) {
          missions = data.missions as MissionRow[];
          oralOk = true;
        }
      } catch {
        /* fall through to D1 */
      }
    }
  } catch {
    /* ORAL workers.dev / network dead — D1 fallback */
  }
  if (!oralOk || missions.length === 0) {
    const limit = Number(url.searchParams.get("limit") || "50") || 50;
    const fromD1 = await listMissionsFromD1(env, limit);
    if (fromD1.length) missions = fromD1;
  }
  if (missions.length === 0) {
    missions = (await fetchKnownMissions(env)) as MissionRow[];
  }
  missions = missions.map((m) => ({ ...m, title: humanTitle(m) }));
  return Response.json({ missions, source: oralOk ? "oral" : "d1" }, {
    headers: { "Cache-Control": "private, max-age=15" },
  });
}

export async function proxyGetMission(id: string, env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }
  const r = await fetch(`${ORAL}/missions/${encodeURIComponent(id)}`, {
    headers: await oralHeaders(env),
  });
  const text = await r.text();
  try {
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" },
    });
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function proxyCreateMission(req: Request, env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const obj = body as { objective?: unknown };
  if (!obj || typeof obj.objective !== "string" || !obj.objective.trim()) {
    return Response.json({ error: "objective_required" }, { status: 400 });
  }
  const r = await fetch(`${ORAL}/missions`, {
    method: "POST",
    headers: {
      ...await oralHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Closed-24h + burn-24h rollups from ORAL missions (+ health subset). */
export async function proxyCommandStats(env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }

  const asOf = Date.now();
  const curLo = asOf - DAY_MS;
  const prevLo = asOf - 2 * DAY_MS;

  const missionsUrl = new URL(`${ORAL}/missions`);
  missionsUrl.searchParams.set("limit", "200");

  const [missionsRes, healthRes] = await Promise.all([
    fetch(missionsUrl.toString(), { headers: await oralHeaders(env) }),
    fetch(`${ORAL}/health`, { headers: await oralHeaders(env) }).catch(() => null),
  ]);

  const text = await missionsRes.text();
  let data: { missions?: MissionRow[] } = {};
  try {
    data = JSON.parse(text);
  } catch {
    return Response.json(
      { error: "upstream_invalid", detail: text.slice(0, 200) },
      { status: 502 }
    );
  }
  if (!missionsRes.ok) {
    return Response.json(data, { status: missionsRes.status });
  }

  let missions: MissionRow[] = Array.isArray(data.missions) ? data.missions : [];
  if (missions.length === 0) {
    missions = (await fetchKnownMissions(env)) as MissionRow[];
  }

  const closed24 = missions.filter(
    (m) => m.state === "complete" && inWindow(num(m.updated_at), curLo, asOf)
  );
  const closedPrev = missions.filter(
    (m) => m.state === "complete" && inWindow(num(m.updated_at), prevLo, curLo)
  );
  const burn24 = missions.filter((m) => inWindow(num(m.updated_at), curLo, asOf));
  const burnPrev = missions.filter((m) => inWindow(num(m.updated_at), prevLo, curLo));

  const burn_24h = burnRollup(burn24);
  const burn_prev_24h = burnRollup(burnPrev);

  let health: Record<string, unknown> | null = null;
  if (healthRes && healthRes.ok) {
    try {
      health = healthSubset(await healthRes.json());
    } catch {
      health = null;
    }
  }

  const hold =
    health && typeof (health as any).hold_new_missions === "boolean"
      ? Boolean((health as any).hold_new_missions)
      : Boolean(
          health &&
            (health as any).metering &&
            typeof (health as any).metering === "object" &&
            Boolean(((health as any).metering as any).hold_new_missions)
        );

  const payload = {
    as_of: asOf,
    closed_24h: closed24.length,
    closed_prev_24h: closedPrev.length,
    closed_delta: closed24.length - closedPrev.length,
    burn_24h,
    burn_prev_24h,
    burn_delta_usd: burn_24h.usd - burn_prev_24h.usd,
    burn_delta_tokens: burn_24h.tokens - burn_prev_24h.tokens,
    metering_note: METERING_NOTE,
    hold_new_missions: hold,
    health,
    closed_missions_24h: closed24
      .slice()
      .sort((a, b) => num(b.updated_at) - num(a.updated_at))
      .map(slimMission),
    closed_missions_prev_24h: closedPrev
      .slice()
      .sort((a, b) => num(b.updated_at) - num(a.updated_at))
      .map(slimMission),
    burn_missions_24h: burn24
      .slice()
      .sort((a, b) => num(b.updated_at) - num(a.updated_at))
      .map(slimBurnMission),
  };

  return Response.json(payload, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}

/** Map pretty paths to static HTML assets. KISS: no /app prefix. */
export function missionBoardAsset(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/new") return "/new.html";
  if (
    p === "/now" ||
    p === "/closed" ||
    p === "/burn" ||
    p.startsWith("/m/") ||
    p === "/m"
  ) {
    return "/app.html";
  }
  if (p === "/all" || p.startsWith("/all/m/") || p === "/all/m") return "/all.html";
  if (p === "/login") return "/login.html";
  // legacy /app → still serve board (Access + Worker redirect prefer /now)
  if (
    p === "/app" ||
    p === "/app/closed" ||
    p === "/app/burn" ||
    p.startsWith("/app/m/") ||
    p === "/app/m" ||
    p === "/app/new"
  ) {
    if (p === "/app/new") return "/new.html";
    return "/app.html";
  }
  return null;
}

export async function proxyGoMaxMission(id: string, req: Request, env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const r = await fetch(`${ORAL}/missions/${encodeURIComponent(id)}/go-max`, {
    method: "POST",
    headers: {
      ...await oralHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}


export async function proxyMissionAct(id: string, req: Request, env: Env): Promise<Response> {
  if (!(await secretGet(env.ALFRED_OPS_TOKEN as any))) {
    return Response.json({ error: "ALFRED_OPS_TOKEN not configured" }, { status: 503 });
  }
  let body: unknown = {};
  try { body = await req.json(); } catch { body = {}; }
  const r = await fetch(`${ORAL}/missions/${encodeURIComponent(id)}/act`, {
    method: "POST",
    headers: { ...await oralHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
