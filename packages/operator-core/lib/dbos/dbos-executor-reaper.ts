/**
 * dbos-executor-reaper — the durable fix for the recurring DBOS routine-scheduler
 * dedup wedge (EI-455; see agent-insights/deploy-pipeline-silent-stall-dead-executor-dedup
 * and routines-dedup-dead-executor-wedge).
 *
 * THE WEDGE: when a DBOS executor (the operator OR a transient repro/restart host)
 * dies, it leaves its `PENDING`/`ENQUEUED` workflows stuck forever. Those rows pin
 * their `deduplication_id` — the unique index `uq_workflow_status_dedup_id` is
 * STATUS-INDEPENDENT and DBOS only frees a dedup by NULLing it on dequeue, which a
 * never-dequeued (dead-executor) workflow never does. So every future `routineFire`
 * for that routine collapses on the held dedup while `claimDueRoutine` keeps bumping
 * `last_fired_at` — the routine looks alive but never runs, and the scheduler
 * silently wedges. (It also bloats `dbos.workflow_status`, which slows queries →
 * event-loop thrashing → the executor stops draining its queue entirely.)
 *
 * THE FIX: reap dead executors' stuck non-terminal workflows — NULL the
 * `deduplication_id` (frees the index) and CANCEL them. Runs (a) once at operator
 * boot (clears wedges left by a prior crash/restart) and (b) on a process-level
 * `setInterval` — NOT a DBOS scheduled workflow, deliberately: a DBOS-scheduled
 * reaper would queue on the very executor that wedges and so couldn't fire when it's
 * most needed. The interval runs in the operator process, independent of the DBOS
 * routine engine, so it clears the wedge even when the routine scheduler is frozen.
 * Crash-safety is covered by the boot reap plus an atomic stale-fire
 * cancel-and-requeue transaction (a failure after selecting a routine fire cannot
 * leave its workflow cancelled while its routine still points at the next cadence).
 * The existing daily `dbos-workflow-gc` prunes terminal rows; the reaper is what
 * lets the GC (and every routine) keep firing.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/**
 * Release a green-checkpoint routineFire as soon as its own checkpoint marker is proven
 * abandoned. This supplements, rather than narrows, the 185m no-output fallback below.
 */
export async function clearAbandonedCheckpointRoutineFire(
  sql: Pick<Sql, 'unsafe'>,
  input: {
    installSlug: string;
    workspaceId: string;
    routineId: string;
    workflowId: string;
    observedAtMs: number;
  },
): Promise<boolean> {
  const { installSlug, workspaceId, routineId, workflowId, observedAtMs } = input;
  if (
    !installSlug || !workspaceId || !routineId || !workflowId ||
    !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0
  ) {
    return false;
  }
  const rows = await sql.unsafe(
    `UPDATE dbos.workflow_status
        SET deduplication_id = NULL, status = 'CANCELLED'
      WHERE workflow_uuid = $1
        AND name = 'routineFire'
        AND deduplication_id = $2
        AND status IN ('PENDING', 'ENQUEUED')
        AND created_at <= $3
        AND EXISTS (
          SELECT 1
            FROM harness_shared.routines r
           WHERE r.id = $4
             AND r.install_slug = $5
             AND r.workspace_id = $6
             AND r.target_role = 'system:green-checkpoint'
        )
      RETURNING workflow_uuid`,
    [workflowId, `routine:${routineId}`, observedAtMs, routineId, installSlug, workspaceId],
  );
  return rows.length === 1;
}

/** A DBOS executor with no `workflow_status` activity in this window is considered dead. */
const DEFAULT_LIVENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
/** A routinesTick should finish quickly; if it is still non-terminal after this,
 *  it is wedging the scheduler itself. Keep this below bghost-watchdog's 100s
 *  freeze threshold so the reaper can fix the row before the host restart loop. */
