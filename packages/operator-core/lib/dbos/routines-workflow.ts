/**
 * The generic scheduled-routines engine on DBOS — git-sync-auto-commit Phase 1
 * (D-001). REVIVES the dormant in-process `routine-ticker` `setTimeout` loop
 * (`libs/papercusp/libs/db/src/routine-ticker.ts`, never started in the operator)
 * as a **durable DBOS scheduled workflow**.
 *
 * Each tick (default every 30s, skip-missed so a long-closed desktop doesn't
 * backfill a storm):
 *   1. `listDueCronRoutines()` — every workspace's due cron routines (the admin
 *      `getOrgPg()` connection bypasses RLS, so one query spans workspaces).
 *   2. For each, **claim** it with a conditional `next_fire_at` advance (so two
 *      concurrent ticks can't both fire it), then enqueue a per-routine durable
 *      fire workflow with a dedup ID (`routine:<id>`) for belt-and-suspenders
 *      single-fire + natural back-pressure (a long fire collapses the next
 *      enqueue while it runs — same shape as the autoloop fire queue).
 *
 * The fire dispatches by target (D-006):
 *   - `system:<action>` → run the registered handler INLINE as one durable step
 *     (the git-sync path; see `system-actions.ts`).
 *   - an agent role → spawn the role (wired in git-sync-auto-commit P-012; until
 *     then this branch logs and no-ops, and no role routines are configured).
 *
 * Flag-gated by `dbosRoutinesActive()` — **opt-in** (PAPERCUSP_DBOS_ROUTINES=1)
 * while the engine is new, so a host restart never auto-fires stale/unknown
 * routines unsupervised. Registered only when `bootstrap.ts` imports this module.
 */
import { DBOS, DBOSClient, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_FLEET_CONTROL_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  ROUTINES_LOOP_QUEUE,
  ROUTINES_RELEASE_QUEUE,
  ROUTINES_DEPLOY_QUEUE,
  ROUTINES_TRIGGERS_QUEUE,
  queueForRoutine,
  shouldFireUnderPoolShed,
} from './routines-queue-classification';
import { getOrgPg, listDueCronRoutines, type RoutineRow } from '@papercusp/db-org';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { runWithWorkspace } from '../workspace-als';
import { loopbackFetch } from '../loopback-fetch';
import { claimDueRoutine, claimedRoutineDispatchAllowed } from '../harness/routines/claim';
import {
  classifyClaimSkip,
  recordUnclaimableRoutine,
  clearUnclaimableRoutine,
} from '../harness/routines/unclaimable-routine-detector';
import { checkFireGate, recordFire } from '../autoloop';
import { fireLoopWake } from '../harness/routines/loop-fire';
import {
  getSystemAction,
  getSystemActionEntry,
  SYSTEM_TARGET_PREFIX,
  type SystemActionResult,
} from '../harness/routines/system-actions';
import { restrictedTreeSkipReason } from '../harness/routines/restricted-tree-skip';
import { clearStaleReaperLastError } from './dbos-executor-reaper';
import {
  CRITICAL_PROBE_MS,
  ELEVATED_PROBE_MS,
  poolPressure,
  recordPoolShed,
  lastPoolProbeMs,
  lastPoolProbeRawMs,
  lastPoolProbeLoopDelayMs,
  recordPoolShedEvent,
  type PoolPressure,
} from './pool-pressure';
import { activeWorkspaceId } from '../workspace-registry';
import { shouldShedSchedulerTickUnderLoopPressure } from './tick-load-shed';
import { anotherRoutinesTickInFlight, ROUTINE_TICK_OVERLAP_STATEMENT_TIMEOUT_MS } from './routine-tick-overlap-guard';
import { CaplessAdaptiveController } from '../resource-governor/controller';
import { HEALTH_ANALYSIS_SCHEMA_VERSION, type HealthVerdict } from '../resource-governor/health-analysis';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';
// Side-effect import (F-E1 phase 1): wire papercusp-routines-per-workspace into the routines lib.
import '../harness/routines/configure-per-workspace';
import { operatorApiBase } from '../operator-api-base';
import { dbosStarted, withDbosIdleTxGrace } from './bootstrap';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = operatorApiBase;
const ROUTINE_FIRE_WORKFLOW_NAME = 'routineFire';
let routineFireDbosClient: Promise<DBOSClient> | null = null;

function routineFirePrimaryAppVersion(): string {
  return (
    process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim() ||
    process.env.DBOS__APPVERSION?.trim() ||
    'bg-host-v1'
  );
}

function getRoutineFireDbosClient(): Promise<DBOSClient> {
  routineFireDbosClient ??= DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(getHarnessAdminUrlWithSource().url),
    systemDatabaseSchemaName: 'dbos',
  }).catch((error: unknown) => {
    routineFireDbosClient = null;
    throw error;
  });
  return routineFireDbosClient;
}

// WI-4015 (critical, 2026-07-11): idempotentWorkflowQueue guards against a second
// top-level module evaluation throwing "Workflow Queue '<name>' defined multiple
// times" inside startDbos()'s import chain — a failure that host-bootstrap.ts's
// caller only logs as "[dbos] boot failed (non-fatal)" and swallows, silently
// preventing DBOS.launch() (and therefore routinesTick itself) from ever arming.
// See idempotent-register-workflow.ts's doc comment for the full incident story.
const routinesQueue = idempotentWorkflowQueue(
  ROUTINES_QUEUE,
  () => new WorkflowQueue(ROUTINES_QUEUE, { concurrency: queueConcurrency(4) }),
);
// EI-22469496587311452: gitnexus reindex shells out to a CPU/memory-heavy analyze
// process with a measured multi-hour budget. Keep it isolated from short housekeeping
// fires and serialize it so overlapping index writers cannot compete for the host.
const routinesHeavyQueue = idempotentWorkflowQueue(
  ROUTINES_HEAVY_QUEUE,
  () => new WorkflowQueue(ROUTINES_HEAVY_QUEUE, { concurrency: queueConcurrency(1) }),
);
// Protected lane for critical QUICK routines (git-sync) — a saturated shared `routines` queue (long
// routines holding every slot) must never starve fleet-wide persistence (the 2026-06-23 7h commit-freeze).
// Low concurrency: git-sync fires are quick AND serializing them avoids git-index contention across the
// per-hive git-sync routines. Instantiated at module load so DBOS listens on it; fires route here via
// queueForRoutine(). Both names exported so a boot/deploy check can assert DBOS is listening on each.
const routinesCriticalQueue = idempotentWorkflowQueue(
  ROUTINES_CRITICAL_QUEUE,
  () => new WorkflowQueue(ROUTINES_CRITICAL_QUEUE, { concurrency: queueConcurrency(2) }),
);
// EI-22526486100493483: fleet restoration is latency-sensitive control-plane work,
// but its spawn + worker-attestation path can be materially longer than git-sync,
// loop wakes, or inbound-source polls. A dedicated serial lane prevents an ordinary
// due-routine backlog from starving recovery without letting headcount work occupy
// any of those must-stay-responsive queues.
const routinesFleetControlQueue = idempotentWorkflowQueue(
  ROUTINES_FLEET_CONTROL_QUEUE,
  () => new WorkflowQueue(ROUTINES_FLEET_CONTROL_QUEUE, { concurrency: queueConcurrency(1) }),
);
// EI-21386288922867645: loop wakes are quick but deadline-sensitive. A five-minute
// loop sat FIFO behind 29 shared-routines jobs for ~11 minutes; a separate bounded
// lane keeps long green-checkpoint/gym fires from consuming its execution slots.
const routinesLoopQueue = idempotentWorkflowQueue(
  ROUTINES_LOOP_QUEUE,
  () => new WorkflowQueue(ROUTINES_LOOP_QUEUE, { concurrency: queueConcurrency(4) }),
);
// WI-41662: external-source polls (gmail/calendar/pr/vault) are quick and run per-minute,
// but their latency IS the product behaviour — an inbound email is not ingested until the
// poll executes. On the shared lane they sat FIFO behind green-checkpoint's hourly ~25m
// fire for 4–18min, every hour, 13 times in one measured day. Bounded lane, same principle
// as routines-loop above.
const routinesTriggersQueue = idempotentWorkflowQueue(
  ROUTINES_TRIGGERS_QUEUE,
  () => new WorkflowQueue(ROUTINES_TRIGGERS_QUEUE, { concurrency: queueConcurrency(4) }),
);
// EI-21446637172005297: the operator-home green-checkpoint is the release finalizer for
// the workspace. A frozen repair queue cannot recover while this fire waits FIFO behind
// four long subject-hive gates, so keep the home finalizer on a dedicated serial lane.
// Subject-hive green-checkpoints remain on the shared queue and retain its bounded
// concurrency; queueForRoutine identifies the home via operatorHomeHarnessSlug().
const routinesReleaseQueue = idempotentWorkflowQueue(
  ROUTINES_RELEASE_QUEUE,
  () => new WorkflowQueue(ROUTINES_RELEASE_QUEUE, { concurrency: queueConcurrency(1) }),
);
// EI-23909857328600541: release-trigger is the deploy LAUNCHER — it evaluates the plan and
// fires detached units (auto-deploy, exact-pin live certification) without awaiting them, so
// it is quick, but a starved fire is a deploy that never happens. On the shared lane two fires
// hung 49 and 37 minutes (ROUTINE_FIRE_TIMEOUT_MS is 2h, so a hung fire holds its slot that
// long), the epoch computed available=0, and 426 green commits sat undeployed while nothing
// remained to launch their certification. Serial: the units it starts are themselves
// fixed-unit-name singletons, so concurrent evaluations buy nothing.
const routinesDeployQueue = idempotentWorkflowQueue(
  ROUTINES_DEPLOY_QUEUE,
  () => new WorkflowQueue(ROUTINES_DEPLOY_QUEUE, { concurrency: queueConcurrency(1) }),
);
export const ROUTINE_FIRE_QUEUES = [
  routinesQueue.name,
  routinesHeavyQueue.name,
  routinesCriticalQueue.name,
  routinesFleetControlQueue.name,
  routinesLoopQueue.name,
  routinesTriggersQueue.name,
  routinesReleaseQueue.name,
  routinesDeployQueue.name,
] as const;

type DueRoutine = {
  readonly id: string;
  readonly targetRole: string;
  readonly installSlug: string;
  readonly nextFireAt: Date | null;
};

/**
 * Preserve FIFO dispatch by due time, with a stable id tie-breaker. The due
 * population changes as fires are claimed and new cron rows become due, so a
 * count cursor modulo the current population can follow the growing tail while
 * leaving the oldest row at the head indefinitely.
 */
export function orderDueRoutinesByAge<T extends DueRoutine>(due: readonly T[]): T[] {
  return [...due].sort((a, b) => {
    const aAt = a.nextFireAt?.getTime();
    const bAt = b.nextFireAt?.getTime();
    if (aAt === undefined) return bAt === undefined ? a.id.localeCompare(b.id) : -1;
    if (bAt === undefined) return 1;
    return aAt - bAt || a.id.localeCompare(b.id);
  });
}

export interface RoutineDispatchQueueDecision {
  readonly queueName: string;
  readonly inFlight: number;
  readonly desiredWindow: number;
  readonly effectiveWindow: number;
  readonly controllerAvailableStarts: number;
  readonly availableStarts: number;
  /** The critical lane remains attributable to database pressure; only its one-start floor is protected. */
  readonly controllerProtected: boolean;
}

export interface RoutineDispatchAdmissionEpoch {
  readonly pressure: PoolPressure;
  readonly probeMs: number;
  readonly evaluatedAtMs: number;
  readonly generation: number;
  readonly reasons: readonly string[];
  readonly queues: readonly RoutineDispatchQueueDecision[];
}

/**
 * One process-local controller owns the feedback history between scheduler ticks.
 * The durable source of truth is the indexed DBOS in-flight population read below;
 * resetting this transient state on a process restart is deliberately safe because
 * a cold controller restarts at the one-start floor. Persisting a larger window via
 * the shared snapshot store would add a write to the pool this guard protects and
 * could restore stale optimistic credit after a host failure. Each evaluated epoch
 * is nevertheless a DBOS step output, so replay of that tick uses the exact decision.
 */
