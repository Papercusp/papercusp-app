import { spawnSync } from 'node:child_process';
import {
  checkpointCandidateContainsAncestor,
  currentCheckpointCandidate,
} from '../release-checkpoint-launch';
import { integrationRoot } from '../release-deploy-launch';
import {
  decideFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
  type FrozenRepairQueueDecision,
} from './frozen-candidate-repair-queue';
import {
  evaluateFrozenLineagePolicy,
  frozenLineageIdentityFromMarker,
  type FrozenLineageIdentity,
  type FrozenLineageIdentityField,
} from './frozen-lineage-execution-policy';

export type RequiredAncestorPreflight = {
  ok: boolean;
  reason: 'contained' | 'not-ancestor' | 'unverifiable' | 'queue-unreadable' | 'queue-not-runnable';
  requiredAncestor: string | null;
  candidate: string | null;
  candidateSource: 'frozen-repair-queue' | 'current-quiet-cut' | 'unresolved';
  repairQueue: FrozenCandidateRepairQueue | null;
  /** Queue identity captured by the server-side selection read. */
  frozenLineageIdentity?: FrozenLineageIdentity | null;
  queueDecision: FrozenRepairQueueDecision['kind'] | null;
  fixerAlive: boolean | null;
  detail?: string;
};

export type FrozenRepairQueuePreflight = {
  /** True when the detached writer can reach a suite-producing path or recover a dead fixer first. */
  proceed: boolean;
  reason: 'clear' | 'repair-in-progress' | 'queue-unreadable';
  candidate: string | null;
  candidateSource: 'frozen-repair-queue' | 'current-quiet-cut' | 'unresolved';
  repairQueue: FrozenCandidateRepairQueue | null;
  /** Queue identity captured by the server-side selection read. */
  frozenLineageIdentity?: FrozenLineageIdentity | null;
  queueDecision: FrozenRepairQueueDecision['kind'] | null;
  nextAttempt: number | null;
  fixerSpawnId: string | null;
  fixerAlive: boolean | null;
  detail?: string;
};

type FrozenRepairQueueState = {
  repairQueue: FrozenCandidateRepairQueue | null;
  queueDecision: FrozenRepairQueueDecision;
  fixerAlive: boolean | null;
};

export interface FrozenLineageLaunchCas {
  allowed: boolean;
  reason:
    | 'no-frozen-queue'
    | 'repair-head-match'
    | 'queue-unreadable'
    | 'queue-appeared'
    | 'queue-disappeared'
    | 'queue-not-runnable'
    | 'queue-identity-mismatch'
    | 'checkout-head-mismatch';
  expectedIdentity: FrozenLineageIdentity | null;
  liveIdentity: FrozenLineageIdentity | null;
  checkoutHead: string | null;
  mismatchedIdentityFields: FrozenLineageIdentityField[];
  queueDecision: FrozenRepairQueueDecision['kind'] | null;
  selectionSource: 'live-repair-head';
  sanctionedRoute: string;
  detail: string;
}

function identityText(identity: FrozenLineageIdentity | null): string {
  return identity
    ? `candidate=${identity.candidate}, repairHead=${identity.repairHead}, queueRevision=${identity.queueRevision}`
    : 'no frozen queue identity';
}

function sanctionedRoute(identity: FrozenLineageIdentity | null): string {
  return identity
    ? `Select and re-read live repairHead ${identity.repairHead} from queue revision ${identity.queueRevision} immediately before launch. Land fixes through release:repair-queue { op:'admit', paths:[...] }.`
    : 'Re-enter through release:checkpoint-run so the server reselects the current queue identity; never reuse a captured or caller-selected SHA.';
}

/**
 * Compare the server-owned queue identity captured during selection with a second
 * live read taken at the launch boundary. Presence changes are mismatches too: a
 * queue created or retired between the two reads must never turn an already-made
 * candidate choice into authority.
 */