const DEFAULT_STALE_SCHEDULER_MS = 90 * 1000;
/** A routineFire may be inside its first DBOS step; operation_outputs is written
 *  when that step checkpoints, not when it starts. The longest legit no-output
 *  first step is the GREEN-CHECKPOINT suite: its action (release-actions.ts) does a
 *  single up-to-120-min `await runScript(...)` over the test suite with NO intermediate
 *  DBOS checkpoint, so it records nothing in operation_outputs until it completes.
 *
 *  ⚠ THIS IS A WALL-CLOCK CAP FROM CREATION, **NOT** A SINCE-LAST-OUTPUT SILENCE
 *  TIMER — the name misleads (verified 2026-07-26, WI-6112). The predicate below is
 *  literally `created_at < now - THIS` plus "has no operation_outputs row with
 *  function_id > 0", and `created_at` is used deliberately (see the comment above the
 *  query) so DBOS recovery churn cannot reset it. The "output" it waits for is a DBOS
 *  STEP CHECKPOINT, not stdout: green-checkpoint logs continuously to a file the whole
 *  time and still records NOTHING here until its single step returns. So a chatty,
 *  perfectly healthy run does NOT escape this window — the invariant is that the run's
 *  TOTAL runtime must fit inside it.
 *
 *  This window MUST therefore stay ABOVE the last moment a healthy-or-self-terminating
 *  checkpoint can still be running without having checkpointed, else the reaper cancels
 *  a HEALTHY long checkpoint and the green gate (→ every fleet deploy) wedges — the
 *  2026-06-29 incident this constant caused at 25m (green-checkpoint-reaper-window-vs-
 *  suite), re-armed silently when the suite timeout grew 55m→120m (EI-7553) and this
 *  stayed at 60m: a 60–90m run under full-fleet load was reaped mid-flight while its
 *  own timeout still had 30m to go (WI-6112).
 *
 *  INVARIANT (cross-file, same convention as the result MARKERs / lock-stale in
 *  release-actions.ts + green-checkpoint.ts) — the full chain must stay MONOTONIC:
 *    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (115m, release/green-checkpoint-schedule.ts)
 *      <  SELF_WATCHDOG_MS            (180m, green-checkpoint.ts)
 *      <  THIS                        (185m)
 *      <  CHECKPOINT_LOCK_STALE_MS    (190m, green-checkpoint.ts)
 *  Reading the chain: a live parent SIGTERMs the suite at its own timeout (recording a
 *  result → a terminal, non-reapable workflow); if the parent died, the run's SELF
 *  watchdog kills it; only PAST both can a still-non-terminal no-output fire be
 *  presumed wedged, so THIS sits above the watchdog — yet still below the run-lock's
 *  stale-reclaim, so the dedup pin is freed (→ routine requeued) before a peer attempt
 *  can force-reclaim the lock. Whoever retunes one must retune these; the ordering is
 *  asserted by apps/operator/lib/release/release-timing-invariants.test.ts, which is
 *  the guard that was missing when this silently inverted. */
export const DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS = 185 * 60 * 1000;
/** EI-18734881428789368 — the operator override for the window above, and why it is
 *  BOUNDED where its ORPHAN sibling twelve lines below is free.
 *
 *  The ask was "this has no env lever, its sibling does". The asymmetry was real but the
 *  sibling's pattern is the wrong one to copy: the orphan window is STANDALONE, so any
 *  positive value is safe, whereas THIS constant is one link in the monotonic chain
 *  documented above. Moving one link alone is not the fix for an inversion — it is how
 *  the chain inverted, twice. A permissive override would therefore have handed an
 *  operator mid-incident a lever whose natural use (shrink it so the reaper stops
 *  waiting) silently re-arms the exact "reaper cancels a healthy checkpoint" incident,
 *  and the compile-time guards could not catch it because they assert the CONSTANT.
 *
 *  So the override may only move within the band its neighbours leave. A value outside
 *  the band is REFUSED — falling back to the default and naming the other links that
 *  must move with it — which is the actionable answer at 3am, not a silent inversion.
 *
 *  FLOOR/CEILING mirror SELF_WATCHDOG_MS and CHECKPOINT_LOCK_STALE_MS, which live in
 *  apps/operator/lib/release/green-checkpoint.ts and CANNOT be imported here
 *  (operator-core must not import from apps/operator — the same layering that forced
 *  this chain across three files in the first place). They are pinned to the real
 *  constants by apps/operator/lib/release/release-timing-invariants.test.ts, so a
 *  neighbour that moves without these fails there rather than drifting silently. */