export function createRoutineDispatchController(): CaplessAdaptiveController {
  return new CaplessAdaptiveController({
    initialWindow: 1,
    minimumWindow: 1,
    // EI-24202587238356894: a bg-host restart resets this process-local window.
    // With 67 git-sync installs, +1 every third 30-second tick takes over 16m to
    // regain the roughly 12 starts/tick needed for their three-minute cadence.
    // Grow by three after three healthy observations: the first two cold ticks
    // still admit only one start. Critical pool feedback still limits this
    // queue to one start and contracts an occupied, attributable class.
    increaseStep: 3,
  });
}

const routineDispatchController = createRoutineDispatchController();

/**
 * Read actual queued/running routine-fire occupancy from DBOS's partial in-flight
 * index (`idx_workflow_status_in_flight`: queue_name/status/priority/created_at).
 * Counts are complete before shaping, and include both asynchronous enqueue states.
 */
export async function readRoutineFireInFlightByQueue(
  sql: ReturnType<typeof getOrgPg>['sql'],
): Promise<Readonly<Record<string, number>>> {
  const rows = await sql<{ queue_name: string; in_flight: number | string }[]>`
    SELECT queue_name, count(*)::int AS in_flight
      FROM dbos.workflow_status
     WHERE queue_name = ANY(${[...ROUTINE_FIRE_QUEUES]}::text[])
       AND status IN ('ENQUEUED', 'PENDING')
       AND name = 'routineFire'
     GROUP BY queue_name`;
  const counts: Record<string, number> = Object.fromEntries(ROUTINE_FIRE_QUEUES.map((queueName) => [queueName, 0]));
  for (const row of rows) {
    if (!(ROUTINE_FIRE_QUEUES as readonly string[]).includes(row.queue_name)) continue;
    const value = Number(row.in_flight);
    counts[row.queue_name] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return Object.freeze(counts);
}

/** Direct physical pool feedback in the canonical controller's health vocabulary. */
export function routinePoolHealthVerdict(
  pressure: PoolPressure,
  probeMs: number,
  evaluatedAtMs: number,
): HealthVerdict {
  const degraded = pressure !== 'ok';
  const severity = pressure === 'critical' ? 'critical' : pressure === 'elevated' ? 'warning' : 'none';
  const objectiveId = 'routine-org-admin-pool-latency';
  const verdict: HealthVerdict = {
    schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
    scopeId: 'dbos-routine-dispatch',
    evaluatedAtMs,
    state: degraded ? 'degraded' : 'healthy',
    severity,
    // WI-10001738: ONLY `critical` is actionable. `elevated` stays state:'degraded'
    // (it genuinely is) but non-actionable, which routes it to CaplessAdaptiveController's
    // third branch — `health-<state>-holds-window` — that HOLDS the window and zeroes
    // healthySamples instead of contracting it.
    //
    // Why: contraction is multiplicative, recovery is +1 per healthy tick. Measured on
    // bg-host over a 40min window, pool verdicts ran 75 ok / 22 elevated / 19 critical —
    // so ~35% of ticks contracted and the window never rose above 3, sitting at its
    // minimumWindow floor of 1 for 76 of 116 samples. At window=1 each queue starts ONE
    // routine per tick against ~50 git-sync installs plus dozens of other routines, so
    // routines fell permanently behind: 30+ overdue fleet-wide, worst 8h49m, which froze
    // git-sync/papercusp for 3h and with it the green gate and every agent's deploy.
    //
    // Elevated must still STOP upward probing (that is the early warning doing its job,
    // and zeroing healthySamples preserves it) — it must not tear the window down.
    actionable: pressure === 'critical',
    evidence: [
      {
        objectiveId,
        signal: 'database.waitP95Ms',
        resource: 'database',
        readingState: 'measured',
        value: probeMs,
        confidence: 1,
        baseline: null,
        warningBoundary: ELEVATED_PROBE_MS,
        criticalBoundary: CRITICAL_PROBE_MS,
        inflationRatio: null,
        breached: degraded,
        severity,
        quality: 'actionable',
        reason: degraded ? `org-admin-pool-${pressure}` : 'org-admin-pool-healthy',
      },
    ],
    attributions: degraded
      ? [
          {
            objectiveId,
            outcomeSignal: 'database.waitP95Ms',
            causeSignal: 'database.waitP95Ms',
            resource: 'database',
            confidence: 1,
            correlation: 1,
            temporallyAligned: true,
            actionable: true,
            reason: 'direct-org-admin-acquire-latency',
          },
        ]
      : [],
    actionableResources: degraded ? ['database'] : [],
    ignoredCapacitySignals: [],
    reasons: [degraded ? `physical-pool-${pressure}` : 'physical-pool-healthy'],
  };
  return Object.freeze(verdict);
}

/**
 * Build one capless feedback epoch before any routine is claimed.
 *
 * A single fresh probe describes the PREVIOUS cohort: asynchronous DBOS starts
 * from this tick cannot materialize quickly enough to grade themselves. The
 * controller therefore adjusts its unbounded AIMD window once, subtracts the
 * actual ENQUEUED/PENDING population, and hands the loop a finite amount of
 * feedback credit to spend. Healthy active lanes keep probing upward; idle lanes
 * do not accumulate speculative credit. Under critical pressure all ordinary
 * lanes close while the critical queue retains exactly one in-flight liveness
 * floor. That queue is still a normal database-attributed controller class, so
 * starts above the floor cannot escape later contraction.
 */
export function evaluateRoutineDispatchEpoch(input: {
  readonly pressure: PoolPressure;
  readonly probeMs: number;
  readonly inFlightByQueue: Readonly<Record<string, number>>;
  readonly activeQueues: readonly string[];
  readonly controller?: CaplessAdaptiveController;
  readonly atMs?: number;
}): RoutineDispatchAdmissionEpoch {
  const atMs = Math.max(0, Math.floor(input.atMs ?? Date.now()));
  const active = new Set(input.activeQueues);
  const queues = ROUTINE_FIRE_QUEUES.filter(
    (queueName) => active.has(queueName) || (input.inFlightByQueue[queueName] ?? 0) > 0,
  );
  const controller = input.controller ?? routineDispatchController;
  const decision = controller.step({
    verdict: routinePoolHealthVerdict(input.pressure, input.probeMs, atMs),
    classes: queues.map((queueName) => ({
      admissionClass: queueName,
      inFlight: Math.max(0, Math.floor(input.inFlightByQueue[queueName] ?? 0)),
      demand: { databaseConnections: 1 },
    })),
    atMs,
  });
  const byClass = new Map(decision.classes.map((item) => [item.admissionClass, item]));
  return Object.freeze({
    pressure: input.pressure,
    probeMs: input.probeMs,
    evaluatedAtMs: atMs,
    generation: decision.generation,
    reasons: decision.reasons,
    queues: Object.freeze(
      queues.map((queueName): RoutineDispatchQueueDecision => {
        const lane = byClass.get(queueName);
        if (!lane) throw new Error(`routine dispatch controller omitted active queue ${queueName}`);
        const inFlight = Math.max(0, Math.floor(input.inFlightByQueue[queueName] ?? 0));
        const availableStarts =
          input.pressure !== 'critical'
            ? lane.availableStarts
            : queueName === ROUTINES_CRITICAL_QUEUE
              ? Math.max(0, 1 - inFlight)
              : 0;
        return Object.freeze({
          queueName,
          inFlight,
          desiredWindow: lane.desiredWindow,
          effectiveWindow: lane.effectiveWindow,
          controllerAvailableStarts: lane.availableStarts,
          availableStarts,
          controllerProtected: lane.protected,
        });
      }),
    ),
  });
}

/** Hard ceiling on one routine fire — the dedup-ID release valve (exported for tests). */
export const ROUTINE_FIRE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Resolve the DBOS deadline for a routine fire from the registered action.
 *
 * The two-hour default is deliberately retained for every unannotated action:
 * it is the dead-executor dedup release valve. Long-running system actions can
 * declare a larger, still-bounded deadline in `SystemActionOptions` without
 * widening the timeout for unrelated routines. Non-system targets and unknown
 * actions fail closed to the default.
 */
export function routineFireTimeoutMs(targetRole: string): number {
  if (!targetRole.startsWith(SYSTEM_TARGET_PREFIX)) return ROUTINE_FIRE_TIMEOUT_MS;
  const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
  const configured = getSystemActionEntry(action)?.routineTimeoutMs;
  if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured <= 0) {
    return ROUTINE_FIRE_TIMEOUT_MS;
  }
  return configured;
}

const QUEUE_DEDUP_DUPLICATED_CODE = 28;

/** True when DBOS rejected a start because its deduplication ID is already active. */
export function isRoutineFireDedupConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { dbosErrorCode?: number }).dbosErrorCode === QUEUE_DEDUP_DUPLICATED_CODE
  );
}

/** The persisted routine fields needed to replay the exact routine-fire payload. */
export type RoutineFireRow = Pick<
  RoutineRow,
  | 'id'
  | 'workspaceId'
  | 'installSlug'
  | 'name'
  | 'targetRole'
  | 'triggerConfig'
  | 'payloadTemplate'
  | 'rescheduleIntervalSec'
  | 'targetOwnerId'
>;

export type RoutineFireEnqueueResult = {
  ok: boolean;
  status: 'enqueued' | 'deduplicated' | 'unavailable';
  routineId: string;
  deduplicationId: string;
  queueName: string;
  timeoutMs: number;
  reason?: 'dbos-not-started';
};

/**
 * Enqueue one routine fire using the same queue, timeout, payload, and stable dedup key
 * as the scheduled tick. This deliberately does not mutate the routine row or advance
 * its schedule: it is the on-demand execution lever, while the routine workflow's live
 * active fence still decides whether a captured recurring fire may perform side effects.
 */
export async function enqueueRoutineFire(routine: RoutineFireRow): Promise<RoutineFireEnqueueResult> {
  const deduplicationId = `routine:${routine.id}`;
  const queueName = queueForRoutine(routine.targetRole, routine.installSlug);
  const timeoutMs = routineFireTimeoutMs(routine.targetRole);
  try {
    const workflowArgs = [
      routine.id,
      routine.workspaceId,
      routine.installSlug,
      routine.targetRole,
      routine.triggerConfig,
      routine.payloadTemplate,
      routine.name,
      routine.rescheduleIntervalSec,
      routine.targetOwnerId,
    ] as const;
    if (dbosStarted()) {
      await DBOS.startWorkflow(routineFireWorkflow, {
        queueName,
        timeoutMS: timeoutMs,
        enqueueOptions: { deduplicationID: deduplicationId },
      })(...workflowArgs);
    } else {
      await (await getRoutineFireDbosClient()).enqueue<typeof routineFireImpl>(
        {
          queueName,
          workflowName: ROUTINE_FIRE_WORKFLOW_NAME,
          deduplicationID: deduplicationId,
          workflowTimeoutMS: timeoutMs,
          appVersion: routineFirePrimaryAppVersion(),
        },
        ...workflowArgs,
      );
    }
    return {
      ok: true,
      status: 'enqueued',
      routineId: routine.id,
      deduplicationId,
      queueName,
      timeoutMs,
    };
  } catch (error) {
    if (!isRoutineFireDedupConflict(error)) throw error;
    return {
      ok: true,
      status: 'deduplicated',
      routineId: routine.id,
      deduplicationId,
      queueName,
      timeoutMs,
    };
  }
}

type BlenderSweepCoverageResult = {
  workspaceId: string;
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  eligibleBacklogCount: number;
};

/** Persist the retained Blender sweep's coverage alongside its DBOS output.
 * An empty `results` array is otherwise indistinguishable from a healthy
 * empty run, a throttle skip, or a retired-started-bit no-op. Signal counts
 * are workspace-wide and repeated once per Hive scope, so that sweep gets a
 * workspace de-duplication while the other watchdogs retain per-scope counts. */
