/**
 * The Report - what WAKE returns: a short, voice-first status of recent missions.
 *
 * Built only from stored mission rows and their end-of-mission reviews (verdict, flags and the
 * Clef mission-done gate). Deterministic: no model writes it, so it cannot invent anything.
 * Shape: success or fail per recent mission, a one-line synopsis, then what needs attention.
 */
import type { ReviewFlag, ReviewResult } from "./review.ts";

export interface MissionRow {
  id: string;
  objective: string;
  status: string; // running | done | unanswered | error...
  verdict: string | null; // pass | fail | null while running
  started_at: number;
  finished_at: number | null;
  review: ReviewResult | null;
}

export type Outcome = "success" | "fail" | "running";

export interface ReportItem {
  id: string;
  title: string;
  outcome: Outcome;
  /** Why it failed or what it waits on (first blocking review flag, in plain words). */
  reason?: string;
  /** Clef mission-done gate: true = confirmed done, false = not done, null = unavailable/not run. */
  clefDone: boolean | null;
}

export interface TheReport {
  brand: string;
  generatedAt: number;
  items: ReportItem[];
  counts: { success: number; fail: number; running: number };
  synopsis: string;
  attention: string[];
}

export const REPORT_LIMIT = 5;
export const STUCK_AFTER_MS = 30 * 60 * 1000;

/** Short spoken title: first sentence of the objective, at most `words` words. */
export function shortTitle(objective: string, words = 8): string {
  const first = objective.replace(/^Forwarded email:\s*/i, "").split(/(?<=[.!?])\s|\n/)[0] ?? "";
  const w = first.trim().split(/\s+/).filter(Boolean);
  const t = w.slice(0, words).join(" ").replace(/[.,;:!?]+$/, "");
  return w.length > words ? `${t}...` : t || "untitled mission";
}

const FLAG_WORDS: Record<ReviewFlag["kind"], string> = {
  escalated: "needs your approval",
  clef_not_done: "not finished",
  no_evidence: "no proof it was done",
  unanswered: "did not finish",
  failed_tool: "tools kept failing",
  loop: "got stuck in a loop",
  wasted_tokens: "wasted effort",
  failed_request: "model calls failed",
  logs_missing: "logs missing",
  clef_unavailable: "done check unavailable",
};

export function outcomeOf(m: MissionRow): Outcome {
  if (m.status === "running" || (!m.finished_at && !m.verdict)) return "running";
  return m.status === "done" && m.verdict === "pass" ? "success" : "fail";
}

function clefDoneOf(r: ReviewResult | null): boolean | null {
  const d = r?.done;
  return d && d !== "unavailable" ? d.done : null;
}

function reasonOf(m: MissionRow): string | undefined {
  const flags = m.review?.flags ?? [];
  const f = flags.find((x) => x.blocking) ?? (outcomeOf(m) === "fail" ? flags[0] : undefined);
  if (f) return FLAG_WORDS[f.kind] ?? f.kind;
  if (outcomeOf(m) === "fail") return m.status === "done" ? "failed review" : "did not finish";
  return undefined;
}

export function buildReport(brand: string, rows: MissionRow[], now = Date.now(), limit = REPORT_LIMIT): TheReport {
  const recent = [...rows].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
  const items: ReportItem[] = recent.map((m) => ({
    id: m.id,
    title: shortTitle(m.objective),
    outcome: outcomeOf(m),
    reason: reasonOf(m),
    clefDone: clefDoneOf(m.review),
  }));
  const counts = { success: 0, fail: 0, running: 0 };
  for (const i of items) counts[i.outcome]++;

  const attention: string[] = [];
  for (const m of recent) {
    const i = items.find((x) => x.id === m.id)!;
    if (i.outcome === "fail") attention.push(`${i.title}: ${i.reason}`);
    else if (i.outcome === "running" && now - m.started_at > STUCK_AFTER_MS) {
      attention.push(`${i.title}: still running after ${Math.round((now - m.started_at) / 60000)} minutes`);
    }
  }

  let synopsis: string;
  if (!items.length) synopsis = "No missions yet.";
  else {
    const parts = [
      counts.success && `${counts.success} succeeded`,
      counts.fail && `${counts.fail} failed`,
      counts.running && `${counts.running} running`,
    ].filter(Boolean);
    synopsis = `${items.length} recent mission${items.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  }
  return { brand, generatedAt: now, items, counts, synopsis, attention };
}

/** The spoken form. Short on purpose: TTS reads all of it. */
export function speakReport(r: TheReport): string {
  const out = [`${r.brand} The Report.`, r.synopsis];
  for (const i of r.items) {
    if (i.outcome === "success") out.push(`Success: ${i.title}${i.clefDone ? ", verified done" : ""}.`);
    else if (i.outcome === "fail") out.push(`Fail: ${i.title}.`);
    else out.push(`Running: ${i.title}.`);
  }
  out.push(r.attention.length ? `Needs attention: ${r.attention.slice(0, 3).join("; ")}.` : "Nothing needs your attention.");
  return out.join(" ");
}
