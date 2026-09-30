/**
 * The `billing.closure` release receipt (R-6, WI-10002510, D-395), recorded by the operation that
 * MEASURES it. GCP bills hours behind a teardown, so the destroy cannot know a run's final spend; the
 * only judge is the D-274 deferred-spend reconciler (hosted-lifecycle-store.ts), which reads the
 * billing export by run label and settles a run only once its spend held still across a stability
 * window. So the release-bound destroy OPENS the stage and stamps its cost signal with a
 * `releaseClosure` pointer, and the reconciler adopts that pending intent and settles it from its own
 * finality reading, naming the same destroy. Caller-cited cost evidence never closes billing.
 */
import type { WorkspaceHostSpendFinality } from '@papercusp/deployment-driver';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import { openWorkspaceHostReleaseRecorder, type WorkspaceHostReleaseStage } from './release-stage-receipt';

export const WORKSPACE_HOST_BILLING_CLOSURE_STAGE = 'billing.closure';
export const WORKSPACE_HOST_RELEASE_CLOSURE_SCHEMA_VERSION = 'workspace-host-release-closure-v1';

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The run whose spend is judged, and the ceiling it declared. Both are part of the stage identity. */
export interface WorkspaceHostBillingSubject {
  runId: string;
  maxSpendCents: number | null;
}

/** Left on the destroy's cost signal: which release the settled spend closes, and which run opened it. */
export interface WorkspaceHostReleaseClosurePointer extends WorkspaceHostBillingSubject {
  schemaVersion: typeof WORKSPACE_HOST_RELEASE_CLOSURE_SCHEMA_VERSION;
  releaseTaskId: string;
  /** `destroy-operation:<id>`; the settling receipt names it first. */
  runRef: string;
}

export type SettledWorkspaceHostSpendFinality = Extract<WorkspaceHostSpendFinality, { status: 'settled' }>;

export function workspaceHostBillingClosureStage(subject: WorkspaceHostBillingSubject): WorkspaceHostReleaseStage {
  return {
    stage: WORKSPACE_HOST_BILLING_CLOSURE_STAGE,
    identity: {
      provider: 'gcp',
      source: 'gcp-billing-export-v1',
      runId: subject.runId,
      maxSpendCents: subject.maxSpendCents,
    },
  };
}

export function workspaceHostReleaseClosurePointer(input: {
  releaseTaskId: string;
  operationId: string;
  subject: WorkspaceHostBillingSubject;
}): WorkspaceHostReleaseClosurePointer {
  return {
    schemaVersion: WORKSPACE_HOST_RELEASE_CLOSURE_SCHEMA_VERSION,
    releaseTaskId: input.releaseTaskId,
    runRef: `destroy-operation:${input.operationId}`,
    runId: input.subject.runId,
    maxSpendCents: input.subject.maxSpendCents,
  };
}

/** Read a pointer back off a stored cost signal; anything malformed reads as absent, never as a release. */
export function parseWorkspaceHostReleaseClosurePointer(value: unknown): WorkspaceHostReleaseClosurePointer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const pointer = value as Record<string, unknown>;
  const { releaseTaskId, runRef, runId, maxSpendCents } = pointer;
  if (
    pointer.schemaVersion !== WORKSPACE_HOST_RELEASE_CLOSURE_SCHEMA_VERSION ||
    typeof releaseTaskId !== 'string' ||
    !TASK_ID.test(releaseTaskId) ||
    typeof runRef !== 'string' ||
    !runRef.startsWith('destroy-operation:') ||
    runRef.length <= 'destroy-operation:'.length ||
    typeof runId !== 'string' ||
    runId.trim() === '' ||
    (maxSpendCents !== null && (!Number.isSafeInteger(maxSpendCents) || Number(maxSpendCents) < 0))
  ) {
    return null;
  }
  return {
    schemaVersion: WORKSPACE_HOST_RELEASE_CLOSURE_SCHEMA_VERSION,
    releaseTaskId,
    runRef,
    runId,
    maxSpendCents: maxSpendCents as number | null,
  };
}

/** Judge the stage from the reconciler's settled reading: final, and within the declared ceiling. */
export function workspaceHostBillingClosureOutcome(input: {
  subject: WorkspaceHostBillingSubject;
  finality: SettledWorkspaceHostSpendFinality;
}): { outcome: 'committed' | 'refused'; evidenceRefs: string[] } {
  const { finality, subject } = input;
  const { observation } = finality;
  const overBudget = subject.maxSpendCents !== null && observation.budgetCents > subject.maxSpendCents;
  const evidenceRefs = [
    `billing-run:${subject.runId}`,
    `billing-observation:${observation.providerEvidenceRef.slice(0, 300)}`,
    `billing-net-micros:${observation.currency}:${observation.netMicros}`,
    `billing-budget-cents:${observation.budgetCents}`,
    `billing-max-spend-cents:${subject.maxSpendCents ?? 'undeclared'}`,
    `billing-stable-since:${finality.stableSince}`,
    `billing-stable-for-ms:${finality.stableForMs}/${finality.requiredStableWindowMs}`,
    `billing-stable-observations:${finality.stableObservationCount}/${finality.observationCount}`,
    ...(overBudget ? ['billing-over-budget'] : []),
  ];
  return { outcome: overBudget ? 'refused' : 'committed', evidenceRefs };
}

/**
 * Settle the stage the destroy opened. The pending intent is adopted; a receipt this destroy already
 * committed is left alone, so a reconcile that crashed between the receipt and its signal patch
 * repeats harmlessly. Throws `WorkspaceHostReleaseBindingError` when the stage can never be written.
 */
export async function recordWorkspaceHostBillingClosure(input: {
  workspaceId: string;
  hostId: string;
  pointer: WorkspaceHostReleaseClosurePointer;
  finality: SettledWorkspaceHostSpendFinality;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<{ outcome: 'committed' | 'refused'; evidenceRefs: string[] }> {
  const subject = { runId: input.pointer.runId, maxSpendCents: input.pointer.maxSpendCents };
  const recorder = await openWorkspaceHostReleaseRecorder({
    releaseTaskId: input.pointer.releaseTaskId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    stages: { 'billing-closure': workspaceHostBillingClosureStage(subject) },
    runRef: input.pointer.runRef,
    ...(input.ledger ? { ledger: input.ledger } : {}),
    ...(input.readHostRuntimeRelease ? { readHostRuntimeRelease: input.readHostRuntimeRelease } : {}),
  });
  const judged = workspaceHostBillingClosureOutcome({ subject, finality: input.finality });
  await recorder.begin('billing-closure');
  await recorder.settle('billing-closure', judged.outcome, judged.evidenceRefs);
  return judged;
}
