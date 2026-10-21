/**
 * Pi extension "clef": Clef decision gates (route, escalate, mission-done).
 *
 * - escalate + done are tools the model calls inside a mission (clef_escalate_check before risky
 *   actions, clef_done_check before mission_complete);
 * - the same gates are exported as `clefGates` for the code paths that run outside the model:
 *   the front-door route (Alfred.ask), the ops escalate check, and the authoritative end-of-mission
 *   done gate whose result goes into the review and from there into The Report.
 * Failure policy: route falls back to "mission" (guarded + reviewed), escalate fails closed,
 * done returns null ("unavailable", a non-blocking review flag).
 */
import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  decideDone,
  decideEscalate,
  decideRoute,
  doneQuestions,
  doneState,
  escalateQuestions,
  routeQuestions,
  runClef,
  type ClefAudio,
  type ClefEnv,
  type DoneDecision,
  type EscalateDecision,
  type RouteDecision,
} from "../clef.ts";

export interface ClefGates {
  route(prompt: string, audio?: ClefAudio[]): Promise<RouteDecision>;
  escalate(action: string, context?: string): Promise<EscalateDecision>;
  done(objective: string, finalText: string, evidence: string | null): Promise<DoneDecision | null>;
}

export function clefGates(env: ClefEnv): ClefGates {
  return {
    async route(prompt, audio) {
      try {
        const out = await runClef(env, { state: prompt.slice(0, 12000), questions: routeQuestions(), ...(audio?.length ? { audio } : {}) });
        return decideRoute(out.answers);
      } catch {
        return { route: "mission", confidence: 0, needsWeb: false, fallback: true };
      }
    },
    async escalate(action, context) {
      try {
        const out = await runClef(env, { state: { action: action.slice(0, 2000), context: (context ?? "").slice(0, 6000) }, questions: escalateQuestions() });
        return decideEscalate(out.answers);
      } catch {
        return { escalate: true, p: 1, risk: 3, reason: "clef unavailable (fail closed)" };
      }
    },
    async done(objective, finalText, evidence) {
      try {
        const out = await runClef(env, { state: doneState(objective, finalText, evidence), questions: doneQuestions() });
        return decideDone(out.answers);
      } catch (err) {
        console.error(`clef done gate failed: ${(err as Error).message}`);
        return null;
      }
    },
  };
}

const EscalateParams = Type.Object({
  action: Type.String({ minLength: 3, maxLength: 2000, description: "The exact next action you intend to take." }),
  context: Type.Optional(Type.String({ maxLength: 6000, description: "Relevant facts (who is affected, cost, reversibility)." })),
});
const DoneParams = Type.Object({
  objective: Type.String({ minLength: 3, maxLength: 4000 }),
  result: Type.String({ minLength: 1, maxLength: 12000, description: "What you did and the outcome." }),
  evidence: Type.Optional(Type.String({ maxLength: 4000, description: "Proof: ids, URLs, outputs." })),
});

const text = (v: unknown) => [{ type: "text" as const, text: JSON.stringify(v) }];

export interface ClefSink {
  onEscalate(action: string, reason: string): void;
}

export function clefExtension(env: ClefEnv, sink: ClefSink, gates: ClefGates = clefGates(env)): Extension {
  const escalate: ToolRegistration<typeof EscalateParams> = {
    name: "clef_escalate_check",
    description:
      "REQUIRED before anything irreversible, paid, client-facing, security- or account-changing. " +
      "Returns {escalate, risk, reason}. If escalate is true, STOP and report that a human must approve; do not do the action.",
    parameters: EscalateParams,
    replay: "safe",
    async execute({ action, context }) {
      const d = await gates.escalate(action, context);
      if (d.escalate) sink.onEscalate(action, d.reason);
      return { output: text(d), ...(d.reason.startsWith("clef unavailable") ? { isError: true } : {}) };
    },
  };
  const done: ToolRegistration<typeof DoneParams> = {
    name: "clef_done_check",
    description:
      "Check your own work before mission_complete: returns {done, pDone, pEvidence}. If done is false, keep working " +
      "or report what is missing. The same gate runs again after the mission and goes into The Report.",
    parameters: DoneParams,
    replay: "safe",
    async execute({ objective, result, evidence }) {
      const d = await gates.done(objective, result, evidence ?? null);
      return d ? { output: text(d) } : { output: text({ done: null, reason: "clef unavailable" }), isError: true };
    },
  };
  return {
    name: "clef",
    tools: [escalate, done] as unknown as ToolRegistration[],
    sections: [
      {
        key: "clef",
        render: () =>
          "Clef gates: call clef_escalate_check before any irreversible, paid, client-facing or account action and stop if it escalates. " +
          "Call clef_done_check before mission_complete.",
      },
    ],
  };
}
