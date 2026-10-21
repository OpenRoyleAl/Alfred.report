# Command -> Missions cutover (Durable Object state)

The Worker was renamed `alfred-report-command` -> `alfred-report-missions` and its Durable Object
class `AlfredCommand` -> `AlfredMissions`. A rename (`renamed_classes` / `state: "renamed"`) only
works inside one Worker, so the namespace is first **transferred** to the new Worker, then
**renamed** there. D1, KV, R2 and Vectorize keep their existing names and ids (they cannot be
renamed in place), so mission data is untouched.

Fresh installs skip all of this: the default `MISSIONS_DO_PHASE=live` creates `AlfredMissions`.

| Step | Command (from `apps/missions`) | Effect |
| --- | --- | --- |
| 1 | `MISSIONS_DO_PHASE=receive cf deploy` | New Worker declares `AlfredCommand` as `expecting-transfer` from `LEGACY_COMMAND_WORKER_NAME`; no DO binding yet (DO-backed routes return errors until step 4). |
| 2 | `MISSIONS_DO_PHASE=transfer-out cf deploy` | Old Worker deploys a `transferred` tombstone; the namespace moves atomically. Output: `Transferred (committed): AlfredCommand -> alfred-report-missions`. |
| 3 | `MISSIONS_DO_PHASE=rename cf deploy` | `AlfredCommand` renamed to `AlfredMissions` inside the new Worker; binding `MISSIONS_AGENT` restored. |
| 4 | `cf deploy` (phase `live`) | Steady state. Then delete `src/legacy.ts`, `src/legacy-source.ts`, the `receive`/`transfer-out`/`rename` branches in `cloudflare.config.ts`, and the old Worker. |

Point the web Worker at the new name (`MISSIONS_WORKER_NAME`, binding `MISSIONS`) after step 3.
Reference: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
