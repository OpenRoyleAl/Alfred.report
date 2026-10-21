/** ORAL turn policy (pure, unit-tested): what one utterance does, given who is speaking. */
import type { Command } from "./wake.ts";

export const SANDBOX_MISSION = "Missions are for the instance owner. Your sandbox can ask me questions.";
export const NOTHING_PENDING = "Nothing is waiting. Say start a mission, then what it is.";
export const CANCELLED = "Cancelled. Nothing was started.";

export type TurnAction =
  | { do: "report" } // WAKE -> The Report
  | { do: "say"; text: string }
  | { do: "draft"; objective: string } // owner: draft, then wait for Go Max AI!
  | { do: "start"; objective: string } // owner: Go Max AI! -> mission
  | { do: "cancel" }
  | { do: "chat"; metered: boolean }; // free conversation; sandbox turns use the daily quota

export function decideTurn(cmd: Command, isOwner: boolean, pending: string | undefined): TurnAction {
  switch (cmd.kind) {
    case "wake":
      return { do: "report" };
    case "propose":
      return isOwner ? { do: "draft", objective: cmd.objective } : { do: "say", text: SANDBOX_MISSION };
    case "go":
      if (!isOwner) return { do: "say", text: SANDBOX_MISSION };
      if (cmd.objective) return { do: "start", objective: cmd.objective };
      return pending ? { do: "start", objective: pending } : { do: "say", text: NOTHING_PENDING };
    case "cancel":
      if (pending) return { do: "cancel" };
      return { do: "chat", metered: !isOwner };
    case "chat":
      return { do: "chat", metered: !isOwner };
  }
}
