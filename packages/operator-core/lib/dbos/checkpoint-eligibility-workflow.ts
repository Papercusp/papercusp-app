/**
 * Durable `release:checkpoint-run { waitForEligibility:true }` waiter.
 *
 * The request handler must not sleep across the MCP transport deadline. This workflow owns the
 * bounded quiet-cut delay, rechecks the candidate after waking, and only then takes the manual
 * checkpoint launch path. DBOS persists the sleep and the checkpointed steps, so an operator
 * restart cannot turn an accepted wait into a silently lost launch.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  assessPreLaunchExclusion,
  checkpointEligibilityCompletionEvents,
  CHECKPOINT_MAX_RUNTIME_SEC,
  checkpointPipelineName,
  launchDetachedCheckpoint,
  type CheckpointEligibilityWaitRequest,
  type CheckpointEligibilityWaitReceipt,
  type LaunchCheckpointResult,
  type PreLaunchExclusion,
  setCheckpointEligibilityWaitRunner,
} from '../release-checkpoint-launch';
import {
  assessRequiredAncestorPreflight,
  type RequiredAncestorPreflight,
} from '../release/checkpoint-required-ancestor';
import { integrationRoot } from '../release-deploy-launch';
import { emitAwaitedEvent, type EmitAwaitedEventOpts } from '../events/await/engine';
import { activeWorkspaceId } from '../workspace-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import {
  PRE_SUITE_NO_VERDICT_REASONS,
  recordStoredQualificationEligibility,
  reserveStoredQualificationRunner,
  waitStoredQualification,
  type PreSuiteNoVerdictReason,
  type StoredQualificationMutation,
} from '../release/checkpoint-qualification-transaction';
import {
  buildCheckpointEligibilitySnapshot,
  type CheckpointEligibilityPredicate,
  type CheckpointEligibilityPredicateCode,
  type CheckpointEligibilitySnapshot,
} from '../release/checkpoint-eligibility-snapshot';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

export interface CheckpointEligibilityWaitOutcome {
  status: 'launched' | 'not-launched';
  reason?: string;
  result?: LaunchCheckpointResult;
}

export interface CheckpointEligibilityWaitDeps {
  sleep: (ms: number) => Promise<void>;
  assess: (args: { paths: string[]; force?: boolean; root?: string }) => Promise<PreLaunchExclusion>;
  assessRequiredAncestor?: (args: {
    requiredAncestor: string;
    predictedCandidate: string | null;
    root?: string;
  }) => Promise<RequiredAncestorPreflight>;
  launch: (opts: {
    force?: boolean;
    replaceStale?: boolean;
    root?: string;
    logicalAttemptId?: string;
  }) => Promise<LaunchCheckpointResult>;
  emit: (opts: EmitAwaitedEventOpts) => Promise<unknown>;
  reserveQualification?: (input: Parameters<typeof reserveStoredQualificationRunner>[1]) => Promise<StoredQualificationMutation>;
  waitQualification?: (input: Parameters<typeof waitStoredQualification>[1]) => Promise<StoredQualificationMutation>;
  recordEligibility?: (
    input: Parameters<typeof recordStoredQualificationEligibility>[1],
  ) => Promise<StoredQualificationMutation>;
}

function noVerdictReason(reason: string | undefined): PreSuiteNoVerdictReason {
  const normalized = (reason ?? '').trim().replaceAll('_', '-');
  return (PRE_SUITE_NO_VERDICT_REASONS as readonly string[]).includes(normalized)
    ? normalized as PreSuiteNoVerdictReason
    : 'launch-refused';
}

function mutationAllowsContinuation(mutation: StoredQualificationMutation): boolean {
  return mutation.status === 'updated' || mutation.status === 'idempotent';
}

/**
 * Pure workflow decision seam. Keeping the delay/recheck/launch ordering here makes the
 * recurrence guard testable without starting DBOS or a systemd unit.
 */
