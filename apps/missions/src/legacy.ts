// AlfredCommand = the pre-rename class name. Exported only so MISSIONS_DO_PHASE=receive can take
// the old namespace from alfred-report-command (a class not declared in exports is ignored).
// Delete after the cutover in MIGRATION.md is done.
import { AlfredMissions } from "./orchestrator";

export class AlfredCommand extends AlfredMissions {}
