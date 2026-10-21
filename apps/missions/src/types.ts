// ─── Record Types ─────────────────────────────────────────────

export const RECORD_TYPES = [
  "matter",
  "task",
  "note",
  "person",
  "org",
  "place",
  "asset",
  "chore",
  "instinct",
  "decision",
  "briefing",
  "daybook",
  "commitment",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

// ─── Records ───────────────────────────────────────────────────

export interface RecordRow {
  id: string;
  type: RecordType;
  title: string;
  content: string | null;
  content_r2_key: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  metadata: string | null; // JSON
}

export interface Record extends Omit<RecordRow, "metadata"> {
  metadata: globalThis.Record<string, unknown>;
}

// ─── Edges ─────────────────────────────────────────────────────

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  created_at: number;
}

// ─── Observations ──────────────────────────────────────────────

export interface Observation {
  id: string;
  record_id: string | null;
  signal: string;
  source: string;
  confidence: number;
  created_at: number;
}

// ─── Workers ───────────────────────────────────────────────────

export const WORKER_NAMES = [
  "curator",
  "janitor",
  "distiller",
  "farmer",
  "builder",
  "orchestrator",
] as const;

export type WorkerName = (typeof WORKER_NAMES)[number];

// ─── Inbox ──────────────────────────────────────────────────────

export interface InboxItem {
  id: string;
  source: string;
  raw_content: string;
  metadata: globalThis.Record<string, unknown>;
  received_at: number;
  processed: boolean;
}

// ─── Worker Results ────────────────────────────────────────────

export interface WorkerResult {
  worker: WorkerName;
  success: boolean;
  summary: string;
  recordsCreated?: number;
  recordsUpdated?: number;
  recordsDeleted?: number;
  errors?: string[];
  record_id?: string;
  duration_ms: number;
}

// ─── Briefing ──────────────────────────────────────────────────

export interface BriefingData {
  date: string;
  matters_active: number;
  tasks_pending: number;
  tasks_completed: number;
  observations_24h: number;
  insights: string[];
  priorities: string[];
  generated_at: number;
}

// ─── Maintenance Report ────────────────────────────────────────

export interface MaintenanceReport {
  broken_links: number;
  orphan_records: number;
  stale_records: number;
  archived: number;
  edges_cleaned: number;
  observations_logged: number;
  duration_ms: number;
}


// ─── Mission Budget (token / neuron / cost class) ──────────────

export type CostClass = "free" | "byok" | "paid_workers" | "gateway";
export type SpeedNeed = "fast" | "normal" | "deep";

export type SpendClass = "metered" | "zero_compute" | "legacy_unmetered";

export interface MissionBudget {
  max_tokens?: number;
  used_tokens?: number;
  max_neurons?: number;
  used_neurons?: number;
  prefer_free_workers_ai?: boolean;
  cost_class?: CostClass;
  speed?: SpeedNeed;
  model?: string;
  spend_usd?: number;
  max_usd?: number;
  /** Honest spend attribution when meters are zero or legacy. */
  spend_class?: SpendClass;
  spend_note?: string;
  /** Field agent id, see FIELD_AGENTS in src/brand.ts */
  field_agent?: string;
  go_max?: boolean;
  go_max_at?: number;
  go_max_until?: number;
  legacy_backfill_at?: number;
}

// ─── Missions (Missions Kernel) ─────────────────────────────────

export const MISSION_STATES = [
  "drafted",
  "active",
  "gated",
  "complete",
  "failed",
  "aborted",
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

export interface MissionEvidence {
  at: number;
  passed: boolean;
  check: string;
  notes: string | null;
  actor: string;
}

export interface Mission {
  id: string;
  objective: string;
  state: MissionState;
  budget: MissionBudget | globalThis.Record<string, unknown> | null;
  acceptance: string[];
  evidence: MissionEvidence[];
  report: string | null;
  created_at: number;
  updated_at: number;
}

export interface SpendAttestation {
  class: "zero_compute" | "legacy_unmetered";
  reason: string;
}

export interface MissionGateResult {
  passed: boolean;
  check: string;
  notes?: string;
  actor?: string;
  complete?: boolean;
  abort?: boolean;
  fail?: boolean;
  report?: string | null;
  /** When false, do not auto-promote drafted/gated → active (A2A drop FIFO). Default true. */
  promote?: boolean;
  /**
   * Independent GATE (complete:true): actor must be gate|w2-gate|qa|owner,
   * OR independent_gate:true with actor present and not the primary worker.
   * Missing actor → refuse. check must be complete|gate_pass.
   */
  independent_gate?: boolean;
  /** Explicit zero/legacy spend attestation required when budget meters are all zero. */
  spend_attestation?: SpendAttestation;
  /** Optional primary worker id for independence check (refuse if actor equals this when independent_gate). */
  primary_worker?: string;
}