export async function runCheckpointEligibilityWait(
  input: CheckpointEligibilityWaitRequest,
  deps: CheckpointEligibilityWaitDeps,
): Promise<CheckpointEligibilityWaitOutcome> {
  let eligibilitySnapshot: CheckpointEligibilitySnapshot | null = input.eligibilitySnapshot ?? null;
  const pipeline = checkpointPipelineName(input.root ?? integrationRoot());
  // EI-21533914348699873: an inconclusive eligibility outcome is terminal for this
  // checkpoint:await registration. Retire both outcome families in both key scopes;
  // emitAwaitedEvent keeps unrelated subscribers and candidate-bound waits isolated.
  const cancelSiblingKeysFor = [
    'release:green',
    `release:green:${pipeline}`,
    'green-checkpoint:red',
    `green-checkpoint:red:${pipeline}`,
  ];
  const updateEligibility = async (
    updates: Partial<Record<CheckpointEligibilityPredicateCode, Partial<CheckpointEligibilityPredicate>>>,
  ): Promise<StoredQualificationMutation | null> => {
    if (!input.logicalAttemptId || !eligibilitySnapshot) return null;
    eligibilitySnapshot = buildCheckpointEligibilitySnapshot({
      attemptId: input.logicalAttemptId,
      candidate: eligibilitySnapshot.candidate,
      predicates: eligibilitySnapshot.predicates.map((predicate) => ({
        ...predicate,
        ...(updates[predicate.code] ?? {}),
        code: predicate.code,
      })),
    });
    if (!deps.recordEligibility) {
      return { status: 'unreadable', error: 'qualification eligibility writer is not wired' };
    }
    return deps.recordEligibility({
      attemptId: input.logicalAttemptId,
      snapshot: eligibilitySnapshot,
    });
  };
  const emitQualificationFailure = async (reason: string): Promise<void> => {
    await deps.emit({
      key: `green-checkpoint:inconclusive:${pipeline}`,
      summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${reason}`,
      payload: {
        pendingId: input.pendingId,
        logicalAttemptId: input.logicalAttemptId ?? null,
        reason,
        eligibilitySnapshot,
      },
      source: 'checkpoint-eligibility-wait',
      cancelSiblingKeysFor,
    });
  };
  const recordWait = async (
    reason: PreSuiteNoVerdictReason,
    code: string,
    detail: string,
  ): Promise<StoredQualificationMutation | null> => {
    if (!input.logicalAttemptId) return null;
    if (!deps.waitQualification) return { status: 'unreadable', error: 'qualification waiter is not wired' };
    return deps.waitQualification({
      attemptId: input.logicalAttemptId,
      reason,
      blockers: [{ code, detail, clearEvents: [] }],
      evidenceRefs: [`checkpoint-eligibility:${input.pendingId}`],
    });
  };

  // +2s crosses the quiet-window boundary rather than landing exactly on it. The cut is an age
  // test at second granularity, so an exact-boundary wake can still round the wrong way.
  await deps.sleep((Math.max(0, Math.ceil(input.waitSec)) + 2) * 1000);

  const recheck = await deps.assess({
    paths: input.paths,
    force: input.force,
    root: input.root,
  });
  const quietEligibility = await updateEligibility({
    candidate: {
      status: recheck.candidate ? 'clear' : 'unreadable',
      detail: recheck.candidate
        ? `candidate ${recheck.candidate}`
        : 'durable eligibility recheck could not resolve a candidate',
      evidenceRefs: recheck.candidate ? [`candidate:${recheck.candidate}`] : [],
    },
    'quiet-cut-containment': {
      status: recheck.refuse || recheck.proceedReason === 'wait-exceeds-cap' ? 'waiting' : 'clear',
      detail: recheck.refuse
        ? `declared paths remain outside the candidate for ~${recheck.waitSec ?? 0}s`
        : recheck.proceedReason ?? 'quiet-cut containment is clear',
      clearEvents: recheck.refuse
        ? checkpointEligibilityCompletionEvents(input.root ?? integrationRoot())
        : [],
      evidenceRefs: [
        ...(recheck.candidate ? [`candidate:${recheck.candidate}`] : []),
        ...(recheck.tip ? [`tip:${recheck.tip}`] : []),
      ],
    },
  });
  if (quietEligibility && !mutationAllowsContinuation(quietEligibility)) {
    const reason = `qualification-eligibility-${quietEligibility.status}`;
    await emitQualificationFailure(reason);
    return { status: 'not-launched', reason };
  }

  // A newly-arrived commit can move the candidate while this waiter sleeps. Do not silently
  // launch a run that is known to omit the caller's paths; emit the inconclusive gate event
  // so a `checkpoint:await` waiter gets an actionable wake, retires the sibling verdict waits,
  // and can retry with a fresh preflight instead.
  if (recheck.refuse || recheck.proceedReason === 'wait-exceeds-cap') {
    const reason = recheck.refuse ? 'still-would-exclude-declared-paths' : 'eligibility-wait-exceeds-cap';
    const waitMutation = await recordWait('would-exclude-declared-paths', 'quiet-cut', reason);
    if (waitMutation && !mutationAllowsContinuation(waitMutation)) {
      const mutationReason = `qualification-wait-${waitMutation.status}`;
      await emitQualificationFailure(mutationReason);
      return { status: 'not-launched', reason: mutationReason };
    }
    await deps.emit({
      key: `green-checkpoint:inconclusive:${pipeline}`,
      summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${reason}`,
      payload: {
        pendingId: input.pendingId,
        reason,
        candidate: recheck.candidate,
        tip: recheck.tip,
        wait_sec: recheck.waitSec,
        blocked_paths: recheck.blockedPaths,
        eligibilitySnapshot,
      },
      source: 'checkpoint-eligibility-wait',
      cancelSiblingKeysFor,
    });
    return { status: 'not-launched', reason };
  }

  if (input.requiredAncestorSha) {
    const requiredAncestor = await (deps.assessRequiredAncestor ?? ((args) =>
      assessRequiredAncestorPreflight(args.requiredAncestor, args.predictedCandidate, args.root)))({
      requiredAncestor: input.requiredAncestorSha,
      predictedCandidate: recheck.candidate,
      root: input.root,
    });
    const ancestorEligibility = await updateEligibility({
      'required-ancestor': {
        status: requiredAncestor.ok
          ? 'clear'
          : requiredAncestor.reason === 'unverifiable' || requiredAncestor.reason === 'queue-unreadable'
            ? 'unreadable'
            : 'waiting',
        detail: requiredAncestor.ok
          ? `${input.requiredAncestorSha} is contained in ${requiredAncestor.candidate}`
          : requiredAncestor.detail ?? requiredAncestor.reason,
        clearEvents: requiredAncestor.ok ? [] : [`git-sync:egressed:${input.requiredAncestorSha}`],
        evidenceRefs: [`required-ancestor:${input.requiredAncestorSha}`],
      },
      'frozen-repair-queue': {
        status: requiredAncestor.ok
          ? 'clear'
          : requiredAncestor.reason === 'queue-unreadable' ? 'unreadable' : 'waiting',
        detail: requiredAncestor.queueDecision ?? requiredAncestor.detail ?? requiredAncestor.reason,
        clearEvents: requiredAncestor.ok
          ? []
          : checkpointEligibilityCompletionEvents(input.root ?? integrationRoot()),
        evidenceRefs: ['reader:frozen-repair-queue'],
      },
    });
    if (ancestorEligibility && !mutationAllowsContinuation(ancestorEligibility)) {
      const reason = `qualification-eligibility-${ancestorEligibility.status}`;
      await emitQualificationFailure(reason);
      return { status: 'not-launched', reason };
    }
    if (!requiredAncestor.ok) {
      const reason =
        requiredAncestor.reason === 'not-ancestor'
          ? 'required-ancestor-missing'
          : 'required-ancestor-unverifiable';
      const waitMutation = await recordWait(reason, 'required-ancestor', requiredAncestor.reason);
      if (waitMutation && !mutationAllowsContinuation(waitMutation)) {
        const mutationReason = `qualification-wait-${waitMutation.status}`;
        await emitQualificationFailure(mutationReason);
        return { status: 'not-launched', reason: mutationReason };
      }
      await deps.emit({
        key: `green-checkpoint:inconclusive:${pipeline}`,
        summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${reason}`,
        payload: {
          pendingId: input.pendingId,
          reason,
          requiredAncestorSha: input.requiredAncestorSha,
          candidate: requiredAncestor.candidate,
          candidateSource: requiredAncestor.candidateSource,
          queueDecision: requiredAncestor.queueDecision,
          fixerAlive: requiredAncestor.fixerAlive,
          eligibilitySnapshot,
        },
        source: 'checkpoint-eligibility-wait',
        cancelSiblingKeysFor,
      });
      return { status: 'not-launched', reason };
    }
  }

  if (input.logicalAttemptId) {
    if (!deps.reserveQualification) {
      await emitQualificationFailure('qualification-reservation-unavailable');
      return { status: 'not-launched', reason: 'qualification-reservation-unavailable' };
    }
    const reservation = await deps.reserveQualification({
      attemptId: input.logicalAttemptId,
      runnerId: `eligibility:${input.pendingId}`,
      candidate: recheck.candidate,
      leaseDurationMs: CHECKPOINT_MAX_RUNTIME_SEC * 1_000,
      evidenceRefs: [`checkpoint-eligibility:${input.pendingId}`],
    });
    if (!mutationAllowsContinuation(reservation)) {
      const reservationReason = `qualification-reservation-${reservation.status}`;
      await emitQualificationFailure(reservationReason);
      return { status: 'not-launched', reason: reservationReason };
    }
  }

  const result = await deps.launch({
    force: input.force,
    replaceStale: input.replaceStale,
    root: input.root,
    ...(input.logicalAttemptId ? { logicalAttemptId: input.logicalAttemptId } : {}),
  });
  if (result.launched) return { status: 'launched', result };

  const waitMutation = await recordWait(
    noVerdictReason(result.reason),
    'detached-launch',
    result.reason ?? 'not-launched',
  );
  if (waitMutation && !mutationAllowsContinuation(waitMutation)) {
    const mutationReason = `qualification-wait-${waitMutation.status}`;
    await emitQualificationFailure(mutationReason);
    return { status: 'not-launched', reason: mutationReason, result };
  }

  // The standard checkpoint verdict events cover a successful detached run. If the launch
  // itself is refused (probe failure, an already-running run, etc.), surface an inconclusive
  // event and retire the sibling verdict waits instead of leaving the receipt with no
  // completion signal.
  await deps.emit({
    key: `green-checkpoint:inconclusive:${pipeline}`,
    summary: `checkpoint eligibility wait ${input.pendingId} did not launch: ${result.reason ?? 'unknown'}`,
    payload: {
      pendingId: input.pendingId,
      reason: result.reason ?? 'not-launched',
      unit: result.unit,
    },
    source: 'checkpoint-eligibility-wait',
    cancelSiblingKeysFor,
  });
  return { status: 'not-launched', reason: result.reason ?? 'not-launched', result };
}

async function checkpointEligibilityWaitImpl(
  input: CheckpointEligibilityWaitRequest,
): Promise<CheckpointEligibilityWaitOutcome> {
  const target = { workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() };
  return runCheckpointEligibilityWait(input, {
    sleep: (ms) => DBOS.sleep(ms),
    assess: (args) =>
      DBOS.runStep(() => assessPreLaunchExclusion(args), {
        name: 'checkpoint-eligibility-recheck',
      }),
    launch: (opts) =>
      DBOS.runStep(() => launchDetachedCheckpoint(opts), {
        name: 'checkpoint-eligibility-launch',
      }),
    emit: (opts) =>
      DBOS.runStep(() => emitAwaitedEvent(opts), {
        name: 'checkpoint-eligibility-inconclusive',
      }),
    reserveQualification: (reservation) =>
      DBOS.runStep(() => reserveStoredQualificationRunner(target, reservation), {
        name: 'checkpoint-eligibility-reserve-qualification',
      }),
    waitQualification: (wait) =>
      DBOS.runStep(() => waitStoredQualification(target, wait), {
        name: 'checkpoint-eligibility-wait-qualification',
      }),
    recordEligibility: (eligibility) =>
      DBOS.runStep(() => recordStoredQualificationEligibility(target, eligibility), {
        name: 'checkpoint-eligibility-record-snapshot',
      }),
  });
}

export const checkpointEligibilityWaitWorkflow = idempotentRegisterWorkflow(
  'checkpointEligibilityWait',
  () =>
    DBOS.registerWorkflow(checkpointEligibilityWaitImpl, {
      name: 'checkpointEligibilityWait',
      maxRecoveryAttempts: 5,
    }),
);

const checkpointEligibilityWaitQueue = idempotentWorkflowQueue(
  'checkpoint-eligibility-wait',
  () => new WorkflowQueue('checkpoint-eligibility-wait', { concurrency: queueConcurrency(2) }),
);

/** Enqueue once per pending id and return a receipt before the quiet-cut delay begins. */
export async function enqueueCheckpointEligibilityWait(
  input: CheckpointEligibilityWaitRequest,
): Promise<CheckpointEligibilityWaitReceipt> {
  const root = input.root ?? integrationRoot();
  const normalized = { ...input, root };
  const workflowId = `checkpoint-eligibility:${input.pendingId}`;
  await DBOS.startWorkflow(checkpointEligibilityWaitWorkflow, {
    workflowID: workflowId,
    queueName: checkpointEligibilityWaitQueue.name,
    enqueueOptions: { deduplicationID: workflowId },
  })(normalized);
  return {
    pendingId: input.pendingId,
    workflowId,
    completionEvents: checkpointEligibilityCompletionEvents(root),
    ...(input.logicalAttemptId ? { logicalAttemptId: input.logicalAttemptId } : {}),
  };
}

/** Wire the request-side seam after DBOS has been registered by host bootstrap. */
export function wireCheckpointEligibilityWait(): void {
  setCheckpointEligibilityWaitRunner(enqueueCheckpointEligibilityWait);
}
