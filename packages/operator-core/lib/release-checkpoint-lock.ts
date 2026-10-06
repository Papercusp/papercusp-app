/**
 * Dependency-free home for the green-checkpoint run-lock age.
 *
 * Keep this module a LEAF (no imports). Coordination code such as
 * coord/condition-object.ts needs only this number. Importing it from
 * release-checkpoint-launch.ts instead pulls that module's whole static graph,
 * which reaches release-checkpoint-config.ts and its module-scope override
 * SELECT. Through condition-object.ts that put database I/O into the loading of
 * every pot tool module (WI-10005170; guarded by mug-kettle-tool-gate.test.ts,
 * "P-010 import hygiene").
 *
 * Keep this in sync with green-checkpoint.ts's CHECKPOINT_LOCK_STALE_MS. The writer
 * reclaims a lock at this age even when its recorded PID still appears alive; the reader
 * must not continue presenting that same over-age lock as a measured in-flight run when no
 * contender has arrived to trigger the writer-side cleanup.
 */
export const CHECKPOINT_RUN_LOCK_STALE_MS = 190 * 60_000;