function summarizeBlenderSweepCoverage(
  results: readonly BlenderSweepCoverageResult[],
  opts: { dedupeWorkspace?: boolean } = {},
): {
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  eligibleBacklogCount: number;
} {
  const evaluatedWorkspaceCount = results[0]?.evaluatedWorkspaceCount ?? 0;
  const evaluatedScopeCount = results[0]?.evaluatedScopeCount ?? 0;
  if (!opts.dedupeWorkspace) {
    return {
      evaluatedWorkspaceCount,
      evaluatedScopeCount,
      eligibleBacklogCount: results.reduce((total, result) => total + result.eligibleBacklogCount, 0),
    };
  }
  const byWorkspace = new Map<string, number>();
  for (const result of results) {
    if (!byWorkspace.has(result.workspaceId)) byWorkspace.set(result.workspaceId, result.eligibleBacklogCount);
  }
  return {
    evaluatedWorkspaceCount,
    evaluatedScopeCount,
    eligibleBacklogCount: [...byWorkspace.values()].reduce((total, count) => total + count, 0),
  };
}

/**
 * One durable fire of a routine: dispatch by target inside the routine's
 * workspace scope. A workflow (not just a step) so a crash mid-fire resumes; the
 * dedup ID on enqueue guards single-fire.
 */
async function routineFireImpl(
  routineId: string,
  workspaceId: string,
  installSlug: string,
  targetRole: string,
  triggerConfig: Record<string, unknown>,
  payloadTemplate: Record<string, unknown> | null,
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-3): a LOOP routine carries an
  // interval + a bound owner (su-d5a84's B-LOOP-1 schema). These are appended (optional on
  // older enqueued fires recovered after deploy → undefined → the non-loop dispatch, which
  // is correct: a non-loop routine has no interval anyway).
  routineName?: string,
  rescheduleIntervalSec?: number | null,
  targetOwnerId?: string | null,
): Promise<void> {
  await runWithWorkspace(workspaceId, async () => {
    // Checkpoint immediately so the executor reaper can distinguish "workflow
    // never entered user code" from a legitimate long-running first action.
    await DBOS.runStep(
      async () => ({
        routineId,
        workspaceId,
        installSlug,
        targetRole,
        routineName: routineName ?? routineId,
      }),
      { name: 'routine-fire-start' },
    );

    // EI-20509996472706488: claiming a recurring routine and executing its
    // durable fire are separated by a DBOS queue. A pause in that gap used to
    // update active=false but leave the already-enqueued workflow free to run
    // its captured action; release-trigger consequently launched an auto-deploy
    // seven minutes after it had been paused for a safety hold. Re-read the live
    // writer-owned flag at execution time and fail closed before ANY loop,
    // system-action, or role-spawn side effect. One-shots remain valid because
    // their successful claim intentionally deactivates the row; the helper owns
    // that distinction.
    const dispatchAllowed = await DBOS.runStep(
      async () => {
        const { sql } = getOrgPg();
        return claimedRoutineDispatchAllowed(sql, {
          id: routineId,
          triggerConfig,
          rescheduleIntervalSec: rescheduleIntervalSec ?? null,
        });
      },
      { name: 'routine-fire-active-fence' },
    );
    if (!dispatchAllowed) {
      console.warn(`[routines] ${routineId} fire CANCELLED — recurring routine was paused or removed after claim`);
      return;
    }

    // LOOP fire (B-LOOP-3 / P-004, D-005/D-006): a loop wakes its pinned session WARM instead
    // of spawning a role / running a system action. Identified by an interval + a bound owner;
    // the fire delivers a `coord` wake (rides the existing wake-executor liveness ladder — NO
    // new resume code) gated by the failure-streak fire-gate AND the cost-cap. Tracking rides
    // recordFire + the work-queue + plan progress (no per-fire plan_run, D-006). Takes
    // precedence over the system/role dispatch below.
    if (rescheduleIntervalSec != null && targetOwnerId) {
      await DBOS.runStep(
        async () => {
          const res = await fireLoopWake({
            routineId,
            routineName: routineName ?? routineId,
            workspaceId,
            installSlug,
            targetOwnerId,
            payloadTemplate,
            intervalSec: rescheduleIntervalSec,
          });
          if (!res.fired) {
            console.warn(`[routines] loop ${routineId} fire WITHHELD (${res.reason}: ${res.detail ?? ''})`);
          }
          // The step return is DBOS's durable operation_output. Preserve the full
          // LoopFireResult so a withheld/failed fire is forensic evidence rather than
          // an indistinguishable successful step with an undefined output.
          return res;
        },
        { name: 'loop:wake' },
      );
    } else if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
      const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      const entry = getSystemActionEntry(action);
      // WI-10005745 (D-012): an action that executes integration-tree code is skipped while a
      // restricted session's writes are held in that tree. The verdict is a step so a replay takes
      // the same branch; the skip is recorded on the routine row, never silent.
      if (entry?.executesIntegrationTreeCode) {
        const skip = await DBOS.runStep(() => restrictedTreeSkipReason(action, entry), {
          name: `system:${action}:restricted-hold`,
        });
        if (skip) {
          console.warn(`[routines] ${skip} (routine ${routineId})`);
          await DBOS.runStep(
            async () => {
              const { sql } = getOrgPg();
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('last_skip_reason', ${skip.slice(0, 600)}::text, 'last_skip_at', now()::text),
                       updated_at = now()
                 WHERE id = ${routineId}`.catch(() => {});
            },
            { name: `system:${action}:restricted-hold-record` },
          );
          return;
        }
      }
      const systemActionCtx = {
        installSlug,
        workspaceId,
        routineId,
        workflowId: DBOS.workflowID ?? undefined,
        triggerConfig,
        payloadTemplate,
      };
      let actionResult: SystemActionResult | undefined;
      if (entry?.ownSteps) {
        // WI-1416 (bg-host-freeze-eventloop-stall P-006): a multi-step action (git-sync)
        // runs at the WORKFLOW layer so its internal DBOS.runStep sub-steps each record
        // an operation_output — the executor reaper sees genuine progress (function_id
        // > 0) instead of one opaque long step, and a crashed/reaped fire resumes from
        // its last checkpoint instead of redoing the whole action. (Wrapped in the
        // single step below, DBOS.runStep silently degrades to a plain call — isInStep()
        // → direct execution, no checkpoint — which was exactly the WI-1415 stall.)
        // Same last_error bookkeeping as the single-step path, each half its own step
        // so a replay never re-runs the SQL.
        const { sql } = getOrgPg();
        try {
          actionResult = (await entry.fn(systemActionCtx)) ?? undefined;
          if (actionResult?.replayAbandoned) {
            // WI-10004472: this recovery replay could not reproduce the step sequence
            // the original execution recorded. ANY further DBOS operation (the settle
            // step below, clear-reaper-last-error, a durable spawn) would land on a
            // function id recorded under a different name and fail the workflow with
            // DBOSUnexpectedStepError. End the fire here; the next tick redoes it.
            console.warn(
              `[routines] system:${action} (routine ${routineId}) recovery replay ABANDONED ` +
                `(${actionResult.replayAbandoned.reason}) — ending the fire without further steps`,
            );
            return;
          }
          const softError = actionResult?.softError;
          await DBOS.runStep(
            async () => {
              // WI-10005164: same step name and count either way, so replay is unchanged.
              if (softError) await recordRunnerLastError(sql, routineId, softError);
              else
                await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source',
                       updated_at = now()
                 WHERE id = ${routineId} AND metadata->>'last_error_source' = 'runner'`.catch(() => {});
            },
            { name: `system:${action}:settle` },
          );
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 600);
          await DBOS.runStep(
            async () => {
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('last_error', ${msg}::text, 'last_error_at', now()::text, 'last_error_source', 'runner'),
                       updated_at = now()
                 WHERE id = ${routineId}`.catch(() => {});
            },
            { name: `system:${action}:settle` },
          );
          throw e;
        }
      } else {
        actionResult = await DBOS.runStep(
          async (): Promise<SystemActionResult | undefined> => {
            const fn = getSystemAction(action);
            if (!fn) {
              console.warn(`[routines] no handler registered for system:${action} (routine ${routineId}) — skipping`);
              return undefined;
            }
            // Record a throw in `routines.metadata.last_error` so a silently-wedged
            // system action is visible (the improvement-watchdog's `routine-failure`
            // collector reads exactly this key — before, only git-sync wrote it).
            // Tagged `last_error_source:'runner'` so the success-path clear never
            // wipes an error an action manages ITSELF (git-sync records its own).
            const { sql } = getOrgPg();
            try {
              const result = await fn(systemActionCtx);
              // WI-10005164: a fail-soft sub-pass failure is recorded, not cleared.
              if (result?.softError) await recordRunnerLastError(sql, routineId, result.softError);
              else
                await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source',
                       updated_at = now()
                 WHERE id = ${routineId} AND metadata->>'last_error_source' = 'runner'`.catch(() => {});
              // Carry the action's durable-spawn requests out of the step so the
              // workflow layer can start them (EI-403-A) — a child workflow cannot
              // start from inside this step. Checkpointed return ⇒ replay-safe.
              return result ?? undefined;
            } catch (e) {
              const msg = (e instanceof Error ? e.message : String(e)).slice(0, 600);
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('last_error', ${msg}::text, 'last_error_at', now()::text, 'last_error_source', 'runner'),
                       updated_at = now()
                 WHERE id = ${routineId}`.catch(() => {});
              throw e;
            }
          },
          { name: `system:${action}`, retriesAllowed: true, maxAttempts: 2, intervalSeconds: 15 },
        );
      }

      // EI-403-A: start any durable child fires the action requested, AT THE
      // WORKFLOW LAYER (we are back in routineFireImpl's body, NOT inside a step —
      // `startWorkflow` is legal here). Dynamic import mirrors launch-blueprint.ts,
      // keeping durable-spawn's workflow registration off the import path when DBOS
      // is inactive. Recovery-safe: `actionResult` is the step's checkpointed
      // return, so a replay re-drains the same requests and the stable per-request
      // idempotency keys dedup the re-fire.
      if (actionResult?.durableSpawns?.length) {
        const { startDurableSpawns } = await import('./durable-spawn');
        const { enqueued, total } = await startDurableSpawns(actionResult.durableSpawns);
        console.log(
          `[routines] system:${action} (routine ${routineId}) → ${enqueued}/${total} durable spawn(s) enqueued at the workflow layer`,
        );
      }
    } else {
      // Agent-role routine: kick off the role for this harness via the invoke route
      // (the same autonomous launch path the git-sync merge-resolver spawn uses).
      // Fire-and-forget — the agent runs detached and the next due tick re-fires;
      // this matches the routine cadence model.
      await DBOS.runStep(
        async () => {
          // P-009 (D-009): the error-backoff fire gate + outcome recording — a
          // repeatedly-failing role fire backs off exponentially instead of
          // re-firing at full cadence (circuit-open ⇒ ~one probe per cap window).
          const gate = await checkFireGate(installSlug, targetRole);
          if (!gate.allow) {
            console.warn(
              `[routines] ${installSlug}/${targetRole} fire WITHHELD (${gate.reason}, ` +
                `consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`,
            );
            return;
          }
          const kickoff =
            typeof payloadTemplate?.kickoff === 'string'
              ? payloadTemplate.kickoff
              : `Scheduled routine '${routineId}' (role ${targetRole}).`;
          const ws = encodeURIComponent(workspaceId);
          const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(targetRole)}&ws=${ws}`;
          void recordFire(installSlug, targetRole, 'firing', 'attempt').catch(() => {});
          void loopbackFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kickoff }),
          })
            .then(
              (r) =>
                recordFire(installSlug, targetRole, r.ok ? 'ok' : `error: HTTP ${r.status}`, r.ok ? 'ok' : 'error'),
              (e) => {
                const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
                console.warn(`[routines] role spawn failed (${installSlug}/${targetRole}): ${detail}`);
                return recordFire(installSlug, targetRole, `error: ${detail}`, 'error');
              },
            )
            .catch(() => {});
        },
        { name: `spawn:${targetRole}` },
      );
    }

    // A completed dispatch (loop:wake / system:<action> / spawn:<role>) produced DBOS
    // operation output, which DISPROVES any prior reaper verdict of "produced no DBOS
    // operation output" for THIS routine. Clear a stale reaper-sourced last_error so the
    // improvement-watchdog's routine-failure collector stops re-filing "routine is
    // failing" bugs for a routine that has already self-healed (EI-5938 + 25+ phantom
    // routines: loop-su-* + system routines leaked the reaper marker forever — the loop
    // branch returned before any metadata clear, and the system success-clear was scoped
    // to last_error_source='runner'). Source-scoped in the helper, so a runner-sourced
    // action error and git-sync's own no-source error are preserved, and a genuinely
    // wedged routine (fire keeps getting reaped, never completing this step) still
    // surfaces. Rides its own durable step so a mid-fire crash replays it; fail-soft.
    await DBOS.runStep(
      async () => {
        const { sql } = getOrgPg();
        await clearStaleReaperLastError(sql, routineId);
      },
      { name: 'clear-reaper-last-error' },
    );
  });
}

