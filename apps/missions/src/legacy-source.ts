// Entry for MISSIONS_DO_PHASE=transfer-out: the last deploy of the old alfred-report-command
// Worker. It keeps AlfredCommand in code (required while the transfer commits) and answers
// everything else with 410 pointing at alfred-report-missions.
export { AlfredCommand } from "./legacy";

export default {
  fetch(): Response {
    return Response.json({ error: "moved", worker: "alfred-report-missions" }, { status: 410 });
  },
};
