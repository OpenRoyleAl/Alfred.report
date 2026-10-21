/**
 * Forwarded email -> mission ingest (deduped by message id). Only the owner's forwards
 * reach this (web Worker email handler / ops bearer). An owner wake is sent only when the
 * request sets owner_wake=true.
 * Eggs DARK. No passwords in wakes/logs.
 */
import type { D1Database } from "@cloudflare/workers-types";
import * as missions from "./missions";
import { ownerWake, type A2AEnv } from "./a2a";
import { defaultMissionBudget, type MissionBudget } from "./llm";
import type { Mission } from "../types";

export interface EmailIngestEnv extends A2AEnv {
  DB: D1Database;
  ALFRED_OPS_TOKEN?: string;
  HOLD_NEW_MISSIONS?: string;
  /** Set by index when X-Alfred-Override: metering-bootstrap present. */
  METERING_BOOTSTRAP_OVERRIDE?: boolean;
}

export interface EmailIngestRequest {
  gmail_message_id: string;
  thread_id?: string | null;
  subject?: string | null;
  owner_note?: string | null;
  objective: string;
  acceptance?: string[];
  budget?: MissionBudget | Record<string, unknown> | null;
  state?: "drafted" | "active" | "gated" | "complete" | "failed" | "aborted";
  /** Only true for Alfred.report! / mobile — otherwise the owner is notified on the Gmail thread. */
  owner_wake?: boolean;
}

export interface EmailIngestRow {
  gmail_message_id: string;
  thread_id: string | null;
  mission_id: string;
  subject: string | null;
  ingested_at: number;
}

/** Strip password-like lines/phrases from text used in objectives/wakes/logs. */
export function scrubSecrets(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (/^(pw|password|passwd|passphrase|secret|token|api[_ -]?key)\b/i.test(t)) return "[redacted]";
      if (/\b(pw|password)\s*[:=]\s*\S+/i.test(t)) {
        return t.replace(/\b(pw|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
      }
      return line;
    })
    .join("\n")
    .replace(/\b(pw|password)\s*[:=]?\s*\S+/gi, (m) => {
      if (/^pw$/i.test(m.trim())) return m;
      return m.replace(/(\S+)$/, "[redacted]");
    })
    .trim();
}

export async function getIngestByGmailId(
  db: D1Database,
  gmailMessageId: string
): Promise<EmailIngestRow | null> {
  return (
    (await db
      .prepare(
        `SELECT gmail_message_id, thread_id, mission_id, subject, ingested_at
         FROM email_ingest WHERE gmail_message_id = ?`
      )
      .bind(gmailMessageId)
      .first<EmailIngestRow>()) ?? null
  );
}


export async function getIngestByThreadId(
  db: D1Database,
  threadId: string
): Promise<EmailIngestRow | null> {
  if (!threadId) return null;
  return (
    (await db
      .prepare(
        `SELECT gmail_message_id, thread_id, mission_id, subject, ingested_at
         FROM email_ingest WHERE thread_id = ? ORDER BY ingested_at ASC LIMIT 1`
      )
      .bind(threadId)
      .first<EmailIngestRow>()) ?? null
  );
}

