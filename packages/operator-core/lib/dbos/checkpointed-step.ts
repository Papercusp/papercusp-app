/**
 * runCheckpointedStep — a DBOS.runStep that degrades to a plain call outside a
 * workflow (WI-1416, bg-host-freeze-eventloop-stall P-006).
 *
 * Multi-step system actions (git-sync) run at the WORKFLOW layer and checkpoint
 * their internal phases through this helper, so each phase records an
 * `operation_outputs` row: the executor reaper sees genuine progress
 * (function_id > 0) instead of an opaque no-output fire, and a crash/resume
 * replays completed phases from their checkpoints instead of re-running them.
 *
 * The same handlers are ALSO called outside any workflow (`fireGitSyncNow` via
 * the git-sync:run verb / release:deploy, and unit tests) — there the helper
 * just runs `fn` directly. NEVER call this from inside another DBOS step:
 * `DBOS.runStep` silently degrades to a plain call there (isInStep() → direct
 * execution, NO checkpoint), which is exactly the trap that kept git-sync's
 * progress invisible when it ran inside the engine's single `system:<action>`
 * step.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';

export async function runCheckpointedStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let checkpointable = false;
  try {
    // isWithinWorkflow is ALS-based (safe pre-launch); isInStep guards the
    // silent-degrade case so a mis-nested call still executes (just uncheckpointed).
    checkpointable = DBOS.isWithinWorkflow() && !DBOS.isInStep();
  } catch {
    checkpointable = false;
  }
  return checkpointable ? DBOS.runStep(fn, { name }) : fn();
}