export const routineFireWorkflow = idempotentRegisterWorkflow(ROUTINE_FIRE_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(routineFireImpl, {
    name: ROUTINE_FIRE_WORKFLOW_NAME,
    maxRecoveryAttempts: 5,
  }),
);

/**
 * Re-arm parked loop routines even during a critical PG-pool shed. A pure loop is parked at
 * `next_fire_at = infinity` while its turn runs; skipping this pass strands it until the next
 * non-shed tick (the 20–70 minute gaps measured in EI-21859486764076047).
 */
/**
 * WI-10005164: record a system action's fail-soft `softError` as the routine's
 * runner-sourced `last_error` (the same keys a throw writes), so the next clean
 * fire's source-scoped clear removes it. Best-effort, like the other writes here.
 */
async function recordRunnerLastError(
  sql: ReturnType<typeof getOrgPg>['sql'],
  routineId: string,
  softError: string,
): Promise<void> {
  const msg = softError.slice(0, 600);
  await sql`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('last_error', ${msg}::text, 'last_error_at', now()::text, 'last_error_source', 'runner'),
           updated_at = now()
     WHERE id = ${routineId}`.catch(() => {});
}

async function runLoopRebaseSweep(sql: ReturnType<typeof getOrgPg>['sql']): Promise<void> {
  await DBOS.runStep(
    async () => {
      try {
        const { reconcileLoopRoutines } = await import('../harness/routines/reconcile-loop-routines');
        const loop = await reconcileLoopRoutines({ sql });
        if (loop.terminated.length > 0) {
          console.warn(
            `[loop-reconcile] terminated ${loop.terminated.length} dead-owner loop(s) this pass: ${loop.terminated
              .map((t) => `${t.id} (owner ${t.targetOwnerId})`)
              .join(', ')}`,
          );
        }
      } catch (e) {
        console.warn(`[loop-reconcile] rebase pass failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'loop-rebase-sweep' },
  );
}

/** The scheduled tick: list due routines, claim + enqueue feedback-paced deduped fires. */
async function routinesTickImpl(): Promise<void> {
  // WI-3351: routinesTick is the LIGHTWEIGHT scheduler. Heavy periodic jobs
  // shed in tick-load-shed.ts, and routine bodies can self-gate; shedding this
  // root tick on loop pressure strands every due routine until the loop monitor
  // returns to ok. Keep the hook explicit so future policy changes are tested,
  // but the current policy never sheds on event-loop pressure.
  if (shouldShedSchedulerTickUnderLoopPressure()) {
    console.warn(`[routines-tick] SKIPPED — event loop pressure, shedding scheduler tick`);
    return;
  }
  // P-006/W4 (D-002/D-003): shed heavy sweeps when the shared org pool's probe
  // classifies critical. Its acquire+SELECT1 wall time also includes query execution,
  // transport and JS scheduling. The live p99 discount is a heuristic; neither the
  // raw nor adjusted duration isolates connection acquisition or proves starvation.
  // Retain both values in the warning so later attribution can inspect the evidence.
  // Fail-soft: poolPressure() returns 'ok' on any probe error (never shed on no signal).
  //
  // EI-11171 CRITICAL-ROUTINE FLOOR: a critical shed no longer goes fully dark. The original
  // bare `return` here skipped the ENTIRE fire loop below — including git-sync, which is fired
  // into the protected ROUTINES_CRITICAL_QUEUE precisely so it can NEVER be starved (its
  // starvation froze every commit + deploy for 7h on 2026-06-23). Shedding it too silently
  // re-armed that exact incident class. Instead we set `poolCritical` and fall through to a
  // MINIMAL pass: fire ONLY critical-queue routines (shouldFireUnderPoolShed), then return
  // before the heavy sweeps. Non-critical fires and heavy sweeps remain shed;
  // the liveness-critical loop-rebase pass below also survives the shed.
  const pool = await poolPressure();
  const poolProbeMs = lastPoolProbeMs();
  const poolCritical = pool === 'critical';
  if (poolCritical) {
    const shedCount = recordPoolShed();
    const probeRawMs = lastPoolProbeRawMs();
    const loopP99DiscountMs = lastPoolProbeLoopDelayMs();
    console.warn(
      `[routines-tick] slow pool probe — shedding heavy sweeps; still firing CRITICAL-queue routines only (git-sync floor, EI-11171/P-006/W4); pool-shed #${shedCount}`,
      {
        probeRawMs,
        probeNetMs: Math.max(0, probeRawMs - loopP99DiscountMs),
        // The timeout floor can make the classified value exceed the net duration.
        probeAdmissionMs: poolProbeMs,
        loopP99DiscountMs,
        criticalProbeMs: CRITICAL_PROBE_MS,
        shedCount,
      },
    );
    // EI-13108 ask (2): durably record the shed (fire-and-forget — never await on an
    // already-starved pool) so instrument-staleness consumers can distinguish
    // "shed by this guardrail" from "dead" (migration 627).
    recordPoolShedEvent(activeWorkspaceId(), shedCount);
  }
  const { sql } = getOrgPg();

  // EI-9935: overlap guard. Confirmed live (2026-07-12 00:15-00:30 EDT): under
  // host/PG contention individual ticks ballooned from ~15-20s to 58-93s, and
  // — because nothing stopped a new tick from starting mid-flight — multiple
  // ticks ran CONCURRENTLY, each independently walking this same serial
  // PG-touching sweep chain and compounding the contention that slowed the
  // first one. That pile-up starved due routines (armed su loop wakes) past
  // the infra-liveness dead-routines >10m threshold. The pool-pressure policy
  // above gates heavy work at that instant; it doesn't stop a SECOND tick once a first is
  // already past that gate and simply running long — this closes that gap
  // directly. Fail-soft + stale-safe (see routine-tick-overlap-guard.ts).
  if (
    !poolCritical &&
    (await anotherRoutinesTickInFlight(DBOS.workflowID ?? '', {
      queryInFlight: (selfId, cutoffEpochMs) =>
        sql.begin(async (tx) => {
          // The overlap probe is a read-only guard, not routine work. Keep its
          // server-side statement budget below the caller deadline so a
          // checked-out connection cannot remain occupied after the guard has
          // already fail-softed.
          await tx.unsafe(`SET LOCAL statement_timeout = ${ROUTINE_TICK_OVERLAP_STATEMENT_TIMEOUT_MS}`);
          return tx<{ workflow_uuid: string }[]>`
            SELECT workflow_uuid FROM dbos.workflow_status
             WHERE name = 'routinesTick'
               AND status = 'PENDING'
               AND workflow_uuid <> ${selfId}
               AND started_at_epoch_ms IS NOT NULL
               AND started_at_epoch_ms > ${cutoffEpochMs}
             LIMIT 1`;
        }),
    }))
  ) {
    console.warn(`[routines-tick] SKIPPED — another routinesTick invocation already in flight (EI-9935 overlap guard)`);
    return;
  }

  const due = await DBOS.runStep(() => listDueCronRoutines(sql), { name: 'list-due-routines' });
  // routineFire workflow fan-out — one prior-cohort health epoch reads indexed
  // DBOS in-flight rows before claim/start, then the loop spends only its credit.
  const dispatchEpoch = await DBOS.runStep(
    async () =>
      evaluateRoutineDispatchEpoch({
        pressure: pool,
        probeMs: poolProbeMs,
        inFlightByQueue: await readRoutineFireInFlightByQueue(sql),
        activeQueues: due.map((routine) => queueForRoutine(routine.targetRole, routine.installSlug)),
        atMs: Date.now(),
      }),
    { name: 'routine-dispatch-feedback-epoch' },
  );
  const queueAdmission = new Map(dispatchEpoch.queues.map((item) => [item.queueName, item]));
  const remainingStartsByQueue = new Map(dispatchEpoch.queues.map((item) => [item.queueName, item.availableStarts]));
  const loggedWithheldQueues = new Set<string>();
  const dueByAge = orderDueRoutinesByAge(due);
  for (const r of dueByAge) {
    // EI-11171 critical-routine floor: under a pool-starvation shed, fire ONLY the protected
    // critical-queue routines (git-sync); everything else sheds with the heavy sweeps below.
    if (poolCritical && !shouldFireUnderPoolShed(r.targetRole)) continue;
    const queueName = queueForRoutine(r.targetRole, r.installSlug);
    // EI-224330 stage 2: admission is checked BEFORE claim, from the epoch's
    // previous-cohort feedback and actual durable occupancy. A withheld row has
    // not advanced next_fire_at, so it remains due for the next feedback epoch.
    const remainingStarts = remainingStartsByQueue.get(queueName) ?? 0;
    if (remainingStarts <= 0) {
      const admission = queueAdmission.get(queueName);
      if (!loggedWithheldQueues.has(queueName)) {
        loggedWithheldQueues.add(queueName);
        console.warn(
          `[routines-tick] HELD ${queueName} dispatch — feedback epoch has ` +
            `window=${admission?.effectiveWindow ?? 0}, inFlight=${admission?.inFlight ?? 0}, ` +
            `available=0, pool=${dispatchEpoch.pressure} (${dispatchEpoch.probeMs}ms); ` +
            `unclaimed routines remain due for the next epoch (EI-224330)`,
        );
      }
      continue;
    }

    const claimed = await DBOS.runStep(() => claimDueRoutine(sql, r), { name: 'claim-routine' });
    if (!claimed) {
      // WI-40883: a bare `continue` here is what let 11 routines sit unclaimable and silent —
      // one of them green-checkpoint for three pots, dark ~36h. Losing a claim IS normal (two
      // executors race every tick and one must lose quietly), so the classifier stays silent
      // unless the row has been due far longer than any race could explain. Fail-soft and not
      // awaited: an instrument on the fire hot path must never delay or break dispatch.
      // WI-10005062: this instrument threw (a non-Date lastFiredAt) and, unguarded, aborted
      // the whole tick — every later due routine went undispatched. It must stay fail-soft.
      try {
        const verdict = classifyClaimSkip(
          {
            id: r.id,
            name: r.name,
            installSlug: r.installSlug,
            nextFireAt: r.nextFireAt ?? null,
            lastFiredAt: r.lastFiredAt ?? null,
          },
          Date.now(),
        );
        if (verdict.state === 'unclaimable') {
          console.warn(`[routines-tick] UNCLAIMABLE ROUTINE — ${verdict.reason}`);
          void recordUnclaimableRoutine(sql, r.id, verdict);
        }
      } catch (e) {
        console.warn(`[routines-tick] claim-skip classifier failed for '${r.name}' (non-fatal): ${String(e)}`);
      }
      continue;
    }
    void clearUnclaimableRoutine(sql, r.id);
    try {
      await DBOS.startWorkflow(routineFireWorkflow, {
        // Queue classification isolates both must-never-starve persistence work (git-sync)
        // and deadline-sensitive loop wakes; long/unknown work stays on the shared lane.
        queueName,
        enqueueOptions: { deduplicationID: `routine:${r.id}` },
        // A fire PENDING on a DEAD executor holds this dedup ID forever (DBOS
        // recovery is per-executor), silently collapsing every later fire while
        // claimDueRoutine keeps bumping last_fired_at — the routine looks alive
        // but never runs (gym-cycle wedged 7.5h on a dead repro host,
        // 2026-06-12). The timeout is the release valve: DBOS cancels the
        // workflow at the deadline, freeing the dedup. Ceiling sized above the
        // longest legitimate in-process action (a real gym cycle, ≲90 min).
        timeoutMS: routineFireTimeoutMs(r.targetRole),
      })(
        r.id,
        r.workspaceId,
        r.installSlug,
        r.targetRole,
        r.triggerConfig,
        r.payloadTemplate ?? null,
        // B-LOOP-3: the loop fields (su-d5a84's B-LOOP-1 RoutineRow seam) route the fire to
        // the warm-wake branch when present.
        r.name,
        r.rescheduleIntervalSec ?? null,
        r.targetOwnerId ?? null,
      );
      remainingStartsByQueue.set(queueName, remainingStarts - 1);
    } catch (e) {
      // Already enqueued/active for this routine — collapse (back-pressure).
      if (!/Duplicat/i.test(String(e))) throw e;
    }
  }

  // EI-11171 critical-routine floor (cont.): heavy sweeps stay shed, but loop completion-rebase
  // is liveness-critical and MUST still run. Otherwise pure loops remain parked at infinity
  // until a non-shed tick, producing the 20–70 minute cadence gaps in EI-21859486764076047.
  if (poolCritical) {
    await runLoopRebaseSweep(sql);
    return;
  }

  // Loop completion-rebase (B-LOOP-2) — its OWN step, FIRST after the fire loop
  // (Task-#8 / su-cold-auto 2026-07-03): a loop fire parks at next_fire_at='infinity'
  // and stays parked until this rebase re-arms it, so the rebase is as
  // liveness-critical as the fires themselves. It used to ride at the TAIL of
  // reconcileAndGovern (position #10 of 11 serial sweeps below) — under pool
  // starvation the earlier sweeps starved it and armed loops sat parked ~17 min
  // between 60s wakes while fires for other routines kept flowing. Placing it
  // here bounds its delay to the fire loop only. Fail-soft: a rebase failure
  // must never block the watchdog sweeps below.
  await runLoopRebaseSweep(sql);

  // An accepted program receipt is durable launch intent. The normal submit
  // path returns after admission; this bounded scan starts roots whose DBOS
  // workflow was never recorded (including a lost launch response). DBOS owns
  // execution recovery once its workflow row exists. Keep the scan distinct
  // from routine claims so the canonical work item remains the only result.
  try {
    const { findUnstartedAcceptedCoordPrograms, startCoordProgram } =
      await import('./coord-program-workflow');
    const unstarted = await DBOS.runStep(
      () => findUnstartedAcceptedCoordPrograms(sql, 16),
      { name: 'accepted-coord-program-launch-scan' },
    );
    for (const input of unstarted) {
      try {
        await startCoordProgram(input);
      } catch (error) {
        // Two ticks can read the same receipt before either enqueue commits.
        // The stable workflow ID makes that race a harmless duplicate.
        if (/Duplicat/i.test(String(error))) continue;
        console.warn(`[coord-program] accepted root launch failed for receipt ${input.acceptedOperation?.receiptId}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.warn(`[coord-program] accepted root launch scan failed: ${error instanceof Error ? error.message : error}`);
  }

  // EI-19408412473830336: auto-resolve leg for the loop-death / loop-lifecycle-death
  // watchdog escalations opened above (via reconcileLoopRoutines's terminateDeadLoop /
  // classifyLoopLifecycleTurn paths) — see reconcile-loop-routines.ts's module-header
  // note on both reconcile*Escalations functions for why these were previously
  // structurally immortal (48 open rows, nothing could ever close them). Its own
  // step, riding right after the rebase sweep it complements; fail-soft (never blocks
  // the watchdog sweeps below).
  await DBOS.runStep(
    async () => {
      try {
        const { reconcileDeadLoopEscalations, reconcileLoopLifecycleDeathEscalations } =
          await import('../harness/routines/reconcile-loop-routines');
        const [deadLoop, lifecycleDeath] = await Promise.all([
          reconcileDeadLoopEscalations({ sql }),
          reconcileLoopLifecycleDeathEscalations({ sql }),
        ]);
        if (deadLoop.resolved > 0 || lifecycleDeath.resolved > 0) {
          console.warn(
            `[loop-watchdog-escalation-reconcile] auto-resolved ${deadLoop.resolved} loop-death + ` +
              `${lifecycleDeath.resolved} loop-lifecycle-death escalation(s) this pass`,
          );
        }
      } catch (e) {
        console.warn(`[loop-watchdog-escalation-reconcile] pass failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'loop-watchdog-escalation-reconcile' },
  );

  // start-hive-wake-orchestration P-011 / D-003: the hive liveness sweep — a
  // deterministic, zero-token dead-man's-switch check riding this existing 30s
  // tick (NOT a cadence: the wake it may arm is the exception path). Started +
  // demand + no wake armed + not mid-turn + stale → arm the fallback sleep.
  // Fail-soft inside the module; one durable step so a crash mid-sweep resumes.
  await DBOS.runStep(
    async () => {
      const { potWatchdogSweep } = await import('../pot/watchdog');
      const results = await potWatchdogSweep();
      for (const res of results) {
        if (res.outcome === 'armed' || res.outcome === 'staged') {
          console.warn(`[hive-watchdog] tick ${res.outcome} a fallback wake: ${res.reason}`);
        }
      }
    },
    { name: 'pot-watchdog-sweep' },
  );

  // autonomous-loop-canary-reliability-2026-06-29 P-003: the PAUSED-hive recovery
  // sweep. The started-only seam above skips a paused hive, so a hive PAUSED while
  // work is queued was a SILENT outage (the daily canary went unfulfilled for days
  // with no alert and no recovery). This sweep alerts the owner and (unless
  // disabled via PAPERCUSP_POT_PAUSED_AUTO_RESUME=off) auto-resumes a hive paused
  // past the stale threshold WITH demand. Kill switch: PAPERCUSP_POT_PAUSED_
  // RECOVERY_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { pausedPotRecoverySweep } = await import('../pot/watchdog');
      const results = await pausedPotRecoverySweep();
      for (const res of results) {
        if (res.outcome === 'resumed' || res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[hive-watchdog] paused-recovery ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
    },
    { name: 'pot-paused-recovery-sweep' },
  );

  // gate-verdict-liveness-and-repair-reliability-2026-08-31 P-004: the RELEASE-GROUP
  // PAUSE-TTL sweep — the same "a deliberate hold must not become a silent outage"
  // shape as the paused-hive recovery directly above, one layer down at the routine
  // row. A release-group pause (green-checkpoint especially) now carries a finite
  // expiry; this re-arms it the tick after that expiry passes and records a notice.
  // Measured motivation: green-checkpoint sat deliberately paused 99h across 14
  // windows (37% of an 11-day red streak), two of them >21h, with nothing to end
  // them. Bounded (~12 release rows, one guarded UPDATE each) and fail-soft inside
  // the module, so it can never delay or break the fires above.
  await DBOS.runStep(
    async () => {
      const { sweepExpiredReleasePauses } = await import('../harness/routines/release-pause-ttl');
      await sweepExpiredReleasePauses(sql);
    },
    { name: 'release-pause-ttl-sweep' },
  );

  // EI-22138154596110669: the SAME "a deliberate pause must carry a finite expiry"
  // sweep, one section down, for `loop:standdown-all`'s fleet-wide engine-loop
  // stand-down pauses (marker-gated in SQL — see release-pause-ttl.ts's LOOP
  // STAND-DOWN section header for why an ordinary loop:end pause must never be
  // swept here). Bounded + fail-soft inside the module, same as the sweep above.
  await DBOS.runStep(
    async () => {
      const { sweepExpiredLoopStanddowns } = await import('../harness/routines/release-pause-ttl');
      await sweepExpiredLoopStanddowns(sql);
    },
    { name: 'loop-standdown-ttl-sweep' },
  );

  // overwatch-role-2026-06-15 B-09 / D-004: the OVERWATCH liveness sweep — the
  // who-watches-the-watcher backstop, the same deterministic dead-man's switch as
  // the hive sweep above but for the overwatch supervisor's own wake channel. It
  // self-gates on the `papercusp-overwatch` flag + B-07's started bit
  // (`listGuardedOverwatches` is empty when off ⇒ inert), so this is a near-free
  // no-op until the role is activated. Fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { overwatchWatchdogSweep } = await import('../overwatch/watchdog');
      const results = await overwatchWatchdogSweep();
      for (const res of results) {
        if (res.outcome === 'armed') {
          console.warn(`[overwatch-watchdog] tick armed a fallback wake: ${res.reason}`);
        } else if (res.outcome === 'error') {
          // WI-3777: a per-item sweep failure used to be swallowed silently
          // (only the OUTER catch's generic "sweep failed" warned, with no
          // per-hive detail) — surface it at error level so a starved guarded
          // overwatch is visible in logs instead of just going quiet forever.
          console.error(`[overwatch-watchdog] tick sweep item errored: ${res.reason}`);
        }
      }
    },
    { name: 'overwatch-watchdog-sweep' },
  );

  // queen-autonomous-execution-2026-06-13 B-09 (P-020/P-021/P-022): the placement
  // COMPLETION watchdog — the liveness watchdog above keeps the QUEEN awake; this
  // guarantees every unit she PLACED reaches terminal. Same deterministic dead-
  // man's-switch shape (a recovery wake / cursed-item or stranded-blocker
  // escalation is the exception path, not a cadence). Runs before the throughput
  // tick so its placement-state is fresh for the metrics. Fail-soft inside the
  // module; one durable step so a crash mid-sweep resumes.
  await DBOS.runStep(
    async () => {
      const { reconcilePotPlacements } = await import('../pot/placement-watchdog');
      const results = await reconcilePotPlacements();
      for (const res of results) {
        if (res.decision === 'recover' || res.decision === 'breaker' || res.decision === 'stranded') {
          console.warn(
            `[hive-placement-watchdog] tick ${res.decision} ${res.workItemId}` +
              `${res.detail ? ` (${res.detail})` : ''}`,
          );
        }
      }
    },
    { name: 'pot-placement-watchdog-sweep' },
  );

  // queen-scout-feedback-loop-2026-06-20 D-003 #2 (hardening): the scout-draft REVIEW
  // backstop. The Scout produces drafts on a friction-OR-idle cadence but pings the
  // Queen with a NO-WAKE durable message, so review only happens on an IDLE wake — and
  // a saturated hive (Queen never idle) starves scout-routed drafts (neither ratified
  // nor deprecated). This sweep finds drafts unreviewed past a deadline and fires ONE
  // debounced WAKE to the live Queen, moving review onto the FRICTION path. It NEVER
  // ratifies/deprecates (the Queen still disposes). Same deterministic dead-man's-switch
  // shape (the wake is the exception path). Default-safe; kill switch:
  // PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { scoutDraftReviewSweep } = await import('../scout/draft-review-watchdog');
      const results = await scoutDraftReviewSweep();
      for (const res of results) {
        if (res.outcome === 'nudged' || res.outcome === 'error') {
          console.warn(`[scout-draft-review] ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
      const coverage = summarizeBlenderSweepCoverage(results);
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        errorCount: results.filter((res) => res.outcome === 'error').length,
        nudgedCount: results.filter((res) => res.outcome === 'nudged').length,
        ...coverage,
        results: results.slice(0, 25),
      };
    },
    { name: 'scout-draft-review-sweep' },
  );

  // su-ideate-learning-substrate-2026-07-10 P-006: the ungraded su-filings GRADING
  // backstop — the scout-draft-review sweep's sibling, aimed at the routed-idea
  // ledger instead of draft plans. su-originated filings (origin='su-ideate') only
  // teach the learning substrate once GRADED (blender:grade-idea), but nothing made
  // grading happen; this sweep finds filings ungraded past a deadline (default 7d)
  // and fires ONE debounced nudge to the live Mug (event-key wake + durable
  // @role:mug park). It never grades anything itself. D-013: epoch floor + batch
  // cap keep the backfilled corpus out of triage. Default-safe; kill switch:
  // PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { ungradedFilingsConfig, ungradedFilingsSweep } = await import('../scout/ungraded-filings-watchdog');
      const config = ungradedFilingsConfig();
      const results = await ungradedFilingsSweep();
      for (const res of results) {
        if (res.outcome === 'nudged' || res.outcome === 'error') {
          console.warn(`[ungraded-filings] ${res.outcome}: ${res.installSlug}/${res.origin} — ${res.reason}`);
        }
      }
      // DBOS persists runStep return values in operation_outputs. Returning a
      // compact semantic summary gives watchdog:status one authoritative record
      // of internal fail-soft errors; `void` previously made a swallowed sweep
      // failure look identical to a healthy empty run.
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        errorCount: results.filter((res) => res.outcome === 'error').length,
        nudgedCount: results.filter((res) => res.outcome === 'nudged').length,
        ...summarizeBlenderSweepCoverage(results),
        config,
        results: results.slice(0, 25),
      };
    },
    { name: 'su-ideate-ungraded-sweep' },
  );

  // WI-1574 (2026-07-02): the ready-plan AUTOSTART sweep — the missing CONSUMER of
  // the review loop's `ready` terminal. The Queen ratified scout drafts to 'ready'
  // and the chain stopped: nothing ran plans:start, so promotePlanItems never ran,
  // so ZERO work_items ever sourced from a scout plan (the plan rail was a dead
  // end — all 6 routes pending since 06-11). This sweep auto-starts ratified
  // (ready, never-started) scout plans in the hive's OWN workspace (plans:start's
  // UPDATE is pinned to the default workspace and misses scout rows) and promotes
  // their items into the Queen's surveyable frontier; a ratified-but-ITEMLESS plan
  // gets a debounced decompose-wake instead. Fail-soft; kill switch:
  // PAPERCUSP_SCOUT_READY_AUTOSTART=0.
  await DBOS.runStep(
    async () => {
      const { scoutReadyAutostartSweep } = await import('../scout/ready-plan-autostart');
      const results = await scoutReadyAutostartSweep();
      for (const res of results) {
        if (res.outcome !== 'skipped') {
          console.warn(
            `[scout-ready-autostart] ${res.outcome}: ${res.installSlug}${res.planSlug ? ` ${res.planSlug}` : ''} — ${res.reason}`,
          );
        }
      }
    },
    { name: 'scout-ready-autostart-sweep' },
  );

  // autonomous-loop-prod-audit-2026-07-02 P-006 (SPOF 5a/5b, deferred from
  // WI-4626/AUDIT B): the Scout OUTCOME-REFRESH sweep — refreshScoutOutcomes
  // previously ran ONLY inside a Scout cycle (scout/scheduler.ts
  // refreshOutcomes()), so an idle/backed-off/dead Scout froze every routed
  // idea's cached outcome and silently stalled the per-lens weight learning.
  // This sweep decouples the refresh from Scout's own cadence (its own
  // in-process throttle, default 15min) and separately alerts (debounced via
  // the shared hive_watchdog_fires ledger) when routed ideas sit
  // outcome NULL/'pending' past a staleness threshold even after a refresh —
  // the "stuck forever, nobody noticed" failure class. Fail-soft; kill
  // switches: PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC<=0 (whole sweep),
  // PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC<=0 (alert only).
  await DBOS.runStep(
    async () => {
      const { scoutOutcomeRefreshSweep } = await import('../scout/outcome-refresh-sweep');
      const results = await scoutOutcomeRefreshSweep();
      for (const res of results) {
        if (res.outcome === 'error' || res.alerted) {
          console.warn(`[scout-outcome-refresh] ${res.outcome}: ${res.workspaceId} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        errorCount: results.filter((res) => res.outcome === 'error').length,
        alertedCount: results.filter((res) => res.alerted).length,
        ...summarizeBlenderSweepCoverage(results),
        results: results.slice(0, 25),
      };
    },
    { name: 'scout-outcome-refresh-sweep' },
  );

  // WI-1623: the release-deploy STALENESS recurrence guard. The green pin can sit
  // deployable-but-not-live far past the documented ≤15-min auto-deploy cadence with
  // NOTHING catching it (confirmed live: a stuck `deployedAt` display field went
  // unnoticed for ~a month even though the gate/pin were otherwise healthy — see the
  // work-item + release-deploy-staleness-watchdog.ts's header for the full root
  // cause). This sweep alerts (debounced, via the shared hive_watchdog_fires ledger)
  // whenever the green pin has been deployable-but-not-live longer than the
  // threshold. Never ships/restarts anything itself — alert only. Fail-soft;
  // kill switch: PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0.
  // EI-16537: it also PAGES now — urgent owner notifyAttention + a fleet severe-event
  // broadcast + a durable harness_escalations row, one-shot until recovery. The warn
  // below is only a local trace; it was for months the alert's ONLY destination, which
  // is how 96h of unshipped owner-facing code went unnoticed with the sweep firing
  // correctly the whole time.
  await DBOS.runStep(
    async () => {
      const { releaseDeployStalenessSweep } = await import('../release-deploy-staleness-watchdog');
      const result = await releaseDeployStalenessSweep({});
      if (result.outcome === 'alerted' || result.outcome === 'error') {
        console.warn(`[release-deploy-staleness] ${result.outcome}: ${result.reason}`);
      }
    },
    { name: 'release-deploy-staleness-sweep' },
  );

  // EI-19409061552037718: the STALE-ROUTINE-EXECUTOR watchdog — this process's own
  // boot-commit-vs-tree-HEAD drift, judged only against ITSELF (no cross-process
  // coordination, no change to claiming/dispatch above). Silently disabled unless
  // THIS process carries PAPERCUSP_DBOS_ROUTINES=1, so it is a complete no-op on every
  // host that doesn't need it. Fail-soft; kill switch
  // PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC<=0.
  //
  // ⚠ WI-1565914 — this comment used to claim ":3070 always does". It does NOT, and that
  // false reassurance is a large part of why the gap below went unnoticed for weeks:
  // anyone auditing "is the host serving agent calls covered?" read this line and
  // concluded yes. MEASURED 2026-08-31: all six :3070 listeners (pids 1612877, 236800,
  // 236826, 236843, 236850, 236858) have PAPERCUSP_DBOS_ROUTINES *unset*; only :3270 and
  // :3271 carry =1. So :3070 has never once evaluated its own staleness, while :3271
  // truthfully reported "RECOVERED" 106 times — an all-clear over a population that never
  // included the host anybody cared about. The ledger-derived sweep immediately below is
  // what actually covers :3070; do not read this self-check as covering anything but the
  // process it runs in.
  await DBOS.runStep(
    async () => {
      try {
        const { staleRoutineExecutorSweep } = await import('../harness/routines/stale-routine-executor-watchdog');
        const result = await staleRoutineExecutorSweep({});
        if (result.outcome === 'alerted' || result.outcome === 'error') {
          console.warn(`[stale-routine-executor] ${result.outcome}: ${result.reason}`);
        }
      } catch (e) {
        console.warn(`[stale-routine-executor] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'stale-routine-executor-sweep' },
  );

  // WI-1565914: the STALE SERVING HOST sweep — the same question as the self-check above,
  // asked from OUTSIDE every host. It reads `harness_shared.tool_invocations` (migration
  // 1043 stamps the serving host + the sha it loaded) and judges a host by the calls it
  // ACTUALLY SERVED, so it covers hosts that run no routines, and hosts whose code
  // predates the detector entirely — the two populations a self-check structurally cannot
  // reach. It also reports ABSOLUTE code age rather than hours-since-boot, which is the
  // only way an 18-day-old process is distinguishable from a 7-hour-old one.
  //
  // `inconclusive` is a first-class outcome and is deliberately NOT an alert: while hosts
  // have not yet restarted onto 1043 code the population is empty, and paging on a
  // measurement that measured nothing is how an all-clear earns undeserved credibility.
  // It is equally never logged as healthy. Fail-soft; kill switch
  // PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC<=0.
  await DBOS.runStep(
    async () => {
      try {
        const { hostCodeStalenessFromLedgerSweep } =
          await import('../harness/routines/host-code-staleness-from-ledger');
        const result = await hostCodeStalenessFromLedgerSweep({});
        if (result.outcome === 'alerted' || result.outcome === 'error' || result.outcome === 'inconclusive') {
          console.warn(`[stale-serving-host] ${result.outcome}: ${result.reason}`);
        }
      } catch (e) {
        console.warn(`[stale-serving-host] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'stale-serving-host-sweep' },
  );

  // EI-19457924854150358: the SYNC-READ PAYLOAD BUDGET watchdog — reads the
  // `syncReads.audit` snapshot the daily audit routine writes and pages on either
  // (a) a read over its byte ceiling, or (b) the audit having stopped producing at
  // all. Leg (b) is why this exists as a watchdog rather than a line in the audit:
  // an instrument that only reports when it CAN see goes quiet exactly when it
  // dies. One indexed SELECT per tick; reads the table directly rather than via
  // readDerivedSnapshot, which would kick a background 12-minute audit on a miss.
  // WARNS only, never blocks a deploy. Fail-soft; kill switch
  // PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC<=0.
  await DBOS.runStep(
    async () => {
      try {
        const { syncReadBudgetSweep } = await import('../harness/routines/sync-read-budget-watchdog');
        const result = await syncReadBudgetSweep({});
        if (result.outcome === 'alerted' || result.outcome === 'error') {
          console.warn(`[sync-read-budget] ${result.outcome}: ${result.reason}`);
        }
      } catch (e) {
        console.warn(`[sync-read-budget] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'sync-read-budget-sweep' },
  );

  // rubric-system-hardening-2026-07-14 P-004 (EI-12149): the RUBRIC-STALENESS
  // watchdog — an ACTIVE releaseGating rubric with no COMPLETE scorecard within
  // the threshold window (default 6h) fires one debounced pot_watchdog_fires row
  // + a coord escalation. The blender-release-readiness rubric went ~14h ungraded
  // when its grader loop died silently and nothing paged; a release bar nobody is
  // grading is a silent gate, not a green one. Fail-soft; kill switch:
  // PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC<=0. Returns the per-rubric outcomes
  // so watchdog:status has one authoritative record.
  await DBOS.runStep(
    async () => {
      const { rubricStalenessSweep } = await import('../rubric-staleness-watchdog');
      const results = await rubricStalenessSweep();
      for (const res of results) {
        if (res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[rubric-staleness] ${res.outcome}: ${res.rubricRef} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        alertedCount: results.filter((r) => r.outcome === 'alerted').length,
        errorCount: results.filter((r) => r.outcome === 'error').length,
        results: results.slice(0, 10),
      };
    },
    { name: 'rubric-staleness-sweep' },
  );

  // WI-38044: proposed rubrics now use an independent-reviewer ratification
  // gate; the retired Mug/Queen path is not a prerequisite. Alert when a
  // proposal outlives its review dwell window so valid standards cannot strand
  // indefinitely in `proposed`. Fail-soft; kill switch:
  // PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC<=0.
  await DBOS.runStep(
    async () => {
      const { rubricProposalDwellSweep } = await import('../rubric-staleness-watchdog');
      const results = await rubricProposalDwellSweep();
      for (const res of results) {
        if (res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[rubric-proposal-dwell] ${res.outcome}: ${res.rubricRef} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        alertedCount: results.filter((r) => r.outcome === 'alerted').length,
        errorCount: results.filter((r) => r.outcome === 'error').length,
        results: results.slice(0, 10),
      };
    },
    { name: 'rubric-proposal-dwell-sweep' },
  );

  // session-turn-storage-2026-07-28 P-007 (D-005): the TRANSCRIPT-INGEST lag
  // watchdog. Alerts when an adapter has on-disk bytes past its stored
  // byte_offset and has not consumed them for longer than the threshold —
  // SOURCE-RELATIVE, deliberately not a wall-clock lag threshold: codex read
  // 2d9h "behind" and omp 6d8h on 2026-07-28 while both were fully caught up
  // and simply unused, so a lag threshold would have paged twice for nothing.
  // Fail-soft; kill switch: PAPERCUSP_INGEST_LAG_THRESHOLD_SEC<=0.
  await DBOS.runStep(
    async () => {
      const { sessionIngestLagSweep } = await import('../search/session-ingest-lag-watchdog');
      const results = await sessionIngestLagSweep();
      for (const res of results) {
        if (res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[session-ingest-lag] ${res.outcome}: ${res.sourceKind} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        alertedCount: results.filter((r) => r.outcome === 'alerted').length,
        errorCount: results.filter((r) => r.outcome === 'error').length,
        results: results.slice(0, 10),
      };
    },
    { name: 'session-ingest-lag-sweep' },
  );

  // session-turn-storage-2026-07-28 D-008: the COMPLEMENT of the sweep above.
  // The lag sweep asks "is unconsumed work piling up?" and so is structurally
  // blind to the failure that actually happened — bg-host running a
  // module-cached build older than the tree, consuming every byte on schedule
  // while writing ZERO parts. behindFiles was 0, so the lag sweep read "fully
  // caught up" on every tick for ~7h. This one asks the complementary question:
  // did the adapter do work and produce nothing? It is the worse half, because
  // consumed bytes are NEVER re-read, so that loss is permanent rather than
  // merely deferred. Judges only adapters that implement parseParts (derived
  // from FILE_ADAPTERS) and only when turns > 0, so a quiet client stays silent.
  // Fail-soft; kill switch: PAPERCUSP_PARTS_WRITER_WINDOW_SEC<=0.
  await DBOS.runStep(
    async () => {
      const { sessionPartsWriterSweep } = await import('../search/session-ingest-lag-watchdog');
      const results = await sessionPartsWriterSweep();
      for (const res of results) {
        if (res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[session-parts-writer] ${res.outcome}: ${res.sourceKind} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        alertedCount: results.filter((r) => r.outcome === 'alerted').length,
        errorCount: results.filter((r) => r.outcome === 'error').length,
        results: results.slice(0, 10),
      };
    },
    { name: 'session-parts-writer-sweep' },
  );

  // hive-seed-bundle P-008 (D-007): the COLD-JOIN CANARY. Now that seeded installs
  // only carry the join DELTA (P-006/P-007), the full cold join (no seed, whole-
  // history transfer) stops being exercised on every install and can silently
  // bit-rot. This sweep forces a periodic REAL cold join (seed disabled) so the
  // cold path stays proven, and records/alerts pass-or-fail (debounced via the
  // shared hive_watchdog_fires ledger). DEFAULT DISABLED (a cold join is heavy) —
  // a canary/release env opts in via PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC. The
  // heavy executor (P-010 live-wire 3) is wired here: it resolves the registered
  // rig cold-join spawn at call time, so a non-rig host with the canary (deliberately)
  // enabled surfaces an honest 'error' alert instead of a fake pass. Fail-soft;
  // disabled ⇒ a complete no-op (the executor is never invoked below the interval gate).
  await DBOS.runStep(
    async () => {
      const { runColdJoinCanarySweep } = await import('../sync/hyperbee/cold-join-canary');
      const { defaultColdJoinExecutor } = await import('../sync/hyperbee/cold-join-executor');
      const result = await runColdJoinCanarySweep({ coldJoin: defaultColdJoinExecutor, log: (m) => console.warn(m) });
      if (result.outcome === 'failed' || result.outcome === 'error') {
        console.warn(`[cold-join-canary] ${result.outcome}: ${result.reason}`);
      }
    },
    { name: 'cold-join-canary-sweep' },
  );

  // queen-memory-hybrid-2026-07-02 L1b — agent_facts hygiene: hard-delete facts
  // expired/retracted >30d (bounded audit trail). Fail-soft like every sweep here.
  await DBOS.runStep(
    async () => {
      try {
        const { sweepExpiredFacts } = await import('../agent-facts/store');
        await sweepExpiredFacts();
      } catch (e) {
        console.warn(`[agent-facts] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'agent-facts-expiry-sweep' },
  );

  // owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): an
  // owner-gated WALL fact (facts:assert { slot:'wall' }) whose TTL expired
  // without being retracted pages LOUDLY instead of silently vanishing from
  // folds — TTL decay always fails toward "clear", the wrong direction for an
  // unremediated risk. Fail-soft like every sweep here; debounced per-fact
  // inside the sweep itself.
  await DBOS.runStep(
    async () => {
      try {
        const { wallLapseSweep } = await import('../wall-lapse-watchdog');
        const results = await wallLapseSweep();
        for (const r of results) {
          if (r.outcome === 'error') console.warn(`[wall-fact-lapse] error: ${r.key} — ${r.reason}`);
        }
      } catch (e) {
        console.warn(`[wall-fact-lapse] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'wall-fact-lapse-sweep' },
  );

  // bash-substitution-reachable-ceiling-2026-08-01 P-003: resolve `complied` on
  // substitution fires. It CANNOT be computed at fire time — compliance is "did
  // this session's next tool call use the named tool", and at fire time that call
  // has not happened — so it is necessarily a deferred sweep rather than a write
  // on the gate's own path.
  //
  // Fail-soft and bounded per tick, like every step here: this is telemetry for a
  // measurement programme, and a resolver that could stall the routines tick
  // would be a far worse outcome than a compliance number that lands a minute
  // late.
  await DBOS.runStep(
    async () => {
      try {
        const { resolveFireCompliance } = await import('../bash-substitution/fires');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const out = await resolveFireCompliance({ workspaceId: activeWorkspaceId() });
        // Logged only when it did something — this runs every tick and a silent
        // no-op is the normal case.
        if (out.measured > 0 || out.noFollowUp > 0) {
          console.info(
            `[substitution-compliance] examined ${out.examined}, ` +
              // `noFollowUp` is NOT a non-compliance count: it is sessions that
              // made no further call at all, recorded with `complied` NULL. Kept
              // separate in the log for the same reason it is separate in the
              // schema — collapsing it into `false` would report dead sessions
              // as defiant agents.
              `measured ${out.measured}, no-follow-up ${out.noFollowUp}`,
          );
        }
      } catch (e) {
        console.warn(`[substitution-compliance] resolve failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'substitution-compliance-resolve' },
  );

  // unified-agent-state-plane-2026-07-27 P-010: the intent↔action divergence
  // detector (MAST FM-2.6). D-016 puts it in the STRUCTURAL tier and D-047 row
  // 15 records its enforcement as "they run on their own" — so it is a sweep,
  // never a tool: D-046 refuses another pull read over `tool_invocations`
  // (three exist, all three dead). Notifies the agent ITSELF first and the
  // leader only on a repeat; debounced per (owner, tool) inside the sweep.
  // The report is RETURNED (not just logged) so P-015's measurement step below can
  // consume the coverage this sweep already computed. Recomputing it there would
  // be a second read of `tool_invocations` in one tick AND a second derivation of
  // a quantity that already has one — the axis-5 violation (D-038) this plan has
  // ruled against repeatedly.
  const divergenceReport = await DBOS.runStep(
    async () => {
      try {
        const { divergenceSweep } = await import('../agent-state-divergence-sweep');
        const { outcomes, report } = await divergenceSweep();
        for (const o of outcomes) {
          if (o.outcome === 'error') console.warn(`[intent-action-divergence] error: ${o.key} — ${o.reason}`);
          else if (o.outcome === 'escalated') console.warn(`[intent-action-divergence] ${o.reason}`);
        }
        // The stamp fill rate is P-015's measurement and the one number that
        // says whether the stamped leg is alive yet — log it where a sweep is
        // already writing, so nobody has to run a query to find out.
        if (report && report.coverage.callsExamined > 0) {
          console.info(
            `[intent-action-divergence] examined ${report.coverage.callsExamined} calls, ` +
              `stampFillRate=${report.coverage.stampFillRate}, ` +
              `thrashRuns=${report.coverage.thrashRuns}/${report.coverage.failuresSeen} failures ` +
              // The suppression breakdown, for the same reason the fill rate is
              // here: `thrashRuns` alone cannot say whether a run was REPORTED.
              // A converged/unsettled count climbing while notifications stay
              // flat is the detector working, not the detector silent
              // (EI-18824142520274965).
              `(converged=${report.coverage.convergedRuns}, unsettled=${report.coverage.unsettledRuns})`,
          );
        }
        return report;
      } catch (e) {
        console.warn(`[intent-action-divergence] sweep failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    { name: 'intent-action-divergence-sweep' },
  );

  // stale-prompt-render-in-live-sessions-2026-08-02 P-004: tell a RUNNING session
  // that its own system-prompt render has materially drifted from current sources.
  //
  // A sweep, and specifically a PUSH, because the condition is unreachable any
  // other way: `--system-prompt-file` is read once at exec, so a session serving a
  // 14-day-old render cannot re-read it, cannot detect it, and (per D-003) is not
  // reached by P-002's respawn re-render if its adv row predates migration 738.
  // Nobody but the agent itself can act on this, so there is no leader escalation.
  //
  // Quietness is the design (the plan: chatter "gets ignored, which is worse than
  // silence"): only deny-list recommendations and retired route mechanisms count,
  // and each (owner, drift) is delivered once per 24h.
  await DBOS.runStep(
    async () => {
      try {
        const { stalePromptRenderSweep } = await import('../stale-prompt-render-sweep');
        const res = await stalePromptRenderSweep();
        const notified = res.outcomes.filter((o) => o.outcome === 'notified').length;
        for (const o of res.outcomes) {
          if (o.outcome === 'error') console.warn(`[stale-prompt-render] error: ${o.ownerId} — ${o.reason}`);
        }
        // Logged only when it did something OR when it deliberately stood a family
        // down — a silent no-op is the normal, healthy case and does not need a line.
        if (notified > 0 || res.routeFamilySuppressed) {
          console.info(
            `[stale-prompt-render] examined ${res.examined} live session(s), notified ${notified}` +
              // WHY a quiet sweep was quiet. Without this, a suppressed route family
              // and a genuinely clean fleet are indistinguishable in the log — the
              // shape that let the sibling sweep's dead debounce hide for months.
              (res.routeFamilySuppressed
                ? ` — route family SUPPRESSED (${res.suppressionReason ?? 'incomplete source union'})`
                : ''),
          );
        }
      } catch (e) {
        console.warn(`[stale-prompt-render] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'stale-prompt-render-sweep' },
  );

  // unified-agent-state-plane-2026-07-27 P-015: the plane's baseline + standing
  // measurement. A sweep for the same reason P-010 is one (D-046 refuses another
  // pull read over `tool_invocations`; D-091 §1 records the verdict as computed
  // and DELIVERED, with no browse surface).
  //
  // It records at most ONE reading per window — D-030 §3 requires at least two
  // batches before any trend is reported, because within-arm variance there
  // equalled between-arm variance, so a series of overlapping windows would be a
  // trend line made of duplicates.
  await DBOS.runStep(
    async () => {
      try {
        const { planeMeasurementSweep, formatMeasurementLog, formatCellTenureLog } =
          await import('../agent-plane-measurement-sweep');
        const out = await planeMeasurementSweep({ divergence: divergenceReport ?? null });
        if (out.outcome === 'error') console.warn(`[plane-measurement] ${out.reason}`);
        // Logged in full: the line leads with how much is MEASURABLE and names the
        // missing producer behind each structural zero, because "0 divergences, 0
        // conflicts" is the exact misread D-087/D-089 were written to prevent.
        else if (out.outcome === 'recorded') {
          console.info(formatMeasurementLog(out.measurement));
          // P-008 — the tenure cut-or-keep line. Absent when its leg failed, which is
          // NOT the same as an empty registry and must not print as one.
          if (out.tenure) console.info(formatCellTenureLog(out.tenure));
        }
      } catch (e) {
        console.warn(`[plane-measurement] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'agent-plane-measurement-sweep' },
  );

  // GYM-2 (gym-unwedge-scout-novelty-2026-07-02, generalized across roles by WI-4632):
  // the chronic-autoloop-failure escalator — a cycle red >= threshold consecutive fires
  // files ONE observation + requests an immediate overwatch wake, per 24h per (harness,
  // role). The fire-gate backoff slows a failing cycle; this SURFACES it (the gym sat
  // 12 days dead with 72 errors and no witness).
  await DBOS.runStep(
    async () => {
      const { autoloopChronicFailureSweep, shouldLogChronicOutcome } =
        await import('../harness/routines/autoloop-chronic-failure');
      const results = await autoloopChronicFailureSweep();
      for (const r of results) {
        if (r.outcome === 'debounced') continue;
        // EI-12968: a `skipped-*` outcome is rate-limited to once/hour per
        // (outcome, harness, role) — the sweep's decision stays correct + un-
        // throttled every tick; only this journal line was flooding (a frozen
        // watermark re-logged identically every ~30s, forever).
        if (!(await shouldLogChronicOutcome(r))) continue;
        console.warn(`[autoloop-chronic] ${r.outcome}: ${r.role}@${r.harnessSlug} — ${r.reason.slice(0, 160)}`);
      }
    },
    { name: 'autoloop-chronic-failure-sweep' },
  );

  // EI-19281872822982156: the CHRONIC sweep above is entirely error-streak-driven —
  // a role that stops firing while its OWN error bookkeeping still reads 'ok' (0
  // consecutive_errors) is never a candidate, no matter how long it sits dead (Kettle
  // sat 7 days past its last fire this way, invisible to both this and the dead-routine
  // check). Independent kill switch (PAPERCUSP_AUTOLOOP_SILENT_STOP_MS), independent
  // 24h debounce ledger — see autoloop-chronic-failure.ts's doc comment above
  // autoloopSilentStopSweep for why this is a SEPARATE sweep rather than folded into
  // the one above.
  await DBOS.runStep(
    async () => {
      const { autoloopSilentStopSweep } = await import('../harness/routines/autoloop-chronic-failure');
      const results = await autoloopSilentStopSweep();
      for (const r of results) {
        if (r.outcome === 'debounced') continue;
        console.warn(`[autoloop-silent-stop] ${r.outcome}: ${r.role}@${r.harnessSlug} — ${r.reason.slice(0, 160)}`);
      }
    },
    { name: 'autoloop-silent-stop-sweep' },
  );

  // EI-19281872822982156 (defect 2): the learning-loop health CLASSIFIER
  // (blueprint/learning-loop-health.ts) has correctly flagged an always-on
  // singleton (scout/change-ledger/iq-battery) paused via the Agents pane as
  // `should-be-on-but-dark`, and a wedged active loop as `stale`, since
  // relight-self-learning-edges-2026-06-14 P-030 — but nothing periodically CALLS
  // it and acts on a bad verdict; it was pull-only (`improvements:learning_loops`,
  // the Learning tab). The Scout/Blender leg sat paused this way for 5 days with a
  // correct, unread verdict the whole time. Same watchdog-sweep house pattern,
  // its own 24h debounce ledger (source 'learning-loop-health').
  await DBOS.runStep(
    async () => {
      const { learningLoopHealthSweep } = await import('../harness/routines/learning-loop-health-sweep');
      const results = await learningLoopHealthSweep();
      for (const r of results) {
        if (r.outcome === 'debounced') continue;
        console.warn(`[learning-loop-health] ${r.outcome}: ${r.blueprintId} (${r.status}) — ${r.reason.slice(0, 160)}`);
      }
    },
    { name: 'learning-loop-health-sweep' },
  );

  // EI-19342686127995790: the INTERPRETER for the new-file tsc reds the baseline gate
  // observes on its hot path. The gate recomputes that finding ~9x/hour (every agent's
  // post-edit `lint:tsc`) and recorded it ZERO times — it went to a stdout block agents
  // skim past on the way to `TSC_EXIT=`. But filing on first sight is the WRONG remedy:
  // measured 2026-08-02, 4 of 5 committed reds cleared unaided within ~15 minutes, so
  // eager filing would mint items that close themselves unread. This files only reds that
  // OUTLIVE the dwell threshold — the ones whose author has moved on and which therefore
  // red the shared green-checkpoint with nobody on them. Own 24h per-path debounce ledger
  // (source 'tsc-new-file-red'). Fail-soft: a missing/corrupt store files nothing.
  await DBOS.runStep(
    async () => {
      const { tscRedSweep, resolveClearedTscReds } = await import('../harness/routines/tsc-red-sweep');
      // EI-20064603102922814 — RETRACT before filing. Filing without retracting made every
      // open item in this lane false: measured 2026-08-10, 5 of 5 were already fixed, 4 of
      // them for ~30h, each still reading as a live severity:major fleet-gate blocker. The
      // retraction is a separate pass rather than a step inside tscRedSweep so the two have
      // independent failure domains — a DB-side resolve failure must not cost us a filing.
      const results = [...(await resolveClearedTscReds()), ...(await tscRedSweep())];
      for (const r of results) {
        if (r.outcome === 'debounced') continue;
        console.warn(
          `[tsc-red-sweep] ${r.outcome}: ${r.file} (${Math.round(r.spanSec / 60)}min, ` +
            `${r.sightings} sightings) — ${r.reason.slice(0, 160)}`,
        );
      }
    },
    { name: 'tsc-red-sweep' },
  );

  // scheduled-recurring-plans-2026-06-16 (Phase 5) — the scheduled-plan RUN completion +
  // governance sweep. A `system:plan-run` fire mints a plan_runs row at status='running' +
  // work_items; nothing settled the run when those finished, and the cost-cap / failure-streak
  // auto-pause only act on a SETTLED run. reconcile-plan-runs.ts was implemented + tested but
  // never wired (EI: its doc claimed "called before the plans:runs read + by the tick" — it
  // wasn't), so scheduled runs stayed `running` forever and the governance never fired. Ride the
  // 30s tick like the watchdog sweeps above: settle every running scheduled run whose work_items
  // are terminal, then auto-pause a template that breached its costCapCents or failure streak.
  // Best-effort (a sweep failure must never fail the loop it watches) + one durable step.
  await DBOS.runStep(
    async () => {
      try {
        const { reconcileAndGovern } = await import('../harness/routines/reconcile-plan-runs');
        const { reconciled, paused, orphaned } = await reconcileAndGovern();
        if (reconciled > 0 || paused.length > 0 || orphaned > 0) {
          console.warn(
            `[plan-run-reconcile] tick settled ${reconciled} scheduled run(s)` +
              (orphaned > 0 ? `, reclaimed ${orphaned} orphaned run(s)` : '') +
              (paused.length ? `, auto-paused ${paused.length} schedule(s): ${paused.join(', ')}` : ''),
          );
        }
      } catch (e) {
        console.warn(`[plan-run-reconcile] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'plan-run-reconcile-sweep' },
  );

  // queen-autonomous-execution B-11 / P-050: hive THROUGHPUT instrumentation —
  // one snapshot tick per started hive, riding the same 30s sweep. Records the
  // six metrics (frontier depth, placements/wake, busy-vs-cap, stuck, MTTC,
  // question-rung split) to hive_throughput_ticks (mig 261) and files an FB-21
  // breach signal on saturation/stuck. Best-effort + one durable step so a crash
  // resumes; observability must never fail the loop it watches.
  await DBOS.runStep(
    async () => {
      // K1 (workspace-scoped-coordination P-003): one throughput tick per
      // workspace loop when WORKSPACE_COORDINATION is ON; the raw per-hive set
      // (byte-identical) when OFF.
      const [{ listStartedWorkspaceLoops }, { recordPotThroughputTick }] = await Promise.all([
        import('../pot/started'),
        import('../pot/throughput'),
      ]);
      for (const { workspaceId, installSlug } of await listStartedWorkspaceLoops()) {
        await recordPotThroughputTick({ workspaceId, potSlug: installSlug }).catch(() => {});
      }
    },
    { name: 'pot-throughput-tick' },
  );

  // platform-to-app-data-producer-2026-08-30 P-005 (D-001): the app data
  // producer's reconcile sweep. For each configured (owner, app) mapping it
  // asks the APP where its cursor is (D-002), reads canonical documents
  // rows after it (D-004), and POSTs them through the SAME mapper the live push
  // sink uses, so push and reconcile cannot produce divergent app rows.
  //
  // This is not merely a faster catch-up for a down app: per D-013 the push
  // sink DECLINES registration when its gate fails, and a declined registration
  // writes no delivery row at all — so this sweep is that case's only repair
  // path. It is also the mechanism P-006's backfill rides rather than a second
  // program.
  //
  // A workspace with no mappings does nothing and costs one indexed read. The
  // sweep is fail-soft internally (every failure becomes a result row), so a
  // single unreachable app can neither abort the tick nor stall its siblings.
  await DBOS.runStep(
    async () => {
      const { sql } = getOrgPg();
      const { appDataProducerReconcileSweep } = await import('../app-data-producer/reconcile');
      const results = await appDataProducerReconcileSweep(sql, activeWorkspaceId());
      for (const res of results) {
        if (res.outcome === 'error' || res.outcome === 'skipped') {
          console.warn(`[app-data-producer] ${res.outcome}: ${res.app}/${res.userId} — ${res.reason}`);
        }
      }

      // P-007. The sweep's own results CANNOT report the failure this plan
      // exists to end: with no owner mapping there are no pairs, so `results`
      // is [] and every count below reads zero — identical to a healthy,
      // fully-drained producer. The status read enumerates the APPS instead of
      // the mappings, so an unconfigured or misconfigured producer is a row
      // rather than an absence.
      //
      // probeApps:false — this runs on every tick, and the network probe is
      // the reconcile sweep's job (it just ran). Configuration and ledger
      // state answer "is this switched on and is it erroring" without one.
      const { readAppProducerStatus, hasProducerFault } = await import('../app-data-producer/status');
      let producerStatus: Awaited<ReturnType<typeof readAppProducerStatus>> = [];
      try {
        producerStatus = await readAppProducerStatus(sql, activeWorkspaceId(), { probeApps: false });
        for (const s of producerStatus.filter((r) => r.fault)) {
          console.error(
            `[app-data-producer] ${s.health.toUpperCase()}: ${s.app}${s.userId ? `/${s.userId}` : ''} — ${s.detail}`,
          );
        }
      } catch (cause) {
        console.error('[app-data-producer] status read failed', cause);
      }
      // Returned rather than voided so a swallowed failure is distinguishable
      // from a healthy empty run in operation_outputs.
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        deliveredRows: results.reduce((n, r) => n + r.rowsDelivered, 0),
        // Rows SCANNED, delivered or skipped. Distinct from deliveredRows on
        // purpose: a backfill pass that reads its whole budget and delivers
        // nothing (every row unmappable) is working, not idle, and only this
        // number tells the two apart.
        readRows: results.reduce((n, r) => n + r.rowsRead, 0),
        errorCount: results.filter((r) => r.outcome === 'error').length,
        skippedCount: results.filter((r) => r.outcome === 'skipped').length,
        morePending: results.some((r) => r.more),
        results: results.slice(0, 25),
        // The health verdict, hoisted so a reader of operation_outputs does not
        // have to re-derive it from the rows — and so `resultCount: 0` can never
        // again be mistaken for a healthy producer.
        producerFault: hasProducerFault(producerStatus),
        producerStatus,
      };
    },
    { name: 'app-data-producer-reconcile-sweep' },
  );
}

const routinesTickWorkflow = idempotentRegisterWorkflow('routinesTick', () =>
  DBOS.registerWorkflow(routinesTickImpl, { name: 'routinesTick' }),
);

// Scheduled fn must also be a registered workflow. Default skip-missed mode.
DBOS.registerScheduled(routinesTickWorkflow, { name: 'routinesTick', crontab: TICK_CRONTAB });