export const NO_OUTPUT_OVERRIDE_FLOOR_MS = 3 * 60 * 60_000; // mirrors SELF_WATCHDOG_MS (180m)
export const NO_OUTPUT_OVERRIDE_CEILING_MS = 190 * 60_000; // mirrors CHECKPOINT_LOCK_STALE_MS (190m)

/** The window the reaper ACTUALLY runs with. Note the naming split, which differs from
 *  the orphan sibling on purpose: `DEFAULT_…` stays a plain compile-time constant so the
 *  chain guards keep asserting a value that cannot vary with the environment, and THIS is
 *  the env-resolved one the sweep uses. Env: PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS. */
export const STALE_ROUTINE_FIRE_NO_OUTPUT_MS = ((): number => {
  const raw = process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS;
  const v = Number(raw);
  const fallback = `falling back to ${DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS}ms`;
  if (!Number.isFinite(v) || v <= 0) {
    console.warn(
      `[dbos-reaper] PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS=${raw} is not a positive number; ${fallback}.`,
    );
    return DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS;
  }
  if (v <= NO_OUTPUT_OVERRIDE_FLOOR_MS || v >= NO_OUTPUT_OVERRIDE_CEILING_MS) {
    console.warn(
      `[dbos-reaper] PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS=${v}ms would break the green-gate timing chain ` +
        `(must be strictly between SELF_WATCHDOG_MS=${NO_OUTPUT_OVERRIDE_FLOOR_MS}ms and ` +
        `CHECKPOINT_LOCK_STALE_MS=${NO_OUTPUT_OVERRIDE_CEILING_MS}ms); ${fallback}. ` +
        `Widening past the ceiling is a real ordering decision: raise CHECKPOINT_LOCK_STALE_MS in ` +
        `apps/operator/lib/release/green-checkpoint.ts together with this window, and keep ` +
        `apps/operator/lib/release/release-timing-invariants.test.ts green.`,
    );
    return DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS;
  }
  return v;
})();
/** WI-1416: the FAST-orphan window for a routineFire in the genuinely anomalous
 *  ENQUEUED-with-no-live-queue-row state (see the corrected queue-row semantics on
 *  the stale query below). This path used to fire at `staleSchedulerMs` (90s) for ANY
 *  no-queue-row fire — a false-positive machine once we verified queue rows vanish at
 *  DEQUEUE (every healthy executing fire has none), which reaped+requeued every
 *  git-sync fire whose first step ran >90s (the WI-1415 ~1-commit/40min loop).
 *  Env-tunable: PAPERCUSP_DBOS_REAPER_FIRE_ORPHAN_MS. */