export async function recordIngest(
  db: D1Database,
  row: {
    gmail_message_id: string;
    thread_id?: string | null;
    mission_id: string;
    subject?: string | null;
  }
): Promise<EmailIngestRow> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO email_ingest (gmail_message_id, thread_id, mission_id, subject, ingested_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(gmail_message_id) DO NOTHING`
    )
    .bind(
      row.gmail_message_id,
      row.thread_id ?? null,
      row.mission_id,
      row.subject ?? null,
      now
    )
    .run();
  const existing = await getIngestByGmailId(db, row.gmail_message_id);
  if (!existing) {
    throw new Error("email_ingest record failed");
  }
  return existing;
}

function buildReceivedWake(missionId: string, blockers?: string[]): string {
  const base = `Received. Mission ${missionId} — archive.`;
  if (blockers && blockers.length) {
    return `${base} Blockers: ${blockers.join("; ").slice(0, 200)}`;
  }
  return base;
}

/**
 * Idempotent: if gmail_message_id already ingested, return existing mission (no second wake).
 */
export async function ingestEmailMission(
  env: EmailIngestEnv,
  raw: EmailIngestRequest
): Promise<{
  ok: true;
  deduped: boolean;
  mission: Mission;
  wake: { ok: boolean; skipped?: boolean; status?: number; detail?: string };
  received_line: string;
}> {
  const gmailId = (raw.gmail_message_id || "").trim();
  if (!gmailId) throw new Error("gmail_message_id required");

  const existing = await getIngestByGmailId(env.DB, gmailId);
  if (existing) {
    const mission = await missions.getMission(env.DB, existing.mission_id);
    if (!mission) throw new Error(`dedupe row missing mission ${existing.mission_id}`);
    const received_line = buildReceivedWake(mission.id);
    return {
      ok: true,
      deduped: true,
      mission,
      wake: { ok: true, skipped: true, detail: "already_ingested" },
      received_line,
    };
  }

  const threadId = (raw.thread_id || "").trim();
  if (threadId) {
    const byThread = await getIngestByThreadId(env.DB, threadId);
    if (byThread) {
      const mission = await missions.getMission(env.DB, byThread.mission_id);
      if (!mission) throw new Error(`thread dedupe missing mission ${byThread.mission_id}`);
      // Stamp this message id too so future scans skip it
      await recordIngest(env.DB, {
        gmail_message_id: gmailId,
        thread_id: threadId,
        mission_id: mission.id,
        subject: scrubSecrets((raw.subject || "").trim()) || null,
      });
      const received_line = buildReceivedWake(mission.id);
      return {
        ok: true,
        deduped: true,
        mission,
        wake: { ok: true, skipped: true, detail: "thread_already_ingested" },
        received_line,
      };
    }
  }

  const subject = scrubSecrets((raw.subject || "").trim());
  const ownerNote = scrubSecrets((raw.owner_note || "").trim());
  let objective = scrubSecrets((raw.objective || "").trim());
  if (!objective) throw new Error("objective required");

  // Ensure gmail id is stamped for audit without secrets
  if (!objective.includes(`gmail:${gmailId}`)) {
    objective = `${objective} | gmail:${gmailId}${raw.thread_id ? ` thread:${raw.thread_id}` : ""}`;
  }
  if (subject && !objective.toLowerCase().includes(subject.slice(0, 40).toLowerCase())) {
    // subject already expected in objective from caller; leave as-is
  }

  const hold = (env.HOLD_NEW_MISSIONS || "").trim();
  const held = hold === "1" || hold.toLowerCase() === "true" || hold.toLowerCase() === "on";
  if (held && !env.METERING_BOOTSTRAP_OVERRIDE) {
    throw new Error(
      "metering_hold: HOLD_NEW_MISSIONS — close Missions metering loop first (or X-Alfred-Override: metering-bootstrap)"
    );
  }

  const mission = await missions.createMission(env.DB, {
    objective,
    budget: (raw.budget as MissionBudget) ?? defaultMissionBudget(),
    acceptance: (raw.acceptance ?? []).map(scrubSecrets),
    state: raw.state ?? "active",
  });

  await recordIngest(env.DB, {
    gmail_message_id: gmailId,
    thread_id: raw.thread_id ?? null,
    mission_id: mission.id,
    subject: subject || null,
  });

  const received_line = buildReceivedWake(mission.id);
  // Received is acknowledged to the caller; wake the owner only when asked -
  // unless Alfred.report! / mobile explicitly sets owner_wake.
  let wake: { ok: boolean; skipped?: boolean; status?: number; detail?: string } = {
    ok: true,
    skipped: true,
    detail: "thread_notify_expected",
  };
  if (raw.owner_wake === true) {
    wake = await ownerWake(env, {
      reason: "email_mission_received_oral",
      mission_id: mission.id,
      state: mission.state,
      objective: objective.slice(0, 240),
      preview: received_line,
      report: received_line,
    });
  }

  return { ok: true, deduped: false, mission, wake, received_line };
}
