/**
 * `system:work-item-admission-bulk-dedup-driver` — the recurring driver for the
 * staged work-item admission bulk dedup (WI-10004722, plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-005).
 *
 * WHY IT EXISTS. Census + bulk stages only ever ran when someone called
 * `work_items:bulk_dedup` by hand (D-014). Nobody did after 2026-09-05: that last
 * stage failed on a DB recovery-mode blip and was never retried, the census went
 * stale, and the daily digest — which needs a completed, yielding bulk stage over
 * a census that covers the live corpus — sat blocked on `census-coverage-mismatch`
 * for 18 straight days. A pass that only runs on demand is not a pass that
 * converges.
 *
 * WHAT A FIRE DOES. Deterministic, no model call of its own:
 *   1. If ANY bulk-dedup pass for this harness is still in flight (an armed routine,
 *      a live routineFire, or a census / bulk-stage row that started and never
 *      finished inside the fire-timeout window), skip and say why.
 *   2. Otherwise arm ONE bounded run through `enqueueBulkDedupRun` — the same path
 *      the tool uses — on a single fixed routine row, so a daily cadence re-arms
 *      one row instead of minting a routine per day. Each fire gets a fresh runId,
 *      so a stage that failed yesterday is simply retried today.
 *
 * The run it arms bills model calls (strong-model shard judgements), which is why
 * this target role is classified `llm` even though the driver itself never calls a
 * model. `maxStages` bounds that spend per day.
 */
import { getOrgPg } from '@papercusp/db-org';
import { notifySyncInvalidate } from '../../sync-sse';
import { WORK_ITEM_ADMISSION_BULK_DEDUP } from '../../work-items-admission-bulk-dedup';
import {
  bulkDedupInFlight,
  DEFAULT_DRIVER_MAX_STAGES,
  enqueueBulkDedupRun,
  newBulkDedupRunId,
  WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER,
  type BulkDedupInFlight,
  type BulkDedupRunControls,
  type EnqueueBulkDedupRunResult,
} from '../../work-items-admission-bulk-dedup-enqueue';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export { DEFAULT_DRIVER_MAX_STAGES, WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER };
/** The one routine row every scheduled run re-arms (vs one row per manual runId). */
export const BULK_DEDUP_SCHEDULED_ROUTINE_NAME = `${WORK_ITEM_ADMISSION_BULK_DEDUP}-scheduled`;
export const BULK_DEDUP_SCHEDULED_RUN_PREFIX = 'bulk-dedup-scheduled';

const CONTROL_KEYS = [
  'maxStages',
  'maxPairsPerStage',
  'pairsPerCall',
  'shardConcurrency',
  'targetTokens',
  'ceilingTokens',
  'chunkCount',
  'fullCorpusPairThreshold',
] as const;

/**
 * Read the run controls from the driver routine's payload. A malformed value throws:
 * the driver is a standing routine, so a bad seed must fail its fire loudly rather
 * than silently arm an unbounded run.
 */
export function driverRunControls(payload: Record<string, unknown> | null): BulkDedupRunControls {
  const source = payload ?? {};
  const controls: BulkDedupRunControls = {};
  for (const key of CONTROL_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const n = Number(value);
    const allowZero = key === 'fullCorpusPairThreshold';
    if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
      throw new Error(`${WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER}: payload.${key} must be a ${allowZero ? 'non-negative' : 'positive'} integer, received ${String(value)}`);
    }
    controls[key] = n;
  }
  if (typeof source.model === 'string' && source.model.trim()) controls.model = source.model.trim();
  controls.maxStages ??= DEFAULT_DRIVER_MAX_STAGES;
  return controls;
}

export type BulkDedupDriverOutcome =
  | { kind: 'skipped-in-flight'; inFlight: Extract<BulkDedupInFlight, { inFlight: true }> }
  | { kind: 'enqueued'; result: Extract<EnqueueBulkDedupRunResult, { enqueued: true }> }
  | { kind: 'already-running'; result: Extract<EnqueueBulkDedupRunResult, { enqueued: false }> };

export interface BulkDedupDriverDeps {
  inFlight: (ctx: SystemActionCtx) => Promise<BulkDedupInFlight>;
  enqueue: (
    ctx: SystemActionCtx,
    input: { runId: string; routineName: string; controls: BulkDedupRunControls },
  ) => Promise<EnqueueBulkDedupRunResult>;
  newRunId: () => string;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

export async function runBulkDedupDriver(
  ctx: SystemActionCtx,
  deps: Pick<BulkDedupDriverDeps, 'inFlight' | 'enqueue' | 'newRunId'>,
): Promise<BulkDedupDriverOutcome> {
  // Parse first: a malformed seed fails even on a day something is in flight.
  const controls = driverRunControls(ctx.payloadTemplate);
  const inFlight = await deps.inFlight(ctx);
  if (inFlight.inFlight) return { kind: 'skipped-in-flight', inFlight };
  const result = await deps.enqueue(ctx, {
    runId: deps.newRunId(),
    routineName: BULK_DEDUP_SCHEDULED_ROUTINE_NAME,
    controls,
  });
  return result.enqueued ? { kind: 'enqueued', result } : { kind: 'already-running', result };
}

function productionSql() {
  if (process.env.VITEST) throw new Error('production bulk-dedup driver must not touch the database from a unit test');
  return getOrgPg().sql;
}

export function makeWorkItemAdmissionBulkDedupDriverAction(overrides: Partial<BulkDedupDriverDeps> = {}) {
  const deps: BulkDedupDriverDeps = {
    inFlight: (ctx) =>
      bulkDedupInFlight(productionSql(), { workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug }),
    enqueue: (ctx, input) =>
      enqueueBulkDedupRun(productionSql(), {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        ...input,
      }),
    newRunId: () => newBulkDedupRunId(BULK_DEDUP_SCHEDULED_RUN_PREFIX),
    invalidate: () => notifySyncInvalidate('workItemAdmission.runs'),
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const outcome = await runBulkDedupDriver(ctx, deps);
    if (outcome.kind === 'skipped-in-flight') {
      deps.log(
        `${ctx.installSlug}: skipped — a bulk-dedup pass is in flight (${outcome.inFlight.reason} ` +
          `${outcome.inFlight.ref}: ${outcome.inFlight.detail})`,
      );
      return;
    }
    await deps.invalidate();
    if (outcome.kind === 'enqueued') {
      deps.log(
        `${ctx.installSlug}: enqueued run=${outcome.result.runId} routine=${outcome.result.routineId} ` +
          `maxStages=${driverRunControls(ctx.payloadTemplate).maxStages}`,
      );
    } else {
      deps.log(
        `${ctx.installSlug}: not re-armed — routine ${outcome.result.routineId} still has a live fire ` +
          `(${outcome.result.workflowStatus} ${outcome.result.workflowUuid})`,
      );
    }
  };
}

// STANDING: seeded daily by seed-work-item-admission-bulk-dedup-driver-routine.ts and
// registered in BESPOKE_ACTIVE_SEEDS, so a missing row is a loud failure — the whole
// defect this driver closes is a pass that silently never ran.
registerSystemAction(WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER, makeWorkItemAdmissionBulkDedupDriverAction(), {
  scheduling: 'standing',
});