const DEFAULT_STALE_ROUTINE_FIRE_ORPHAN_MS = (() => {
  const v = Number(process.env.PAPERCUSP_DBOS_REAPER_FIRE_ORPHAN_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();
/** How often the recurring sweep runs. */
const DEFAULT_REAP_INTERVAL_MS = 2 * 60 * 1000; // 2 min
/** Keep enough reaped/completed ticks to cover the git-sync stall alarm window. */
const GIT_SYNC_HISTORY_LIMIT = 30;

export interface ExecutorReaperResult {
  /** Stuck PENDING/ENQUEUED workflows cancelled (dedup freed). */
  cancelled: number;
  /** Compatibility count for the removed queue-row cleanup path; always zero. */
  queuePurged: number;
  /** Routine ids pushed back to due-now after a no-first-output routineFire was reaped. */
  requeuedRoutineIds: string[];
  /** The dead executor ids reaped this pass. */
  deadExecutorIds: string[];
  /** Stale live-row workflow ids reaped even when executor_id is reused. */
  staleWorkflowIds: string[];
}

/**
 * One reap pass: find executors with no recent activity that still hold non-terminal
 * workflows, free their dedups + cancel them, and purge their orphaned queue rows.
 * Never throws — it rides boot + an interval and must not break either.
 */
export async function reapDeadExecutorWorkflows(
  sql: Sql,
  livenessThresholdMs: number = DEFAULT_LIVENESS_THRESHOLD_MS,
  staleSchedulerMs: number = DEFAULT_STALE_SCHEDULER_MS,
  staleRoutineFireNoOutputMs: number = STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
  staleRoutineFireOrphanMs: number = DEFAULT_STALE_ROUTINE_FIRE_ORPHAN_MS,
  /**
   * EI-18752434722211671: this process's OWN start time (epoch ms), when known.
   * `executor_id` is the constant string 'local' for every DBOS-enabled process on
   * this device that does not set an explicit DBOS__VMID (bootstrap.ts requires every
   * OTHER concurrent DBOS host on a device — bg-host, staging, gym instances — to pin
   * its own distinct VMID/APPVERSION), so 'local' is exclusively the ONE primary
   * operator process at any given time. That makes the following safe: a non-terminal
   * `routineFire` row still tagged executor_id='local' whose `created_at` PREDATES
   * *this* process's own start cannot belong to this process — it can only be a wedge
   * left by the PRIOR 'local' process, which died (this process would not otherwise be
   * booting). It is therefore reapable immediately, without waiting out
   * `staleRoutineFireNoOutputMs` (185m) — that generic window exists to protect an
   * ACTIVE first step from a live executor, which is not this case (the row's original
   * executor is provably gone). The existing "no DBOS operation output recorded" guard
   * still applies unchanged — this only widens WHEN the check runs for this one
   * evidenced-dead-executor case, not WHAT counts as safe to reap. A restart that lands
   * mid-git-sync-tick therefore no longer has to wait ~3h for the routine's dedup pin
   * to free (the observed live incident) — it is freed at this process's own next boot
   * (or next 2-min reap tick) reap pass.
   */
  processStartedAtMs?: number,
): Promise<ExecutorReaperResult> {
  const empty: ExecutorReaperResult = {
    cancelled: 0,
    queuePurged: 0,
    requeuedRoutineIds: [],
    deadExecutorIds: [],
    staleWorkflowIds: [],
  };
  try {
    const now = Date.now();
    const deadAt = now - livenessThresholdMs;
    const staleSchedulerAt = now - staleSchedulerMs;
    const staleRoutineFireNoOutputAt = now - staleRoutineFireNoOutputMs;
    const staleRoutineFireOrphanAt = now - staleRoutineFireOrphanMs;
    let cancelled = 0;
    // Keep this result field for callers that still consume the historical shape.
    // The supported DBOS schema has no queue-row relation to purge.
    const queuePurged = 0;

    // EI-18752434722211671: when this process knows its own start time, a
    // 'local'-executor routineFire created before that instant is provably
    // orphaned (its executor is dead — see the param doc above) and reapable
    // immediately, independent of staleRoutineFireNoOutputMs. Passed as plain scalar
    // params (not a nested `sql` fragment) so the extra clause is a pure no-op
    // (`false AND …`) when processStartedAtMs is unset — every existing caller (the
    // periodic tick before this fix, and any other embedder) is behavior-identical.
    const hasProcessStartedAtMs = processStartedAtMs != null;
    // EI-19441859859931739: FLOOR at the bind site. `created_at` is a bigint
    // column, and this param's documented default is
    // `Date.now() - process.uptime() * 1000` — `process.uptime()` returns a
    // FLOAT (seconds), so the epoch carries a fractional part
    // ("1785734149790.5593"). Postgres rejects that literal outright with
    // `invalid input syntax for type bigint`, which aborts the ENTIRE reap
    // pass before any reaping happens — every pass, silently, at info level.
    // Flooring HERE rather than only at the default below makes the seam
    // integer-safe for every caller, including an embedder that computes and
    // passes its own float. Do not remove in favour of a caller-side floor.
    const processStartedAtMsParam = Math.floor(processStartedAtMs ?? 0);

    // Dead executors: stale (no workflow_status update in the window) AND still
    // holding at least one non-terminal workflow worth reaping.
    const dead = await sql<{ executor_id: string }[]>`
      SELECT executor_id
        FROM dbos.workflow_status
       GROUP BY executor_id
      HAVING max(updated_at) < ${deadAt}
         AND count(*) FILTER (WHERE status IN ('PENDING', 'ENQUEUED')) > 0`;
    const deadIds = dead.map((r) => r.executor_id);

    if (deadIds.length > 0) {
      // NULL the deduplication_id FIRST (the unique index keys on it regardless of
      // status) and CANCEL the stuck workflows.
      const cancelRes = await sql`
        UPDATE dbos.workflow_status
           SET deduplication_id = NULL, status = 'CANCELLED'
         WHERE executor_id = ANY(${deadIds})
           AND status IN ('PENDING', 'ENQUEUED')`;
      cancelled += cancelRes.count;

    }

    // Executor ids are intentionally stable in systemd (`DBOS__VMID=bg-host-3270`),
    // so a process restart can leave old PENDING rows under the SAME executor_id.
    // The dead-executor grouping above then sees fresh activity from the new process
    // and cannot reap the old rows. Reap only bounded-safe stale rows:
    //   - a non-terminal routinesTick older than the scheduler silence window, and
    //   - a routineFire whose creation time is older than the longer first-output
    //     window and that has not checkpointed any DBOS step output, OR an
    //     ENQUEUED routineFire older than the fast-orphan window with no live sibling
    //     workflow on the same queue, and
    //   - any non-terminal workflow past its explicit DBOS deadline.
    //
    // operation_outputs is a checkpoint/output table, not a live "step entered"
    // table. function_id=0 is only routine-fire-start; it proves claim context was
    // recorded, not that the target action is running. A legitimate long first
    // step (green-checkpoint's up-to-120m suite is the proven case) may have only that
    // start row until it completes or records its own timeout/error, so routineFire
    // uses the LONGER first-action-output window than the scheduler tick.
    //
    // The current DBOS deployment does not expose a queue-row relation, so queue
    // liveness is inferred entirely from workflow_status siblings. An ENQUEUED
    // fire is fast-reaped only when no sibling on the same queue_name is either
    // actively PENDING (recent updated_at OR still inside its explicit workflow
    // deadline) or recently drained to SUCCESS/ERROR within the orphan window.
    // The deadline leg matters for long single-step actions such as green-checkpoint:
    // their external log can make steady progress for up to two hours while
    // workflow_status.updated_at remains at step start. Treating only a recent
    // status write as liveness cancelled healthy ENQUEUED siblings after ten
    // minutes, including the operator-home release gate. CANCELLED is deliberately
    // NOT liveness — the reaper's own cancels bump updated_at and would self-mask
    // a genuinely wedged queue. A healthy backlog behind live workers is left alone
    // (the no-output window, explicit deadlines, and the dead-executor branch still
    // backstop true wedges).
    //
    // Use created_at, not started_at_epoch_ms or updated_at: DBOS recovery can
    // refresh BOTH timestamps on a row it still has not checkpointed, and that
    // heartbeat must not keep a wedged dedup pin alive indefinitely.
    const stale = await sql<{ workflow_uuid: string; requeue_routine_id: string | null }[]>`
      SELECT workflow_uuid,
             CASE
               WHEN name = 'routineFire'
                AND deduplication_id LIKE 'routine:%'
                AND (
                  created_at < ${staleRoutineFireNoOutputAt}
                  OR (
                    status = 'ENQUEUED'
                    AND created_at < ${staleRoutineFireOrphanAt}
                    AND NOT EXISTS (
                      SELECT 1
                        FROM dbos.workflow_status w2
                       WHERE w2.queue_name = dbos.workflow_status.queue_name
                         AND w2.workflow_uuid <> dbos.workflow_status.workflow_uuid
                         AND (
                           (
                             w2.status = 'PENDING'
                             AND (
                               w2.updated_at > ${staleRoutineFireOrphanAt}
                               OR (
                                 w2.workflow_deadline_epoch_ms IS NOT NULL
                                 AND w2.workflow_deadline_epoch_ms > ${now}
                               )
                             )
                           )
                           OR (
                             w2.status IN ('SUCCESS', 'ERROR')
                             AND w2.updated_at > ${staleRoutineFireOrphanAt}
                           )
                         )
                    )
                  )
                  OR (${hasProcessStartedAtMs} AND executor_id = 'local' AND created_at < ${processStartedAtMsParam})
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM dbos.operation_outputs op
                   WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                     AND op.function_id > 0
                )
               THEN substring(deduplication_id from 9)
               ELSE NULL
             END AS requeue_routine_id
        FROM dbos.workflow_status
       WHERE status IN ('PENDING', 'ENQUEUED')
         AND (
           (
             name = 'routinesTick'
             AND (
               updated_at < ${staleSchedulerAt}
               OR (
                 created_at < ${staleSchedulerAt}
                 AND NOT EXISTS (
                   SELECT 1
                     FROM dbos.operation_outputs op
                    WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                 )
               )
             )
           )
           OR (
             name = 'routineFire'
             AND (
               created_at < ${staleRoutineFireNoOutputAt}
               OR (
                 status = 'ENQUEUED'
                 AND created_at < ${staleRoutineFireOrphanAt}
                 AND NOT EXISTS (
                   SELECT 1
                     FROM dbos.workflow_status w2
                    WHERE w2.queue_name = dbos.workflow_status.queue_name
                      AND w2.workflow_uuid <> dbos.workflow_status.workflow_uuid
                     AND (
                       (
                         w2.status = 'PENDING'
                         AND (
                           w2.updated_at > ${staleRoutineFireOrphanAt}
                           OR (
                             w2.workflow_deadline_epoch_ms IS NOT NULL
                             AND w2.workflow_deadline_epoch_ms > ${now}
                           )
                         )
                       )
                       OR (
                         w2.status IN ('SUCCESS', 'ERROR')
                         AND w2.updated_at > ${staleRoutineFireOrphanAt}
                       )
                     )
                 )
               )
               OR (${hasProcessStartedAtMs} AND executor_id = 'local' AND created_at < ${processStartedAtMsParam})
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM dbos.operation_outputs op
                WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                  AND op.function_id > 0
             )
           )
           OR (workflow_deadline_epoch_ms IS NOT NULL AND workflow_deadline_epoch_ms < ${now})
         )`;
    const staleIds = stale.map((r) => r.workflow_uuid);
    const requeueRoutineIds = [...new Set(stale.map((r) => r.requeue_routine_id).filter((id): id is string => !!id))];
    if (staleIds.length > 0) {
      // The workflow cancellation and routine due-now write are ONE state transition.
      // Previously the cancellation committed first; if the metadata UPDATE then failed,
      // the dedup was freed but the routine stayed scheduled for its next normal cadence.
      // That exact split stranded the 17:15 Papercusp gate until 18:15, so keep both
      // writes in one transaction.
      const staleTransition = await sql.begin(async (tx) => {
        const staleCancel = await tx`
          UPDATE dbos.workflow_status
             SET deduplication_id = NULL, status = 'CANCELLED'
           WHERE workflow_uuid = ANY(${staleIds})
             AND status IN ('PENDING', 'ENQUEUED')`;
        if (requeueRoutineIds.length > 0) {
          // WI-1416: `reaped_count` counts CONSECUTIVE reaps — a completed fire resets
          // it (git-sync's recordOutcome, and the clear below drops it) — so persistent
          // reaping is a durable, queryable signal the git-sync-stall-watchdog alarms on
          // (paired with the fire_started_at breadcrumb the fire stamps at its top).
          const reapedAt = Date.now();
          await tx`
            UPDATE harness_shared.routines
               SET next_fire_at = LEAST(COALESCE(next_fire_at, now()), now()),
                   metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'last_error',
                          'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
                          'last_error_at',
                          now()::text,
                          'last_error_source',
                          'dbos-executor-reaper',
                          'reaped_count',
                          COALESCE((metadata->>'reaped_count')::int, 0) + 1
                        )
                     || CASE
                          WHEN target_role = 'system:git-sync' THEN jsonb_build_object(
                            'git_sync_history',
                            COALESCE((
                              SELECT jsonb_agg(item ORDER BY ord)
                                FROM (
                                  SELECT item, ord
                                    FROM jsonb_array_elements(
                                      (CASE
                                         WHEN jsonb_typeof(metadata->'git_sync_history') = 'array'
                                           THEN metadata->'git_sync_history'
                                         ELSE '[]'::jsonb
                                       END) || jsonb_build_array(jsonb_build_object(
                                         'ts', ${reapedAt}::bigint,
                                         'status', 'reaped',
                                         'dirty_path_count', NULL,
                                         'committed_count', NULL,
                                         'error', 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
                                         'reaped', true
                                       ))
                                    ) WITH ORDINALITY AS history(item, ord)
                                   ORDER BY ord DESC
                                   LIMIT ${GIT_SYNC_HISTORY_LIMIT}
                                ) AS retained
                            ), '[]'::jsonb)
                          )
                          ELSE '{}'::jsonb
                        END,
                   updated_at = now()
             WHERE id = ANY(${requeueRoutineIds})
               AND active = true`;
        }
        return { cancelled: staleCancel.count };
      });
      cancelled += staleTransition.cancelled;
    }

    if (cancelled === 0) return empty;
    return {
      cancelled,
      queuePurged,
      requeuedRoutineIds: requeueRoutineIds,
      deadExecutorIds: deadIds,
      staleWorkflowIds: staleIds,
    };
  } catch (e) {
    console.warn(`[dbos-executor-reaper] reap pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}

/**
 * The `last_error_source` this reaper stamps onto `harness_shared.routines.metadata`
 * when it cancels+REQUEUES a stuck fire (see the requeue UPDATE above, ~line 250).
 * The marker is a SELF-HEAL note ("I recovered this routine"), NOT a wedge — but the
 * improvement-watchdog's `routine-failure` collector (watchdog.ts) alarms on ANY
 * non-empty `last_error`, so the marker MUST be cleared once the routine actually
 * fires successfully again, else it re-files phantom "routine is failing" bugs forever.
 */
export const REAPER_LAST_ERROR_SOURCE = 'dbos-executor-reaper';

/**
 * Clear a STALE reaper-sourced `last_error` off a routine after it fires successfully.
 *
 * WHY: `reapDeadExecutorWorkflows` stamps `metadata.last_error` (source
 * `${REAPER_LAST_ERROR_SOURCE}`) with "produced no DBOS operation output; …requeued
 * the routine" as its self-heal marker. A routineFire that later COMPLETES a dispatch
 * step DID produce DBOS operation output — which directly DISPROVES that verdict — so
 * the marker is now stale and must be removed. Otherwise `collectRoutineFailureSignals`
 * keeps minting `routine-failure` bugs (EI-5938 and 25+ others: loop-su-* + system
 * routines that don't manage their own last_error leaked the marker permanently,
 * because the loop-wake branch returns before any metadata clear and the system
 * success-clear was scoped to `last_error_source='runner'`).
 *
 * SOURCE-SCOPED ON PURPOSE — this is the safety property that lets it run on every
 * successful fire without masking a real problem:
 *   - `runner`-sourced errors (a system action that THREW) are LEFT for the action's
 *     own success-path clear, so a genuinely-throwing action stays visible.
 *   - git-sync records `last_error` with NO source key (recordOutcome) and is UNTOUCHED.
 *   - A GENUINELY wedged routine whose fire keeps getting reaped never completes a
 *     dispatch step, so it never reaches this clear — the reaper re-stamps the marker
 *     each reap and the alarm still fires.
 *
 * Fail-soft: a clear failure must never fail the fire it rides.
 */
export async function clearStaleReaperLastError(sql: Sql, routineId: string): Promise<void> {
  // WI-1416: `reaped_count` is the reaper's consecutive-reap counter — a completed
  // dispatch disproves the reap verdict exactly like the marker keys, so drop it too.
  await sql`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source' - 'reaped_count',
           updated_at = now()
     WHERE id = ${routineId}
       AND metadata->>'last_error_source' = ${REAPER_LAST_ERROR_SOURCE}`.catch(() => {});
}

let reaperTimer: ManagedHandle | null = null;

/**
 * Start the reaper: an immediate boot reap + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_DBOS_EXECUTOR_REAPER='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startExecutorReaper(
  sql: Sql,
  opts: {
    intervalMs?: number;
    livenessThresholdMs?: number;
    staleSchedulerMs?: number;
    staleRoutineFireNoOutputMs?: number;
    staleRoutineFireOrphanMs?: number;
    /** EI-18752434722211671: this process's own start time (epoch ms). Defaults to
     *  `Date.now() - Math.floor(process.uptime() * 1000)` (the same "derive true
     *  process start from Node's own uptime counter" idiom already used by
     *  orphaned-dispatch.ts, mug-warm-session.ts and
     *  compaction-compliance-watchdog.ts) — reads the OS-backed uptime clock rather
     *  than a module-load-time capture, so it is correct even if this module is
     *  imported/evaluated a moment after the process actually started. Threaded into
     *  EVERY reap call (boot + every periodic tick), not just the first: the value is
     *  fixed for the process's lifetime, so it can only ever match rows that predate
     *  this process — never one it creates itself later. */
    processStartedAtMs?: number;
  } = {},
): void {
  if (process.env.PAPERCUSP_DBOS_EXECUTOR_REAPER === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const processStartedAtMs = opts.processStartedAtMs ?? Date.now() - Math.floor(process.uptime() * 1000);

  // EI-3673: `run` used to be `(): void` — it fired `reapDeadExecutorWorkflows(...)`
  // with `void promise.then(onSuccess)` and RETURNED IMMEDIATELY without waiting for
  // it. That broke two things managedSetInterval's tick wrapper relies on to make
  // this reaper's health VISIBLE and safe to overlap:
  //   1. Re-entrancy: the wrapper's `rec.running` guard (skip a tick if the previous
  //      one is still running) only holds while it is actually AWAITING the fn's
  //      returned promise. Since `run()` returned `undefined` synchronously, `running`
  //      flipped back to false almost instantly — so on a slow reap pass (e.g. many
  //      queued queries right after a restart, while the pool is still reconnecting)
  //      a SECOND tick could start concurrently with the first, rather than being
  //      skipped as intended.
  //   2. Visibility: schedule:inventory's `lastFireAt`/`fires` (the regression/health
  //      guard this ticket asks for) were stamped the instant `run()` returned, NOT
  //      when the reap actually finished — so the recorded fire timing didn't reflect
  //      real completion, undermining exactly the kind of "did this actually run"
  //      diagnosis this ticket needed.
  // `run` now RETURNS the promise chain so the tick wrapper genuinely awaits it —
  // fixing both. Note `reapDeadExecutorWorkflows` already has its OWN top-level
  // try/catch (never rejects; logs "reap pass failed (non-fatal)" and returns an
  // empty result) — so this fix is about overlap-safety + accurate timing, not about
  // catching a rejection (there isn't one to catch, by design of that function).
  const run = (): Promise<void> => {
    return reapDeadExecutorWorkflows(
      sql,
      opts.livenessThresholdMs,
      opts.staleSchedulerMs,
      opts.staleRoutineFireNoOutputMs,
      opts.staleRoutineFireOrphanMs,
      processStartedAtMs,
    ).then((r) => {
      if (r.cancelled > 0) {
        console.warn(
          `[dbos-executor-reaper] reaped ${r.cancelled} workflow(s); dead executor(s): ${r.deadExecutorIds.join(', ') || 'none'}; stale workflow(s): ${r.staleWorkflowIds.join(', ') || 'none'}; requeued routine(s): ${r.requeuedRoutineIds.join(', ') || 'none'}`,
        );
      }
    });
  };

  void run(); // boot reap — best-effort; reapDeadExecutorWorkflows never rejects (see above)
  if (reaperTimer) reaperTimer.stop();
  reaperTimer = managedSetInterval('dbos-executor-reaper', intervalMs, run, { category: 'watchdog' });
}
