/**
 * ORAL speech parsing (pure, unit-tested): WAKE detection and the owner's voice commands.
 *
 * The wake word is the instance brand, derived from DOMAIN: "acme.report!" is heard as
 * "acme report", "acme dot report" or "Acme, report!". Saying it alone (plus filler such as
 * "hey" or "please") is WAKE and returns The Report. Saying it before a request just addresses
 * the request. Flow terms: ORAL -> WAKE -> Go Max AI! -> The Report.
 */
import { wakeWord } from "../../../src/brand.ts";

export type Command =
  | { kind: "wake" }
  | { kind: "propose"; objective: string } // "start a mission: ..." (needs Go Max AI! to run)
  | { kind: "go"; objective: string | null } // "Go Max AI!" alone confirms; with text it starts at once
  | { kind: "cancel" }
  | { kind: "chat"; text: string };

const FILLER = new Set(["hey", "hi", "ok", "okay", "please", "now", "the", "give", "me", "status", "what's", "whats", "up", "so", "um", "uh"]);

/** Lowercase words, punctuation dropped, "a.i." -> "ai". */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, "$1")
    .replace(/[^\p{L}\p{N}\s'.]/gu, " ")
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Wake tokens for a domain: label words ("acme"), optional "dot", then the TLD words ("report"). */
export function wakeTokens(domain: string): { label: string[]; tld: string[] } {
  const w = wakeWord(domain).replace(/!$/, "").toLowerCase();
  const [label, ...rest] = w.split(".");
  return { label: words(label ?? ""), tld: words(rest.join(" ")) };
}

/** Length (in words) of the wake phrase at the start of `ws`, or 0. Label words may be run together. */
export function wakePrefix(ws: string[], domain: string): number {
  const { label, tld } = wakeTokens(domain);
  if (!label.length) return 0;
  const joined = label.join("");
  // label may be heard split ("hans a koch") or joined ("hansakoch")
  let i = 0;
  let acc = "";
  while (i < ws.length && acc.length < joined.length) acc += ws[i++];
  if (acc !== joined) return 0;
  if (ws[i] === "dot") i++;
  for (const t of tld) {
    if (ws[i] !== t) return 0;
    i++;
  }
  return i;
}

export function parseUtterance(transcript: string, domain: string): Command {
  let ws = words(transcript);
  while (ws.length && FILLER.has(ws[0]) && ws[0] !== "give") ws = ws.slice(1);
  const n = wakePrefix(ws, domain);
  if (n) {
    const rest = ws.slice(n);
    if (rest.every((w) => FILLER.has(w))) return { kind: "wake" };
    ws = rest;
  }
  const text = ws.join(" ");

  const go = text.match(/^go max(?: ai| a i)?\b\s*(.*)$/);
  if (go) {
    const objective = go[1].trim();
    return { kind: "go", objective: objective.length >= 3 ? objective : null };
  }
  const start = text.match(/^(?:start|begin|create|open|new)(?: a| an| the| new)* mission(?: to| for| about)?\s+(.{3,})$/);
  if (start) return { kind: "propose", objective: start[1].trim() };
  if (/^(?:cancel|never ?mind|forget it|scrap that)\b/.test(text)) return { kind: "cancel" };
  return { kind: "chat", text: transcript.trim() };
}

/** Flux keyterms: boost the wake word and flow terms (keyterms bias STT; they never gate). */
export function wakeKeyterms(domain: string | undefined): string[] {
  const d = (domain || "").trim().toLowerCase();
  const { label, tld } = wakeTokens(d);
  return [...new Set([label.join(" "), [...label, ...tld].join(" "), d, "Go Max AI", "The Report", "mission"].filter(Boolean))];
}
