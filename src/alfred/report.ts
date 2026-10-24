/**
 * The Report - what WAKE returns: a short, voice-first status of recent missions.
 *
 * Built only from stored mission rows and their end-of-mission reviews (verdict, flags and the
 * Clef mission-done gate). Deterministic: no model writes it, so it cannot invent anything.
 * Shape: success or fail per recent mission, a one-line synopsis, then what needs attention.
 *
 * Implementation is Rust (crates/alfred-core report_*). This file is the typed TS facade used
 * by the Alfred DO (`/api/alfred/report`) and ORAL TTS.
 */
import { reportBuild, reportSpeak, reportTitle } from "./core.ts";
import type { ReviewResult } from "./review.ts";

export interface MissionRow {
  id: string;
  objective: string;
  status: string; // running | done | unanswered | error...
  verdict: string | null; // pass | fail | null while running
  started_at: number;
  finished_at: number | null;
  review: ReviewResult | null;
}

export type Outcome = "success" | "fail" | "running" | "partial";

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
  counts: { success: number; fail: number; running: number; partial: number };
  synopsis: string;
  attention: string[];
}

export const REPORT_LIMIT = 5;
export const STUCK_AFTER_MS = 30 * 60 * 1000;

/** Short spoken title: first sentence of the objective, at most `words` words. */
export function shortTitle(objective: string, words = 8): string {
  return reportTitle(objective, words);
}

export function outcomeOf(m: MissionRow): Outcome {
  return (reportBuild({ brand: "", rows: [m], now: 0, limit: 1 }) as TheReport).items[0]?.outcome ?? "fail";
}

export function buildReport(brand: string, rows: MissionRow[], now = Date.now(), limit = REPORT_LIMIT): TheReport {
  return reportBuild({ brand, rows, now, limit }) as TheReport;
}

/** The spoken form. Short on purpose: TTS reads all of it. */
export function speakReport(r: TheReport): string {
  return reportSpeak(r);
}