export function assessFrozenLineageLaunchCas(
  expectedIdentity: FrozenLineageIdentity | null,
  livePreflight: FrozenRepairQueuePreflight,
  checkoutHead: string | null,
): FrozenLineageLaunchCas {
  const liveIdentity = livePreflight.frozenLineageIdentity ?? null;
  const route = sanctionedRoute(liveIdentity ?? expectedIdentity);
  const base = {
    expectedIdentity,
    liveIdentity,
    checkoutHead,
    queueDecision: livePreflight.queueDecision,
    selectionSource: 'live-repair-head' as const,
    sanctionedRoute: route,
  };

  if (livePreflight.reason === 'queue-unreadable') {
    return {
      ...base,
      allowed: false,
      reason: 'queue-unreadable',
      mismatchedIdentityFields: [],
      detail:
        `frozen_lineage_launch_refused:queue-unreadable: expected ${identityText(expectedIdentity)}; ` +
        `the live queue could not be read immediately before spawn${livePreflight.detail ? ` (${livePreflight.detail})` : ''}. ${route}`,
    };
  }

  if (!expectedIdentity && !liveIdentity) {
    return {
      ...base,
      allowed: true,
      reason: 'no-frozen-queue',
      mismatchedIdentityFields: [],
      detail: 'no frozen queue existed at either server-side read',
    };
  }

  if (!expectedIdentity || !liveIdentity) {
    const reason = expectedIdentity ? 'queue-disappeared' : 'queue-appeared';
    return {
      ...base,
      allowed: false,
      reason,
      mismatchedIdentityFields: ['candidate', 'repairHead', 'queueRevision'],
      detail:
        `frozen_lineage_launch_refused:${reason}: captured ${identityText(expectedIdentity)}; ` +
        `live ${identityText(liveIdentity)} immediately before spawn. ${route}`,
    };
  }

  const marker = {
    candidate: liveIdentity.candidate,
    repairHead: liveIdentity.repairHead,
    updatedAtMs: liveIdentity.queueRevision,
    phase: livePreflight.repairQueue?.phase ?? 'unknown',
    failingPaths: [],
    admittedPaths: [],
    legs: [],
  };
  const policy = evaluateFrozenLineagePolicy(
    {
      operation: 'canonical-verification',
      selectionSource: 'live-repair-head',
      checkoutHead,
      expectedIdentity,
    },
    { marker },
  );
  if (!policy.allowed) {
    return {
      ...base,
      allowed: false,
      reason:
        policy.reason === 'queue-identity-mismatch'
          ? 'queue-identity-mismatch'
          : 'checkout-head-mismatch',
      mismatchedIdentityFields: policy.mismatchedIdentityFields,
      sanctionedRoute: policy.sanctionedRoute,
      detail:
        `frozen_lineage_launch_refused:${policy.reason}: captured ${identityText(expectedIdentity)}; ` +
        `live ${identityText(liveIdentity)}; effective checkout HEAD=${checkoutHead ?? 'unmeasured'}. ` +
        policy.sanctionedRoute,
    };
  }

  if (!livePreflight.proceed) {
    return {
      ...base,
      allowed: false,
      reason: 'queue-not-runnable',
      mismatchedIdentityFields: [],
      detail:
        `frozen_lineage_launch_refused:queue-not-runnable: live ${identityText(liveIdentity)} selected ` +
        `${livePreflight.queueDecision ?? 'an unreadable queue decision'} immediately before spawn. ${route}`,
    };
  }

  return {
    ...base,
    allowed: true,
    reason: 'repair-head-match',
    mismatchedIdentityFields: [],
    detail: `verified ${identityText(liveIdentity)} immediately before spawn`,
  };
}

