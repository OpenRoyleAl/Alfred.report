import type { D1Database } from "@cloudflare/workers-types";
import { generateId, generateMissionId } from "./db";
import type { Mission, MissionState, MissionGateResult, SpendAttestation } from "../types";
import {
  defaultMissionBudget,
  applyUsageToBudget,
  assertBudgetAllows,
  BudgetExceededError,
  type MissionBudget,
  type TokenUsage,
} from "./llm";

interface MissionRow {
  id: string;
  objective: string;
  state: MissionState;
  budget: string | null;
  acceptance: string;
  evidence: string;
  report: string | null;
  created_at: number;
  updated_at: number;
}

function rowToMission(row: MissionRow): Mission {
  return {
    id: row.id,
    objective: row.objective,
    state: row.state,
    budget: row.budget ? JSON.parse(row.budget) : null,
    acceptance: JSON.parse(row.acceptance || "[]"),
    evidence: JSON.parse(row.evidence || "[]"),
    report: row.report,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createMission(
  db: D1Database,
  data: {
    objective: string;
    budget?: MissionBudget | Record<string, unknown> | null;
    acceptance?: string[];
    state?: MissionState;
    field_agent?: string;
    /** Deterministic id from the client requestId (see durableBoardId); a retry returns the same row. */
    id?: string;
  }
): Promise<Mission & { duplicate?: boolean }> {
  const id = data.id ?? generateMissionId();
  if (data.id) {
    const had = await getMission(db, data.id);
    if (had) return { ...had, duplicate: true };
  }
  const now = Date.now();
  const state: MissionState = data.state ?? "drafted";
  const acceptance = data.acceptance ?? [];
  const partial = { ...((data.budget as MissionBudget) ?? {}), ...(data.field_agent ? { field_agent: data.field_agent } : {}) };
  const budget = defaultMissionBudget(partial);

  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO missions (id, objective, state, budget, acceptance, evidence, report, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      data.objective,
      state,
      JSON.stringify(budget),
      JSON.stringify(acceptance),
      "[]",
      null,
      now,
      now
    )
    .run();
  if (data.id && ins.meta.changes === 0) {
    const had = await getMission(db, data.id);
    if (had) return { ...had, duplicate: true };
  }

  return {
    id,
    objective: data.objective,
    state,
    budget,
    acceptance,
    evidence: [],
    report: null,
    created_at: now,
    updated_at: now,
  };
}

export async function listMissions(
  db: D1Database,
  opts?: { state?: MissionState; limit?: number }
): Promise<Mission[]> {
  const limitRaw = opts?.limit ?? 100;
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Number(limitRaw) : 100, 1), 500);
  let rows: MissionRow[] = [];
  if (opts?.state) {
    const res = await db
      .prepare(`SELECT * FROM missions WHERE state = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(opts.state, limit)
      .all<MissionRow>();
    rows = res.results ?? [];
  } else {
    const res = await db
      .prepare(`SELECT * FROM missions ORDER BY updated_at DESC LIMIT ?`)
      .bind(limit)
      .all<MissionRow>();
    rows = res.results ?? [];
  }
  return rows.map(rowToMission);
}

export async function getMission(db: D1Database, id: string): Promise<Mission | null> {
  const row = await db.prepare(`SELECT * FROM missions WHERE id = ?`).bind(id).first<MissionRow>();
  return row ? rowToMission(row) : null;
}

export async function updateMissionBudget(
  db: D1Database,
  id: string,
  budget: MissionBudget
): Promise<Mission | null> {
  const existing = await getMission(db, id);
  if (!existing) return null;
  const now = Date.now();
  await db
    .prepare(`UPDATE missions SET budget = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(budget), now, id)
    .run();
  return { ...existing, budget, updated_at: now };
}

/** Fail-closed: refuse LLM if over budget. */
export function refuseIfOverBudget(mission: Mission): void {
  assertBudgetAllows((mission.budget as MissionBudget) ?? null);
}

export async function recordMissionUsage(
  db: D1Database,
  id: string,
  usage: TokenUsage,
  spendUsd = 0,
  model?: string
): Promise<Mission | null> {
  const existing = await getMission(db, id);
  if (!existing) return null;
  const prev = (existing.budget as MissionBudget) ?? defaultMissionBudget();
  const next = applyUsageToBudget(prev, usage, spendUsd) ?? prev;
  if (model) next.model = model;
  // Real usage clears legacy/zero attestation class → metered
  if ((usage.total_tokens ?? 0) > 0 || (usage.neurons_est ?? 0) > 0 || spendUsd > 0) {
    next.spend_class = "metered";
    if (!next.spend_note) next.spend_note = "usage recorded via recordMissionUsage";
  }
  return updateMissionBudget(db, id, next);
}


/** Go Max Al! — reassign to Cursor reserve with temporary high budget burst. */
export async function goMaxMission(
  db: D1Database,
  id: string,
  opts?: { reason?: string; actor?: string }
): Promise<Mission | null> {
  const existing = await getMission(db, id);
  if (!existing) return null;
  const prev = (existing.budget as MissionBudget) ?? defaultMissionBudget();
  const now = Date.now();
  const budget: MissionBudget = {
    ...prev,
    field_agent: "cursor",
    max_tokens: Math.max(Number(prev.max_tokens || 0), 500_000),
    max_neurons: Math.max(Number(prev.max_neurons || 0), 50_000),
    max_usd: Math.max(Number(prev.max_usd || 0) || 0, 25),
    prefer_free_workers_ai: false,
    cost_class: "gateway",
    speed: "fast",
    spend_note: `go_max_al burst @ ${now}` + (opts?.reason ? `: ${opts.reason}` : ""),
    go_max: true,
    go_max_at: now,
    go_max_until: now + 6 * 60 * 60 * 1000,
  } as MissionBudget;
  const evidence = [
    ...existing.evidence,
    {
      at: now,
      passed: true,
      check: "go_max_al",
      notes: opts?.reason || "Go Max Al! → Cursor reserve, temp full power",
      actor: opts?.actor || "owner",
    },
  ];
  let nextState = existing.state;
  if (nextState === "drafted" || nextState === "gated") nextState = "active";
  await db
    .prepare(
      `UPDATE missions SET state = ?, budget = ?, evidence = ?, updated_at = ? WHERE id = ?`
    )
    .bind(nextState, JSON.stringify(budget), JSON.stringify(evidence), now, id)
    .run();
  return getMission(db, id);
}

export { BudgetExceededError, defaultMissionBudget };

/** True when any of used_tokens / used_neurons / spend_usd is positive. */
export function budgetHasUsage(budget: MissionBudget | Record<string, unknown> | null | undefined): boolean {
  if (!budget || typeof budget !== "object") return false;
  const b = budget as MissionBudget;
  return (b.used_tokens ?? 0) > 0 || (b.used_neurons ?? 0) > 0 || (b.spend_usd ?? 0) > 0;
}

export function budgetHasLegacyAttestation(
  budget: MissionBudget | Record<string, unknown> | null | undefined
): boolean {
  if (!budget || typeof budget !== "object") return false;
  const b = budget as MissionBudget;
  return b.spend_class === "legacy_unmetered" || b.spend_class === "zero_compute";
}

const INDEPENDENT_ACTORS = new Set(["gate", "w2-gate", "qa", "owner"]);
const COMPLETE_CHECKS = new Set(["complete", "gate_pass"]);
const ATTEST_MIN_REASON = 12;

export class MeteringGateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 402) {
    super(message);
    this.name = "MeteringGateError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Independent GATE (practical) for complete:true:
 * - actor REQUIRED (refuse if missing)
 * - check must be "complete" or "gate_pass"
 * - actor in gate|w2-gate|qa|owner OR independent_gate:true with actor !== primary_worker
 * Documented here so callers do not weaken this without the owner.
 */
export function assertIndependentCompleteGate(gate: MissionGateResult): void {
  const actor = (gate.actor || "").trim();
  if (!actor) {
    throw new MeteringGateError(
      "complete requires actor (independent GATE); missing actor refused",
      "independent_gate_actor_required",
      409
    );
  }
  const check = (gate.check || "").trim();
  if (!COMPLETE_CHECKS.has(check)) {
    throw new MeteringGateError(
      `complete requires check=complete|gate_pass (got ${check || "empty"})`,
      "independent_gate_check",
      409
    );
  }
  if (INDEPENDENT_ACTORS.has(actor)) return;
  if (gate.independent_gate === true) {
    const primary = (gate.primary_worker || "").trim();
    if (primary && actor === primary) {
      throw new MeteringGateError(
        "independent_gate: actor must not equal primary_worker",
        "independent_gate_same_actor",
        409
      );
    }
    return;
  }
  throw new MeteringGateError(
    `complete actor must be gate|w2-gate|qa|owner or set independent_gate:true (got ${actor})`,
    "independent_gate_actor",
    409
  );
}

export function validateSpendAttestation(att: SpendAttestation | undefined | null): SpendAttestation {
  if (!att || typeof att !== "object") {
    throw new MeteringGateError(
      "unmetered complete requires spend_attestation { class, reason }",
      "spend_attestation_required",
      402
    );
  }
  if (att.class !== "zero_compute" && att.class !== "legacy_unmetered") {
    throw new MeteringGateError(
      'spend_attestation.class must be "zero_compute" or "legacy_unmetered"',
      "spend_attestation_class",
      402
    );
  }
  const reason = (att.reason || "").trim();
  if (reason.length < ATTEST_MIN_REASON) {
    throw new MeteringGateError(
      `spend_attestation.reason required (min ${ATTEST_MIN_REASON} chars)`,
      "spend_attestation_reason",
      402
    );
  }
  return { class: att.class, reason };
}

/**
 * Refuse complete:true unless meters > 0 OR explicit spend_attestation.
 * Call before mutating state. Returns attestation to stamp on budget when used.
 */
export function assertCompleteMeteringAllowed(
  mission: Mission,
  gate: MissionGateResult
): SpendAttestation | null {
  assertIndependentCompleteGate(gate);
  if (budgetHasUsage(mission.budget)) return null;
  // Already legacy-attested budget still needs explicit attestation on this complete call
  // so the gate evidence records the reason — but accept budget spend_class as soft pass
  // only when spend_attestation is also provided (strict) OR budget already attested.
  if (gate.spend_attestation) {
    return validateSpendAttestation(gate.spend_attestation);
  }
  if (budgetHasLegacyAttestation(mission.budget)) {
    const b = mission.budget as MissionBudget;
    return {
      class: (b.spend_class as "zero_compute" | "legacy_unmetered") || "legacy_unmetered",
      reason: (b.spend_note || "budget already carries legacy/zero attestation").slice(0, 500),
    };
  }
  throw new MeteringGateError(
    "refuse unmetered complete: budget.used_tokens/used_neurons/spend_usd all zero; provide spend_attestation",
    "unmetered_complete",
    402
  );
}

export async function applyLegacyAttestation(
  db: D1Database,
  id: string,
  note = "pre-metering; historical inference not attributed"
): Promise<Mission | null> {
  const existing = await getMission(db, id);
  if (!existing) return null;
  const prev = (existing.budget as MissionBudget) ?? defaultMissionBudget();
  if (budgetHasUsage(prev)) {
    return { ...existing, budget: { ...prev, spend_class: prev.spend_class || "metered" } };
  }
  const next: MissionBudget = {
    ...prev,
    spend_class: "legacy_unmetered",
    spend_note: note,
    legacy_backfill_at: Date.now(),
  };
  return updateMissionBudget(db, id, next);
}

export async function gateMission(
  db: D1Database,
  id: string,
  gate: MissionGateResult
): Promise<Mission | null> {
  const existing = await getMission(db, id);
  if (!existing) return null;

  let budgetStamp: MissionBudget | null = null;
  if (gate.passed && gate.complete && existing.state === "active") {
    const att = assertCompleteMeteringAllowed(existing, gate);
    if (att) {
      const prev = (existing.budget as MissionBudget) ?? defaultMissionBudget();
      budgetStamp = {
        ...prev,
        spend_class: att.class,
        spend_note: att.reason,
        legacy_backfill_at: prev.legacy_backfill_at ?? Date.now(),
      };
    }
  }

  const evidence = [
    ...existing.evidence,
    {
      at: Date.now(),
      passed: gate.passed,
      check: gate.check,
      notes: gate.notes ?? null,
      actor: gate.actor ?? "gate",
    },
  ];

  let nextState: MissionState = existing.state;
  if (gate.passed) {
    if (existing.state === "drafted" || existing.state === "gated") {
      // Default promote=true for backward compat; A2A drop passes promote:false
      if (gate.promote !== false) {
        nextState = "active";
      }
    } else if (existing.state === "active" && gate.complete) {
      nextState = "complete";
    }
  } else {
    nextState = "gated";
  }

  if (gate.abort) nextState = "aborted";
  if (gate.fail) nextState = "failed";

  const report = gate.report ?? existing.report;
  const now = Date.now();
  const nextBudget = budgetStamp ?? (existing.budget as MissionBudget | null);

  if (budgetStamp) {
    await db
      .prepare(
        `UPDATE missions SET state = ?, evidence = ?, report = ?, budget = ?, updated_at = ? WHERE id = ?`
      )
      .bind(nextState, JSON.stringify(evidence), report, JSON.stringify(budgetStamp), now, id)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE missions SET state = ?, evidence = ?, report = ?, updated_at = ? WHERE id = ?`
      )
      .bind(nextState, JSON.stringify(evidence), report, now, id)
      .run();
  }

  return {
    ...existing,
    state: nextState,
    evidence,
    report,
    budget: nextBudget,
    updated_at: now,
  };
}

/** Owner archive: keep the row (audit), mark it aborted with a note so it leaves the active board. */
export async function archiveMission(db: D1Database, id: string, note: string): Promise<Mission | null> {
  const r = await db
    .prepare(`UPDATE missions SET state = 'aborted', report = ?, updated_at = ? WHERE id = ?`)
    .bind(note.slice(0, 500), Date.now(), id)
    .run();
  if (!r.meta.changes) return null;
  return getMission(db, id);
}
