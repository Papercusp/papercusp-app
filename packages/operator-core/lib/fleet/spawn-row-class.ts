/**
 * THE single source of truth for `harness_shared.spawned_agents` CLASS MEMBERSHIP:
 * is a row an IN-PROCESS loopback launch, or a supervised invoke-once child?
 *
 * WHY THIS FILE EXISTS (EI-21344971525195182). Several reapers that KILL gate on
 * that answer, and until 2026-09-05 the predicate was hand-copied into four places
 * — `spawn-reclaim.ts`, `harness/improvements/watchdog.ts`, `pot/placement-watchdog.ts`
 * and the handoff UPDATE's SQL — kept in step only by a comment claiming one
 * "mirrors" the other. They diverged: `spawnRowKind` grew an `invoke-*`
 * short-circuit that moved 71% of the `durable-spawn:*` population (56 of 79 rows,
 * measured 2026-08-24 over a 14-day window) across the boundary, while the copies
 * stayed ids-only. Nothing failed and nothing alerted, because the reaper that
 * would have SIGTERMed healthy durable spawns is dark-OFF (EI-7685).
 *
 * This module is a LEAF — it imports nothing, so any classifier anywhere can
 * depend on it without a module cycle. Per the repo's derive/pin/attest ladder,
 * class membership is code-describing metadata: DERIVE it from one place rather
 * than hand-maintaining copies. `spawn-row-class.test.ts` pins that there is
 * still only one place, including the SQL copy this module cannot import.
 *
 * The two predicates here are DELIBERATELY different and both are load-bearing;
 * see `isInProcessLaunchIdentity` for why a reaper needs the identity predicate
 * and not `spawnRowKind(...) === 'launch'`.
 */

/** A row whose `run_id` starts with this is an in-process launch, by identity. */
export const IN_PROCESS_LAUNCH_RUN_ID_PREFIX = 'launch-';
/** A row whose `spawn_id` starts with this is an in-process launch, by identity. */
export const IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX = 'durable-spawn:';
/**
 * The /invoke route stamps this onto `run_id` when it records a real child pid
 * (`markSpawnHandoff`, spawn-reclaim.ts). It is the ONLY thing that moves a row
 * from `'launch'` to `'spawn'` in {@link spawnRowKind} — and the prefix is owned
 * by that route, not by this classifier, which is exactly the shape that let the
 * boundary move silently.
 */
export const SUPERVISED_HANDOFF_RUN_ID_PREFIX = 'invoke-';

export type SpawnRowKind = 'spawn' | 'launch';

/**
 * Does this row carry an IN-PROCESS-LAUNCH IDENTITY, by its ids alone?
 *
 * This is deliberately NOT `spawnRowKind(row) === 'launch'`, and the difference is
 * load-bearing for any reaper that KILLS. {@link spawnRowKind} short-circuits to
 * `'spawn'` the moment `run_id` starts with `invoke-` — the documented "the /invoke
 * route recorded a real child pid, so treat it as a supervised child from here"
 * handoff — and that check runs BEFORE the identity test. So a `durable-spawn:*`
 * row whose run_id is `invoke-*` classifies as a supervised bee.
 *
 * MEASURED, 2026-08-24 (WI-6113), `harness_shared.spawned_agents`, 14-day window:
 * of 79 `durable-spawn:*` rows, 56 (71%) carry an `invoke-*` run_id. The `invoke-`
 * prefix first appears on 2026-08-21; before that the whole class read as
 * `'launch'`. A run_id naming change silently moved most of this population across
 * the class boundary that two killing reapers rely on, and nothing failed.
 *
 * WHY THE HANDOFF'S PREMISE DOES NOT HOLD HERE: the handoff means "a real child is
 * being stdout-supervised". If that were true of these rows some of them would have
 * streamed. NONE have — `last_output_at` is NULL on 79/79 of the class, and on
 * 0-of-5,457 in-process-launch rows table-wide, against 184 supervised rows that do
 * populate it. Whether the defect is in the handoff (no supervisor attached) or in
 * the classification, the consequence for a reaper is identical: the row is treated
 * as a supervised child that has "never emitted output", which is exactly the
 * signature these reapers kill on.
 *
 * Use this ALONGSIDE a `spawnRowKind`-based filter — never instead of it — so the
 * filter is the INTERSECTION of both, and can only ever remove rows from a kill list.
 */
export function isInProcessLaunchIdentity(row: { spawn_id: string; run_id?: string | null }): boolean {
  return (
    (row.run_id ?? '').startsWith(IN_PROCESS_LAUNCH_RUN_ID_PREFIX) ||
    row.spawn_id.startsWith(IN_PROCESS_LAUNCH_SPAWN_ID_PREFIX)
  );
}

/**
 * Classify a nursery row by the process whose liveness its pid represents.
 *
 * Legacy `launch-*` and durable-spawn rows begin life before the /invoke route
 * has started its child. The route's handoff marks the run id `invoke-*` while
 * recording the actual child pid; only then does the same row use the strict
 * child-process probe. Treating every durable/launch row as an in-process launch
 * made a cross-process firing boot id look like a stale launcher and killed fresh
 * release-fixer work before its first turn (EI-20981156698708733).
 */
export function spawnRowKind(row: { spawnId: string; runId: string | null; pid?: number | null }): SpawnRowKind {
  if ((row.runId ?? '').startsWith(SUPERVISED_HANDOFF_RUN_ID_PREFIX)) return 'spawn';
  return isInProcessLaunchIdentity({ spawn_id: row.spawnId, run_id: row.runId }) ? 'launch' : 'spawn';
}
