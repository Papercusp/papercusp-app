/**
 * The ONE enqueue path for a staged work-item admission bulk-dedup run.
 *
 * A bulk-dedup run executes as a one-shot `system:work-item-admission-bulk-dedup`
 * routine fire (ownSteps, 24h fire timeout). Two callers start one:
 *   - the on-demand `work_items:bulk_dedup` tool (an operator or agent run), and
 *   - the daily `system:work-item-admission-bulk-dedup-driver` routine, which exists
 *     because nothing scheduled a run at all for weeks (WI-10004722, plan
 *     work-queue-bulk-cleanup-remediation-2026-10-01 P-005). The daily digest needs
 *     a completed, yielding bulk stage and sat blocked on `census-coverage-mismatch`
 *     for 18 straight days because the last census was from 2026-09-05.
 *
 * Both callers go through `enqueueBulkDedupRun`, so a scheduled run is the same
 * routine row, the same payload shape and the same live-fire guard as a manual run.
 */
import { randomUUID } from 'node:crypto';
import { upsertRoutine } from '@papercusp/db-org';
import { computeNextFireAt } from './harness/routines/cron';
import { WORK_ITEM_ADMISSION_BULK_DEDUP } from './work-items-admission-bulk-dedup';

export type BulkDedupRoutineSql = Parameters<typeof upsertRoutine>[0];

/** The daily driver's system action name (`system:work-item-admission-bulk-dedup-driver`). */
export const WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER = 'work-item-admission-bulk-dedup-driver';
/** Default stage budget per scheduled run — bounds the daily model spend. */
export const DEFAULT_DRIVER_MAX_STAGES = 2;

/** Optional run controls, passed through to the action payload unchanged. */
export interface BulkDedupRunControls {
  maxStages?: number;
  maxPairsPerStage?: number;
  pairsPerCall?: number;
  shardConcurrency?: number;
  targetTokens?: number;
  ceilingTokens?: number;
  chunkCount?: number;
  fullCorpusPairThreshold?: number;
  /** Per-run model override (BulkDedupRunOptions.model). Absent keeps the policy default. */
  model?: string;
}

export interface ActiveBulkDedupFire {
  routineId: string;
  workflowUuid: string;
  status: 'PENDING' | 'ENQUEUED';
}

/**
 * How long a started-but-unfinished census / bulk-stage row, or an armed-but-unfired
 * bulk-dedup routine, still counts as in flight. It is the 24h routine-fire timeout
 * plus slack: past it the fire has been killed, so the row is a stale leftover, not
 * a running pass, and must not block the next scheduled run forever.
 */
export const BULK_DEDUP_IN_FLIGHT_WINDOW_MS = 26 * 60 * 60_000;

export function newBulkDedupRunId(prefix = 'bulk-dedup', nowMs: number = Date.now()): string {
  return `${prefix}-${nowMs}-${randomUUID().slice(0, 8)}`;
}

export function bulkDedupRoutineName(runId: string): string {
  return `${WORK_ITEM_ADMISSION_BULK_DEDUP}-${runId}`.slice(0, 180);
}

