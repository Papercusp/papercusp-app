/** Durable one-shot system action for work-item admission P-006 bulk convergence. */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { notifySyncInvalidate } from '../../sync-sse';
import {
  BULK_DEDUP_ACTOR,
  defaultBulkDedupPreflight,
  runWorkItemAdmissionBulkDedup,
  WORK_ITEM_ADMISSION_BULK_DEDUP,
  type BulkDedupRunResult,
} from '../../work-items-admission-bulk-dedup';
import { runCheckpointedStep } from '../../dbos/checkpointed-step';
import { optionalModelSpec } from '../../learning/model-policy';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`bulk dedup expected a positive integer, received ${String(value)}`);
  }
  return n;
}

/**
 * `payload.model` overrides the learning-policy default for THIS run only (see
 * BulkDedupRunOptions.model). Blank/absent keeps the canonical policy model.
 */
// Shared with the promoter and daily-digest admission paths so a per-run
// override behaves identically at all three seams.

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`bulk dedup expected a non-negative integer, received ${String(value)}`);
  }
  return n;
}

export interface AdmissionBulkDedupActionDeps {
  run: (ctx: SystemActionCtx) => Promise<BulkDedupRunResult>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

/** Stable gateway owner for every model call belonging to one durable bulk run. */
export function bulkDedupOwnerId(runId: string): string {
  return `${BULK_DEDUP_ACTOR}:${runId}`;
}

/** Production-only seams that make the bulk runner a real multi-step DBOS
 * action while retaining its admission-ledger recovery path. Exported so the
 * action test can pin the wiring without making a live model/capacity call. */
export function bulkDedupRuntimeWiring(runId: string, workflowId: string | undefined = DBOS.workflowID) {
  const ownerId = bulkDedupOwnerId(runId);
  return {
    ownerId,
    executionId: workflowId?.trim() || ownerId,
    step: runCheckpointedStep,
    preflight: defaultBulkDedupPreflight,
  };
}

/**
 * The full-corpus pass is intentionally a long-running, serialized operation:
 * one current corpus can require many model batches and several ratcheted
 * stages. Keep a hard upper bound for a dead executor, but do not reuse the
 * generic two-hour routine-fire valve that cancels healthy convergence.
 */
export const BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS = 24 * 60 * 60_000;

async function productionRun(ctx: SystemActionCtx): Promise<BulkDedupRunResult> {
  if (process.env.VITEST) throw new Error('production bulk dedup action must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  if (!runId) throw new Error('work-item admission bulk dedup action requires payload.runId');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runWorkItemAdmissionBulkDedup({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId,
    // The routine is registered with ownSteps below, so this action executes
    // at the workflow layer and the helper records deterministic phase output.
    ...bulkDedupRuntimeWiring(runId),
    model: optionalModelSpec(payload.model, 'bulk dedup'),
    maxStages: optionalPositiveInteger(payload.maxStages),
    maxPairsPerStage: optionalPositiveInteger(payload.maxPairsPerStage),
    pairsPerCall: optionalPositiveInteger(payload.pairsPerCall),
    shardConcurrency: optionalPositiveInteger(payload.shardConcurrency),
    census: {
      targetTokens: optionalPositiveInteger(payload.targetTokens),
      ceilingTokens: optionalPositiveInteger(payload.ceilingTokens),
      chunkCount: optionalPositiveInteger(payload.chunkCount),
      fullCorpusPairThreshold: optionalNonNegativeInteger(payload.fullCorpusPairThreshold),
    },
    llmCall: (input) => llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug }),
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionBulkDedupAction(overrides: Partial<AdmissionBulkDedupActionDeps> = {}) {
  const deps: AdmissionBulkDedupActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_BULK_DEDUP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    deps.log(
      `${ctx.installSlug}: run=${result.runId} scope=${result.scope} stages=${result.stages.length} ` +
        `census=${result.initialCensus}->${result.finalCensus} convergence=${result.convergenceReason}`,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_BULK_DEDUP, makeWorkItemAdmissionBulkDedupAction(), {
  // P-003: runWorkItemAdmissionBulkDedup owns several checkpointed phases.
  // Wrapping it in the routine engine's single DBOS step would make nested
  // runCheckpointedStep calls silently degrade to direct execution.
  ownSteps: true,
  scheduling: 'on-demand',
  routineTimeoutMs: BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS,
});