function currentQuietCutCandidate(predictedCandidate: string | null, root: string): string | null {
  if (predictedCandidate) return predictedCandidate;
  const execFn = (cmd: string, argv: string[]) => {
    const result = spawnSync(cmd, argv, { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return currentCheckpointCandidate(root, execFn).current_candidate;
}

export function resolveRunnableCandidate(
  queueDecision: FrozenRepairQueueDecision,
  /** Retained for call-site symmetry; the frozen branches now read the decision alone. */
  _repairQueue: FrozenCandidateRepairQueue | null,
  predictedCandidate: string | null,
  root: string,
): { candidate: string | null; source: 'frozen-repair-queue' | 'current-quiet-cut' | 'unresolved' } | null {
  if (queueDecision.kind === 'verify-repair') {
    // P-007 / D-004: the repair head is judged AT ITS OWN SHA. This branch used to ask whether
    // canonical staging already contained the repair's patch and fall back to a quiet cut at
    // the moving tip when it did not — which inverted the freeze exactly when it mattered, on a
    // lineage deliberately not yet folded into staging. The lineage is not required to be on
    // staging to be judged; P-008 folds a PROMOTED lineage back into staging afterwards.
    return { candidate: queueDecision.candidate, source: 'frozen-repair-queue' };
  }
  if (queueDecision.kind === 'test-candidate') {
    return { candidate: queueDecision.candidate, source: 'frozen-repair-queue' };
  }
  if (queueDecision.kind === 'run-normal-gate') {
    const candidate = currentQuietCutCandidate(predictedCandidate, root);
    return { candidate, source: candidate ? 'current-quiet-cut' : 'unresolved' };
  }
  return null;
}

/**
 * Read the same persisted queue and fixer liveness used by the detached checkpoint writer.
 * Keeping this read beside the required-ancestor guard prevents the manual launcher from
 * inventing a second queue policy.
 */
async function readFrozenRepairQueueState(): Promise<FrozenRepairQueueState> {
  const [
    { activeWorkspaceId },
    { operatorHomeHarnessSlug },
    { readFrozenCandidateRepairQueue, releaseFixerSpawnAlive },
  ] = await Promise.all([
    import('../workspace-registry'),
    import('../harness/operator-home-harness'),
    import('../harness/routines/release-actions'),
  ]);
  const repairQueue = await readFrozenCandidateRepairQueue({
    workspaceId: activeWorkspaceId(),
    installSlug: operatorHomeHarnessSlug(),
  });

  let fixerAlive: boolean | null = null;
  if (repairQueue?.phase === 'awaiting-fixer' && repairQueue.fixerSpawnId) {
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, repairQueue.fixerSpawnId);
    } catch {
      // Liveness UNKNOWN must preserve the queue and refuse a launch that could short-circuit.
      fixerAlive = null;
    }
  }

  return {
    repairQueue,
    fixerAlive,
    queueDecision: decideFrozenCandidateRepairQueue(repairQueue, { nowMs: Date.now(), fixerAlive }),
  };
}

/**
 * Guard an ordinary detached launch against queue states whose writer returns
 * `repair-in-progress` without running a suite. Initial-candidate and repair verification
 * decisions continue into a suite-producing path, while a definitively dead fixer can be
 * recovered by the detached writer before it re-runs the queue policy. Both are allowed here;
 * every other queue decision refuses before the systemd unit is created. The required-ancestor
 * path intentionally uses `resolveRunnableCandidate` directly, so it remains fail-closed for
 * dead-fixer recovery until a candidate can be proven against the declared ancestor.
 */
export async function assessFrozenRepairQueuePreflight(
  predictedCandidate: string | null = null,
  root = integrationRoot(),
): Promise<FrozenRepairQueuePreflight> {
  let repairQueue: FrozenCandidateRepairQueue | null = null;
  let fixerAlive: boolean | null = null;
  try {
    const state = await readFrozenRepairQueueState();
    repairQueue = state.repairQueue;
    fixerAlive = state.fixerAlive;
    const { queueDecision } = state;
    const suiteProducingDecision =
      queueDecision.kind === 'run-normal-gate' ||
      queueDecision.kind === 'test-candidate' ||
      queueDecision.kind === 'verify-repair';
    const deadFixerRecoveryDecision = queueDecision.kind === 'recover-dead-fixer';
    const progressRunnableDecision = suiteProducingDecision || deadFixerRecoveryDecision;
    const runnableCandidate = suiteProducingDecision
      ? resolveRunnableCandidate(queueDecision, repairQueue, predictedCandidate, root)
      : deadFixerRecoveryDecision
        ? { candidate: queueDecision.repairHead, source: 'frozen-repair-queue' as const }
        : null;
    return {
      proceed: progressRunnableDecision,
      reason: progressRunnableDecision ? 'clear' : 'repair-in-progress',
      candidate: runnableCandidate?.candidate ?? repairQueue?.repairHead ?? null,
      candidateSource: runnableCandidate?.source ?? 'unresolved',
      repairQueue,
      frozenLineageIdentity: repairQueue ? frozenLineageIdentityFromMarker(repairQueue) : null,
      queueDecision: queueDecision.kind,
      nextAttempt: queueDecision.kind === 'dispatch-fixer' ? queueDecision.nextAttempt : null,
      fixerSpawnId: repairQueue?.fixerSpawnId ?? null,
      fixerAlive,
      ...(!progressRunnableDecision
        ? { detail: `frozen repair policy chose ${queueDecision.kind}; the writer will not run a suite` }
        : {}),
    };
  } catch (error) {
    return {
      proceed: false,
      reason: 'queue-unreadable',
      candidate: null,
      candidateSource: 'unresolved',
      repairQueue,
      frozenLineageIdentity: null,
      queueDecision: null,
      nextAttempt: null,
      fixerSpawnId: null,
      fixerAlive,
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    };
  }
}

/**
 * Resolve and verify the candidate a detached checkpoint writer will use when a caller
 * supplies a release-critical required ancestor. The durable eligibility waiter calls this
 * again after its quiet-cut delay, so a deferred launch cannot outlive the caller's lineage
 * guarantee.
 */
export async function assessRequiredAncestorPreflight(
  requiredAncestor: string,
  predictedCandidate: string | null,
  root = integrationRoot(),
): Promise<RequiredAncestorPreflight> {
  let repairQueue: FrozenCandidateRepairQueue | null = null;
  let fixerAlive: boolean | null = null;
  let queueDecision: FrozenRepairQueueDecision;
  try {
    const state = await readFrozenRepairQueueState();
    repairQueue = state.repairQueue;
    fixerAlive = state.fixerAlive;
    queueDecision = state.queueDecision;
  } catch (error) {
    return {
      ok: false,
      reason: 'queue-unreadable',
      requiredAncestor: null,
      candidate: null,
      candidateSource: 'unresolved',
      repairQueue,
      frozenLineageIdentity: repairQueue ? frozenLineageIdentityFromMarker(repairQueue) : null,
      queueDecision: null,
      fixerAlive,
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    };
  }

  const execFn = (cmd: string, argv: string[]) => {
    const result = spawnSync(cmd, argv, { encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  const runnableCandidate = resolveRunnableCandidate(
    queueDecision,
    repairQueue,
    predictedCandidate,
    root,
  );
  if (!runnableCandidate) {
    return {
      ok: false,
      reason: 'queue-not-runnable',
      requiredAncestor: null,
      candidate: null,
      candidateSource: 'unresolved',
      repairQueue,
      frozenLineageIdentity: repairQueue ? frozenLineageIdentityFromMarker(repairQueue) : null,
      queueDecision: queueDecision.kind,
      fixerAlive,
      detail: `frozen repair policy chose ${queueDecision.kind}`,
    };
  }
  const { candidate, source: candidateSource } = runnableCandidate;
  if (!candidate) {
    return {
      ok: false,
      reason: 'unverifiable',
      requiredAncestor: null,
      candidate: null,
      candidateSource,
      repairQueue,
      frozenLineageIdentity: repairQueue ? frozenLineageIdentityFromMarker(repairQueue) : null,
      queueDecision: queueDecision.kind,
      fixerAlive,
    };
  }

  const check = checkpointCandidateContainsAncestor(root, requiredAncestor, candidate, execFn);
  return {
    ...check,
    candidateSource,
    repairQueue,
    frozenLineageIdentity: repairQueue ? frozenLineageIdentityFromMarker(repairQueue) : null,
    queueDecision: queueDecision.kind,
    fixerAlive,
  };
}