export function bulkDedupRoutineId(harness: string, routineName: string): string {
  return `rt_${harness}_${routineName}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

function pgErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
}

/**
 * A routine's payload is serialized into the DBOS workflow input at enqueue
 * time. Updating the routine row while that deduplicated fire is live only
 * changes the NEXT fire; it cannot change the already-serialized workflow
 * input. Surface that state before upsertRoutine so a same-run rearm cannot
 * report success while silently retaining stale controls.
 */
export async function activeBulkDedupFire(
  sql: BulkDedupRoutineSql,
  routineId: string,
): Promise<ActiveBulkDedupFire | null> {
  try {
    const rows = await sql<ActiveBulkDedupFire[]>`
      SELECT r.id AS "routineId", d.workflow_uuid AS "workflowUuid", d.status
        FROM harness_shared.routines r
        JOIN dbos.workflow_status d
          ON d.deduplication_id = ('routine:' || r.id)
         AND d.status IN ('PENDING', 'ENQUEUED')
       WHERE r.id = ${routineId}
       ORDER BY d.created_at DESC
       LIMIT 1
    `;
    return rows[0] ?? null;
  } catch (error) {
    // Some read-only/unit environments do not provision DBOS. That means
    // there cannot be a live routineFire dedup row to protect. All other
    // failures stay loud: updating a payload without the protection query
    // would recreate the very outcome-unknown hazard this guard prevents.
    if (pgErrorCode(error) === '42P01') return null;
    throw error;
  }
}

/**
 * DBOS statuses after which a workflow never runs again on its own. A stage row
 * leased to a workflow in one of these is abandoned (WI-10004918).
 */
export const DEAD_LEASE_OWNER_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const;

export type BulkDedupInFlight =
  | { inFlight: false }
  | {
      inFlight: true;
      reason: 'routine-fire-live' | 'routine-armed' | 'admission-run-open';
      /** Routine id (fire/armed) or admission_runs id (open run). */
      ref: string;
      detail: string;
    };

/**
 * Is ANY bulk-dedup pass for this harness still in flight — whichever caller
 * started it? Checked in the order a run moves through: an armed routine row that
 * has not fired yet, a live DBOS routineFire, then a census / bulk-stage
 * admission_runs row that started and never finished. Rows older than
 * BULK_DEDUP_IN_FLIGHT_WINDOW_MS are stale leftovers and do not count.
 */
export async function bulkDedupInFlight(
  sql: BulkDedupRoutineSql,
  input: { workspaceId: string; harnessSlug: string; nowMs?: number },
): Promise<BulkDedupInFlight> {
  const targetRole = `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`;
  const since = new Date((input.nowMs ?? Date.now()) - BULK_DEDUP_IN_FLIGHT_WINDOW_MS);

  const armed = await sql<{ id: string; nextFireAt: Date }[]>`
    SELECT id, next_fire_at AS "nextFireAt"
      FROM harness_shared.routines
     WHERE workspace_id = ${input.workspaceId}
       AND install_slug = ${input.harnessSlug}
       AND target_role = ${targetRole}
       AND active
       AND next_fire_at IS NOT NULL
       AND next_fire_at > ${since}
     ORDER BY next_fire_at DESC
     LIMIT 1
  `;
  if (armed[0]) {
    return {
      inFlight: true,
      reason: 'routine-armed',
      ref: armed[0].id,
      detail: `armed to fire at ${new Date(armed[0].nextFireAt).toISOString()}`,
    };
  }

  try {
    const live = await sql<ActiveBulkDedupFire[]>`
      SELECT r.id AS "routineId", d.workflow_uuid AS "workflowUuid", d.status
        FROM dbos.workflow_status d
        JOIN harness_shared.routines r
          ON d.deduplication_id = ('routine:' || r.id)
       WHERE d.status IN ('PENDING', 'ENQUEUED')
         AND r.workspace_id = ${input.workspaceId}
         AND r.install_slug = ${input.harnessSlug}
         AND r.target_role = ${targetRole}
       LIMIT 1
    `;
    if (live[0]) {
      return {
        inFlight: true,
        reason: 'routine-fire-live',
        ref: live[0].routineId,
        detail: `workflow ${live[0].workflowUuid} is ${live[0].status}`,
      };
    }
  } catch (error) {
    if (pgErrorCode(error) !== '42P01') throw error;
  }

  // An open row whose lease owner is a DBOS workflow that has already ended is
  // abandoned, not in flight: nothing will ever resume it (WI-10004918). A
  // routineFire dead-lettered by host restarts (MAX_RECOVERY_ATTEMPTS_EXCEEDED)
  // used to keep its stage row "open" and block the retry for the whole window.
  // The next run's reapStaleRunningAdmissionRuns then marks the row failed, and
  // D-007 donates its completed batches. A row whose owner is not a DBOS
  // workflow (or is still PENDING/ENQUEUED) keeps counting, as before.
  let open: { id: string; runKind: string; startedAt: Date }[];
  try {
    open = await sql<{ id: string; runKind: string; startedAt: Date }[]>`
      SELECT a.id, a.run_kind AS "runKind", a.started_at AS "startedAt"
        FROM harness_shared.admission_runs a
       WHERE a.workspace_id = ${input.workspaceId}
         AND a.harness_slug = ${input.harnessSlug}
         AND a.run_kind IN ('census', 'bulk-stage')
         AND a.finished_at IS NULL
         AND a.started_at > ${since}
         AND NOT EXISTS (
           SELECT 1
             FROM dbos.workflow_status d
            WHERE d.workflow_uuid = a.detail->'lease'->>'ownerId'
              AND d.status = ANY(${DEAD_LEASE_OWNER_STATUSES as unknown as string[]}::text[])
         )
       ORDER BY a.started_at DESC
       LIMIT 1
    `;
  } catch (error) {
    if (pgErrorCode(error) !== '42P01') throw error;
    open = await sql<{ id: string; runKind: string; startedAt: Date }[]>`
      SELECT id, run_kind AS "runKind", started_at AS "startedAt"
        FROM harness_shared.admission_runs
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND run_kind IN ('census', 'bulk-stage')
         AND finished_at IS NULL
         AND started_at > ${since}
       ORDER BY started_at DESC
       LIMIT 1
    `;
  }
  if (open[0]) {
    return {
      inFlight: true,
      reason: 'admission-run-open',
      ref: open[0].id,
      detail: `${open[0].runKind} started ${new Date(open[0].startedAt).toISOString()} and has not finished`,
    };
  }
  return { inFlight: false };
}

export type EnqueueBulkDedupRunResult =
  | {
      ok: true;
      enqueued: true;
      runId: string;
      routineId: string;
      nextFireAt: string | null;
      targetRole: string;
      completionEvidence: { query: string; expectedRunPrefix: string; terminalStates: string[] };
    }
  | {
      ok: false;
      enqueued: false;
      alreadyRunning: true;
      reason: 'already_running';
      runId: string;
      routineId: string;
      workflowUuid: string;
      workflowStatus: ActiveBulkDedupFire['status'];
      message: string;
    };

/**
 * Arm one due-now bulk-dedup routine fire. `routineName` defaults to the per-run
 * name (`work-item-admission-bulk-dedup-<runId>`); the scheduled driver passes a
 * fixed name instead so a daily cadence re-arms one row rather than minting a new
 * routine row every day. Either way, a routine whose previous fire is still live
 * is refused rather than re-armed (its serialized payload cannot change).
 */
export async function enqueueBulkDedupRun(
  sql: BulkDedupRoutineSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    runId: string;
    routineName?: string;
    controls?: BulkDedupRunControls;
  },
): Promise<EnqueueBulkDedupRunResult> {
  const { runId } = input;
  const routineName = input.routineName ?? bulkDedupRoutineName(runId);
  const activeFire = await activeBulkDedupFire(sql, bulkDedupRoutineId(input.harnessSlug, routineName));
  if (activeFire) {
    return {
      ok: false,
      enqueued: false,
      alreadyRunning: true,
      reason: 'already_running',
      runId,
      routineId: activeFire.routineId,
      workflowUuid: activeFire.workflowUuid,
      workflowStatus: activeFire.status,
      message:
        'A routineFire for this run is still pending/enqueued. Its serialized payload is immutable until the deduplication row reaches a terminal state; retry this runId after that.',
    };
  }
  const controls = input.controls ?? {};
  const payloadTemplate: Record<string, unknown> = {
    runId,
    maxStages: controls.maxStages,
    maxPairsPerStage: controls.maxPairsPerStage,
    pairsPerCall: controls.pairsPerCall,
    shardConcurrency: controls.shardConcurrency,
    targetTokens: controls.targetTokens,
    ceilingTokens: controls.ceilingTokens,
    chunkCount: controls.chunkCount,
    fullCorpusPairThreshold: controls.fullCorpusPairThreshold,
  };
  if (controls.model !== undefined) payloadTemplate.model = controls.model;
  const routine = await upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.harnessSlug,
      name: routineName,
      triggerKind: 'cron',
      triggerConfig: {},
      targetRole: `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`,
      payloadTemplate,
      concurrency: 'skip',
      catchup: 'skip-old',
      active: true,
      nextFireAt: new Date(),
    },
    computeNextFireAt,
  );
  return {
    ok: true,
    enqueued: true,
    runId,
    routineId: routine.id,
    nextFireAt: routine.nextFireAt?.toISOString() ?? null,
    targetRole: routine.targetRole,
    completionEvidence: {
      query: 'workItemAdmission.runs',
      expectedRunPrefix: runId,
      terminalStates: ['complete', 'failed'],
    },
  };
}
