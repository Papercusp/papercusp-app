/**
 * Stable-agent direct dispatch for promoted work-items.
 *
 * This is deliberately a small composite over the existing work-item claim and
 * inbox-wake primitives. It is not a scheduler: callers hand it the concrete ids
 * returned by canonical plan promotion, it re-checks the current execution
 * frontier, persists assignment first, then issues one required wake.
 */
import {
  claimWorkItem,
  explainIssueClaimFloors,
  isClaimHoldParked,
  observeWorkItem,
  looksLikePolicyGate,
  readWorkItemClaimHoldProvenance,
  readUnresolvedDepBlockers,
  type ClaimFloorAttribution,
  type UnresolvedDepBlocker,
  type WorkItem,
  type WorkItemObservation,
} from '../../work-items';
import {
  planItemLaneBlockReason,
  planItemLiveClaimReason,
  type PlanItemLaneBlock,
  type PlanItemLiveClaimBlock,
} from '../../scheduler/plan-item-lane-guard';
import { wakeRecipients, type WakeRecipientsResult } from './inbox-wake';
import { assemblePresenceSnapshot, matchesOwner, resolvePresenceScope } from './presence-snapshot';
import { listSessionsForAgentName, type AdoptionRow } from '../../plan-items/agent-names';
import type { LegacyFleetScopeDowngradeAdmission } from '../../work-item-fleet-scope-recovery';

const UNASSIGNED_FRONTIER_STATES = new Set(['open', 'failing', 'todo']);
const RETAINED_EXECUTION_STATES = new Set([...UNASSIGNED_FRONTIER_STATES, 'wip', 'in_progress', 'validating']);

export type WorkItemDispatchSkipCode =
  | 'not_found'
  | 'read_failed'
  | 'state_not_actionable'
  | 'dependency_blocked'
  | 'plan_lane_blocked'
  | 'plan_lane_claimed'
  | 'claim_hold'
  | 'authority_denied'
  | 'admission_gated'
  | 'held_by_other';

export interface WorkItemDispatchSkip {
  workItemId: string;
  code: WorkItemDispatchSkipCode;
  reason: string;
  holder?: string;
  blockers?: string[];
  /** Canonical issue-family claim-floor attribution, when the readiness read can resolve it. */
  claimFloor?: ClaimFloorAttribution;
  /**
   * Why a claim-hold item is parked and the supported verb that can unblock it.
   * `heldOpen` is the liveness-bound hold_open lease; `parked` is the durable
   * release { claimHold:true } park. Keep both because either can coexist.
   */
  claimHold?: ClaimHoldDispatchDetails;
}

type ClaimHoldProvenance = ReturnType<typeof readWorkItemClaimHoldProvenance>;

export interface ClaimHoldDispatchDetails extends ClaimHoldProvenance {
  /** Typed re-evaluation contract persisted by release { claimHold:true }, when present. */
  releaseContract: Record<string, unknown> | null;
  /** A policy-tier reason needs ownerOverride in addition to force when clearing another holder's hold. */
  policyGate: boolean;
  unblock: {
    tool: 'work_items:hold_open' | 'work_items:release';
    args: {
      id: string;
      clear?: true;
      claimHold?: false;
    };
    note: string;
  };
}

function readClaimHoldReleaseContract(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const release = (payload as Record<string, unknown>).claim_hold_release;
  return release && typeof release === 'object' && !Array.isArray(release)
    ? release as Record<string, unknown>
    : null;
}

export interface WorkItemDispatchClaimFailure {
  workItemId: string;
  code: 'claim_refused' | 'claim_failed';
  reason: string;
}

export interface ActionableWorkItemAssignment {
  ok: boolean;
  targetAgent: string;
  requested: string[];
  actionable: string[];
  assigned: string[];
  /** Idempotent replay: already held by the same stable target and still runnable. */
  retained: string[];
  skipped: WorkItemDispatchSkip[];
  failed: WorkItemDispatchClaimFailure[];
  /** The exact assigned/retained frontier the target may execute after waking. */
  executionWorkItemIds: string[];
}

export interface StableAgentTargetState {
  requested: string;
  ownerId: string;
  present: boolean;
  sessionState: string | null;
  wakeable: boolean | null;
  /** Acting-as user carried by the presence row, when available. */
  userId?: string;
}

export interface StableAgentTargetDeps {
  resolveScope: typeof resolvePresenceScope;
  snapshot: typeof assemblePresenceSnapshot;
  listSessions: typeof listSessionsForAgentName;
}

const defaultTargetDeps: StableAgentTargetDeps = {
  resolveScope: resolvePresenceScope,
  snapshot: assemblePresenceSnapshot,
  listSessions: listSessionsForAgentName,
};

export type RequiredWakeFailureCode = 'target_dead' | 'target_absent' | 'target_unwakeable' | 'wake_delivery_unknown';

export interface RequiredWakeFailure {
  code: RequiredWakeFailureCode;
  target: string;
  recoverable: true;
  queuePreserved: boolean;
  message: string;
}

export interface ActionableWorkItemDispatchResult {
  ok: boolean;
  target: StableAgentTargetState;
  assignment: ActionableWorkItemAssignment;
  wake: WakeRecipientsResult | null;
  failure?: RequiredWakeFailure;
  warning?: string;
}

export interface ActionableWorkItemDispatchDeps {
  observe: (id: string, opts: { harness?: string; revalidateHeld?: boolean; assignee?: string }) => Promise<WorkItemObservation | null>;
  authorize: typeof authorizeWorkItemDispatch;
  claim: (
    id: string,
    assignee: string,
    opts: { harness?: string; legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission },
  ) => Promise<WorkItem | null>;
  /** The same named-id claim-floor oracle used by work_items:claim. */
  explainClaimFloors: typeof explainIssueClaimFloors;
  blockers: (id: string, harness?: string) => Promise<UnresolvedDepBlocker[]>;
  planBlock: (workItem: WorkItem) => Promise<PlanItemLaneBlock | null>;
  planClaim: (workItem: WorkItem) => Promise<PlanItemLiveClaimBlock | null>;
  resolveTarget: (args: {
    targetAgent: string;
    workspaceId?: string;
    harness?: string;
  }) => Promise<StableAgentTargetState>;
  wake: typeof wakeRecipients;
}

const defaultDeps: ActionableWorkItemDispatchDeps = {
  observe: (id, opts) => observeWorkItem(id, opts),
  authorize: authorizeWorkItemDispatch,
  claim: (id, assignee, opts) => claimWorkItem(id, assignee, opts),
  explainClaimFloors: explainIssueClaimFloors,
  blockers: (id, harness) => readUnresolvedDepBlockers(id, harness),
  planBlock: (workItem) => planItemLaneBlockReason(workItem),
  planClaim: (workItem) => planItemLiveClaimReason(workItem),
  resolveTarget: resolveStableAgentTarget,
  wake: wakeRecipients,
};

/** Reuse the claim door's security floors, including the target's effective override.
 * A durable assignment is a receipt, not cached permission for the next replay.
 * Read failures propagate to classifyOne's fail-closed readiness result.
 */
export async function authorizeWorkItemDispatch(args: {
  workItemId: string;
  target: string;
  harness?: string;
  workspaceId?: string;
  actor?: string;
}): Promise<
  | { allowed: true; legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission }
  | { allowed: false; reason: string }
> {
  const { gateWorkScope, readWorkScopePolicy } = await import('../../work-scope-policy');
  const policy = await readWorkScopePolicy(args.workspaceId);
  const workspace = await gateWorkScope('coord:dispatch', {
    harness: args.harness, workItem: args.workItemId, actor: args.target,
  }, policy);
  if (!workspace.allowed) return { allowed: false, reason: workspace.message };
  const { admitWorkItemForFleetTarget } = await import('../../scheduler/fleet-scope-admission');
  const fleet = await admitWorkItemForFleetTarget(args);
  return fleet.allowed
    ? {
        allowed: true,
        ...(fleet.scoped && fleet.legacyFleetScopeDowngradeAdmission
          ? { legacyFleetScopeDowngradeAdmission: fleet.legacyFleetScopeDowngradeAdmission }
          : {}),
      }
    : { allowed: false, reason: fleet.reason };
}

function sameAgent(holder: string | null | undefined, target: string): boolean {
  return Boolean(holder) && holder === target;
}

function blockerIds(rows: UnresolvedDepBlocker[]): string[] {
  return rows.map((row) => row.ref).filter(Boolean);
}

function claimFloorReason(floor: ClaimFloorAttribution): string {
  const retryHint = floor.retry
    ? ` This floor CLEARS ON ITS OWN — typically within ~${Math.round(floor.retry.expectedWithinSec / 60)}m, ` +
      `and at the latest ~${Math.round(floor.retry.guaranteedWithinSec / 60)}m (${floor.retry.basis}).`
    : '';
  const remedyHint = floor.remedy ? ` ${floor.remedy}` : '';
  return (
    `claim floor ${floor.refusedBy ?? 'unknown'}: ${floor.detail ?? 'the item is not claim-path admissible'}.` +
    retryHint +
    remedyHint
  );
}

function claimHoldDetails(workItemId: string, payload: unknown): ClaimHoldDispatchDetails {
  const provenance = readWorkItemClaimHoldProvenance(payload);
  const releaseContract = readClaimHoldReleaseContract(payload);
  const leaseReason = provenance.heldOpen?.reason ?? null;
  const parkReason = provenance.parked?.reason ?? null;
  const policyGate = looksLikePolicyGate(leaseReason) || looksLikePolicyGate(parkReason);
  const hasLease = provenance.heldOpen !== null;
  const hasPark = provenance.parked !== null;

  // A lease-only hold is owned by work_items:hold_open. A durable park is owned by
  // work_items:release. If both conventions are present, release's explicit false
  // clears the complete claim-hold fence in one supported call.
  if (hasLease && !hasPark) {
    return {
      ...provenance,
      releaseContract,
      policyGate,
      unblock: {
        tool: 'work_items:hold_open',
        args: { id: workItemId, clear: true },
        note:
          'Clear the held-open lease with work_items:hold_open { id, clear:true }. ' +
          (policyGate
            ? 'A policy-tier reason also requires ownerOverride:true with force:true when clearing another holder.'
            : 'If another holder owns it, coordinate with them or use the checked force path.'),
      },
    };
  }

  const note = hasLease && hasPark
    ? 'Clear both claim-hold conventions with work_items:release { id, claimHold:false }; verify the resulting row before dispatching.'
    : provenance.attributed
      ? 'Clear the durable park with work_items:release { id, claimHold:false }; verify the resulting row before dispatching.'
      : 'The hold has no recorded provenance; inspect it before clearing with work_items:release { id, claimHold:false }.';
  return {
    ...provenance,
    releaseContract,
    policyGate,
    unblock: {
      tool: 'work_items:release',
      args: { id: workItemId, claimHold: false },
      note: note + (policyGate ? ' A policy-tier reason requires ownerOverride when clearing another holder.' : ''),
    },
  };
}

function claimHoldReason(workItemId: string, details: ClaimHoldDispatchDetails): string {
  const parts: string[] = [];
  if (details.heldOpen) {
    parts.push(`held open by ${details.heldOpen.by}${details.heldOpen.reason ? `: ${details.heldOpen.reason}` : ''}`);
  }
  if (details.parked) {
    parts.push(`durably parked by ${details.parked.by}${details.parked.reason ? `: ${details.parked.reason}` : ''}`);
  }
  const provenance = parts.length > 0 ? parts.join('; ') : 'unattributed (no held_open_by / claim_hold_by)';
  return (
    `work-item carries a claim hold (${provenance}). ` +
    `${details.unblock.note} ` +
    `Suggested call: ${details.unblock.tool} ${JSON.stringify(details.unblock.args)}.`
  );
}

async function classifyOne(
  workItemId: string,
  targetAgent: string,
  harness: string | undefined,
  workspaceId: string | undefined,
  actor: string | undefined,
  deps: ActionableWorkItemDispatchDeps,
): Promise<
  | { kind: 'claim'; workItemId: string; legacyFleetScopeDowngradeAdmission?: LegacyFleetScopeDowngradeAdmission }
  | { kind: 'retained'; workItemId: string }
  | { kind: 'skip'; skipped: WorkItemDispatchSkip }
> {
  let observed: WorkItemObservation | null;
  try {
    observed = await deps.observe(workItemId, {
      ...(harness ? { harness } : {}), revalidateHeld: true, assignee: targetAgent,
    });
  } catch (error) {
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'read_failed',
        reason: `work-item readiness read failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!observed?.item) {
    return {
      kind: 'skip',
      skipped: { workItemId, code: 'not_found', reason: 'work-item was not found' },
    };
  }

  const workItem = observed.item;
  const holder = observed.claimedBy ?? workItem.assignee;
  const retainedByTarget = sameAgent(holder, targetAgent);
  const allowedStates = retainedByTarget ? RETAINED_EXECUTION_STATES : UNASSIGNED_FRONTIER_STATES;
  if (!allowedStates.has(workItem.state)) {
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'state_not_actionable',
        reason: `state '${workItem.state}' is outside the ${retainedByTarget ? 'runnable' : 'claimable'} frontier`,
      },
    };
  }

  let unresolved: UnresolvedDepBlocker[];
  try {
    unresolved = await deps.blockers(workItemId, harness);
  } catch (error) {
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'read_failed',
        reason: `dependency readiness read failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (unresolved.length > 0) {
    const ids = blockerIds(unresolved);
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'dependency_blocked',
        reason: `unresolved work-item blocker${unresolved.length === 1 ? '' : 's'}${ids.length ? `: ${ids.join(', ')}` : ''}`,
        ...(ids.length ? { blockers: ids } : {}),
      },
    };
  }

  // observeWorkItem already resolves these for an unassigned row. A retained
  // row needs the same fresh checks because idempotent replay must not wake work
  // whose plan was edited back behind a blocker after the original assignment.
  let planBlocked = observed.planItemBlocked ?? null;
  let planClaimed = observed.planItemLiveClaimed ?? null;
  if (retainedByTarget) {
    try {
      [planBlocked, planClaimed] = await Promise.all([deps.planBlock(workItem), deps.planClaim(workItem)]);
    } catch (error) {
      return {
        kind: 'skip',
        skipped: {
          workItemId,
          code: 'read_failed',
          reason: `plan-lane readiness read failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
  if (planBlocked) {
    return {
      kind: 'skip',
      skipped: { workItemId, code: 'plan_lane_blocked', reason: planBlocked.reason },
    };
  }
  if (planClaimed && planClaimed.claimedBy !== targetAgent) {
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'plan_lane_claimed',
        reason: planClaimed.reason,
        holder: planClaimed.claimedBy,
      },
    };
  }
  if (isClaimHoldParked(workItem.payload) || observed.claimHoldParked) {
    const claimHold = claimHoldDetails(workItemId, workItem.payload);
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'claim_hold',
        reason: claimHoldReason(workItemId, claimHold),
        claimHold,
      },
    };
  }
  if (holder && !retainedByTarget) {
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: 'held_by_other',
        reason: `already assigned to ${holder}; stable-agent dispatch never force-claims`,
        holder,
      },
    };
  }
  let legacyFleetScopeDowngradeAdmission: LegacyFleetScopeDowngradeAdmission | undefined;
  try {
    const authority = await deps.authorize({
      workItemId, target: targetAgent, actor, harness: harness ?? workItem.harness ?? undefined,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!authority.allowed) return {
      kind: 'skip', skipped: { workItemId, code: 'authority_denied', reason: authority.reason },
    };
    legacyFleetScopeDowngradeAdmission = authority.legacyFleetScopeDowngradeAdmission;
  } catch (error) {
    return {
      kind: 'skip', skipped: {
        workItemId, code: 'read_failed',
        reason: `authority read failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (observed.gated || (!retainedByTarget && !observed.available)) {
    // EI-22008434629323224: preserve the claim path's floors for targeted dispatch,
    // but do not collapse an issue-family refusal into the generic frontier text.
    // Reuse the same named-id oracle as work_items:claim so the caller receives the
    // refused floor, retry bound, and remedy that a later manual claim would reveal.
    let claimFloor: ClaimFloorAttribution | null = null;
    const issueHarness = harness ?? workItem.harness;
    if (observed.gated && workItem.family === 'issue' && issueHarness) {
      try {
        const [floor] = await deps.explainClaimFloors(issueHarness, [workItemId], { assignee: targetAgent });
        claimFloor = floor && !floor.admissible && floor.refusedBy ? floor : null;
      } catch {
        // The diagnostic is fail-soft: a floor-read outage must not change dispatch's
        // refusal or invent a reason the oracle did not establish.
      }
    }
    const admissionPending = observed.admissionPending;
    return {
      kind: 'skip',
      skipped: {
        workItemId,
        code: observed.gated ? 'admission_gated' : 'read_failed',
        reason: observed.operationClaimDenied
          ? `operation claim authority: ${observed.operationClaimDenied}`
          : observed.gated
          ? claimFloor
            ? claimFloorReason(claimFloor)
            : admissionPending
              ? `${admissionPending.reason} ${admissionPending.remedy}`
              : 'work-item is outside the canonical admission frontier'
          : 'work-item is not currently available for assignment',
        ...(claimFloor ? { claimFloor } : {}),
      },
    };
  }
  if (retainedByTarget) return { kind: 'retained', workItemId };
  return {
    kind: 'claim',
    workItemId,
    ...(legacyFleetScopeDowngradeAdmission ? { legacyFleetScopeDowngradeAdmission } : {}),
  };
}

/** Assign only the current execution frontier. No wake occurs in this function. */
export async function assignActionableWorkItems(
  args: {
    workItemIds: readonly string[]; targetAgent: string; actor?: string; harness?: string; workspaceId?: string;
    /** Durable callers reauthorize their original request after readiness I/O. */
    beforeMutate?: (stage: 'claim' | 'wake') => Promise<void>;
  },
  deps: ActionableWorkItemDispatchDeps = defaultDeps,
): Promise<ActionableWorkItemAssignment> {
  const requested = [...new Set(args.workItemIds.map((id) => id.trim()).filter(Boolean))];
  const classified = await Promise.all(requested.map((id) => classifyOne(id, args.targetAgent, args.harness, args.workspaceId, args.actor, deps)));
  const toClaim = classified.filter((r): r is Extract<(typeof classified)[number], { kind: 'claim' }> => r.kind === 'claim');
  const retained = classified
    .filter((r): r is { kind: 'retained'; workItemId: string } => r.kind === 'retained')
    .map((r) => r.workItemId);
  const skipped = classified
    .filter((r): r is { kind: 'skip'; skipped: WorkItemDispatchSkip } => r.kind === 'skip')
    .map((r) => r.skipped);

  const claimResults = await Promise.all(
    toClaim.map(async ({ workItemId, legacyFleetScopeDowngradeAdmission }) => {
      // Authorization/read failures propagate to the durable caller, rather than
      // being misclassified as an ordinary atomic claim refusal.
      await args.beforeMutate?.('claim');
      try {
        const claimed = await deps.claim(workItemId, args.targetAgent, {
          ...(args.harness ? { harness: args.harness } : {}),
          ...(legacyFleetScopeDowngradeAdmission ? { legacyFleetScopeDowngradeAdmission } : {}),
        });
        return claimed
          ? { ok: true as const, workItemId }
          : {
              ok: false as const,
              workItemId,
              code: 'claim_refused' as const,
              reason: 'atomic assignment was refused (claim conflict or admission changed)',
            };
      } catch (error) {
        return {
          ok: false as const,
          workItemId,
          code: 'claim_failed' as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const assigned = claimResults.filter((r) => r.ok).map((r) => r.workItemId);
  const failed = claimResults
    .filter((r): r is Extract<(typeof claimResults)[number], { ok: false }> => !r.ok)
    .map(({ workItemId, code, reason }) => ({ workItemId, code, reason }));
  const hardSkips = new Set<WorkItemDispatchSkipCode>(['not_found', 'read_failed', 'held_by_other', 'authority_denied']);
  const executable = new Set([...assigned, ...retained]);
  const executionWorkItemIds = requested.filter((id) => executable.has(id));
  return {
    ok: failed.length === 0 && !skipped.some((row) => hardSkips.has(row.code)),
    targetAgent: args.targetAgent,
    requested,
    actionable: [...toClaim.map((r) => r.workItemId), ...retained],
    assigned,
    retained,
    skipped,
    failed,
    executionWorkItemIds,
  };
}

/** Resolve the exact stable identity plus the live wakeability state. */
export async function resolveStableAgentTarget(
  args: {
    targetAgent: string;
    workspaceId?: string;
    harness?: string;
  },
  deps: StableAgentTargetDeps = defaultTargetDeps,
): Promise<StableAgentTargetState> {
  try {
    const scope = await deps.resolveScope(
      { workspaceId: args.workspaceId, harnessSlug: args.harness },
      {
        scope: 'workspace',
        targetedOwner: true,
        ...(args.workspaceId ? { workspace: args.workspaceId } : {}),
      },
    );
    const adoptions: AdoptionRow[] = scope.wsId ? await deps.listSessions(scope.wsId, args.targetAgent) : [];
    const candidateOwnerIds = adoptions.length > 0 ? adoptions.map((row) => row.sessionOwnerId) : [args.targetAgent];
    const snapshot = await deps.snapshot(scope, adoptions.length === 0 ? { owner: args.targetAgent } : {});
    const rows = snapshot.active as Array<Record<string, unknown>>;
    const byOwnerId = new Map(
      rows
        .filter((row): row is Record<string, unknown> & { ownerId: string } => typeof row.ownerId === 'string')
        .map((row) => [row.ownerId, row]),
    );
    const adoptedRows = candidateOwnerIds
      .map((ownerId) => byOwnerId.get(ownerId))
      .filter((row): row is Record<string, unknown> & { ownerId: string } => Boolean(row));
    const directRow =
      adoptions.length === 0
        ? (rows.find((candidate) => candidate.ownerId === args.targetAgent) ??
          rows.find((candidate) => matchesOwner(candidate as never, args.targetAgent)))
        : undefined;
    const row = adoptedRows.find((candidate) => candidate.wakeable === true) ?? adoptedRows[0] ?? directRow;
    if (!row) {
      return {
        requested: args.targetAgent,
        ownerId: candidateOwnerIds[0] ?? args.targetAgent,
        present: false,
        sessionState: null,
        wakeable: false,
      };
    }
    return {
      requested: args.targetAgent,
      ownerId: typeof row.ownerId === 'string' ? row.ownerId : args.targetAgent,
      present: true,
      sessionState: typeof row.sessionState === 'string' ? row.sessionState : null,
      wakeable: typeof row.wakeable === 'boolean' ? row.wakeable : null,
      ...(typeof row.userId === 'string' && row.userId.trim() ? { userId: row.userId } : {}),
    };
  } catch {
    return {
      requested: args.targetAgent,
      ownerId: args.targetAgent,
      present: false,
      sessionState: null,
      wakeable: null,
    };
  }
}

export function classifyRequiredWakeFailure(args: {
  target: StableAgentTargetState;
  wake: Pick<WakeRecipientsResult, 'queued' | 'woken' | 'staged' | 'timedOutTargets'>;
  queuePreserved: boolean;
}): RequiredWakeFailure | null {
  const queued = args.wake.queued ?? args.wake.woken ?? 0;
  const target = args.target.ownerId;
  const base = { target, recoverable: true as const, queuePreserved: args.queuePreserved };
  if (args.wake.timedOutTargets.length > 0) {
    return {
      ...base,
      code: 'wake_delivery_unknown',
      message: `required wake delivery for ${target} timed out; assignment is durable but pickup is unknown`,
    };
  }
  if (args.target.sessionState === 'ended' || args.target.sessionState === 'suspect') {
    return {
      ...base,
      code: 'target_dead',
      message: `${target} has sessionState=${args.target.sessionState}; assignment is durable but the target must be relaunched`,
    };
  }
  if (!args.target.present && queued === 0) {
    return {
      ...base,
      code: 'target_absent',
      message: `${target} has no resolvable session; assignment is durable but no live target accepted the wake`,
    };
  }
  if (
    queued === 0 &&
    (args.wake.staged > 0 || args.target.wakeable === false || args.target.sessionState === 'draining')
  ) {
    return {
      ...base,
      code: 'target_unwakeable',
      message: `${target} is present but not required-wakeable (sessionState=${args.target.sessionState ?? 'unknown'}, wakeable=${String(args.target.wakeable)})`,
    };
  }
  if (queued === 0) {
    return {
      ...base,
      code: 'target_absent',
      message: `required wake queued 0 deliveries for ${target}; assignment remains durable for recovery`,
    };
  }
  return null;
}

/**
 * The plan-run callable composite: resolve stable identity, assign only the
 * actionable frontier, then issue one required inbox wake. A zero-frontier
 * result intentionally does not wake the agent.
 */
export async function assignAndWakeActionableWorkItems(
  args: {
    workItemIds: readonly string[];
    targetAgent: string;
    actor?: string;
    workspaceId?: string;
    harness?: string;
    summary?: string;
    /** Authenticated durable caller's original instructions, carried in the wake payload. */
    instructions?: string;
    source?: string;
    /**
     * Default true: a replay re-wakes work already retained by this stable
     * agent. The lane-unblock race passes false because a concurrent settle
     * path may already have assigned+woken the successor; only a newly-won
     * assignment should spend a second wake there.
     */
    wakeRetained?: boolean;
    /** Recheck the original caller immediately before claim and before wake. */
    beforeMutate?: (stage: 'claim' | 'wake') => Promise<void>;
  },
  deps: ActionableWorkItemDispatchDeps = defaultDeps,
): Promise<ActionableWorkItemDispatchResult> {
  const target = await deps.resolveTarget(args);
  const assignment = await assignActionableWorkItems(
    {
      workItemIds: args.workItemIds,
      ...(args.actor ? { actor: args.actor } : {}),
      // Assignment is durable across sessions, so it must remain keyed on the
      // stable adopted name. Only the wake below targets the ephemeral ownerId.
      targetAgent: args.targetAgent,
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.beforeMutate ? { beforeMutate: args.beforeMutate } : {}),
    },
    deps,
  );
  const wakeWorkItemIds = args.wakeRetained === false ? assignment.assigned : assignment.executionWorkItemIds;
  if (wakeWorkItemIds.length === 0) {
    return {
      ok: assignment.ok,
      target,
      assignment,
      wake: null,
      warning:
        assignment.failed.length > 0
          ? 'no work-item assignment landed; target was not woken'
          : args.wakeRetained === false && assignment.retained.length > 0
            ? 'successor was already retained by the stable target; duplicate wake suppressed'
            : 'no currently actionable work-items; blocked/parked descendants remain unassigned and target was not woken',
    };
  }
  await args.beforeMutate?.('wake');
  const wake = await deps.wake([target.ownerId], {
    summary: args.summary ?? `Assigned ${wakeWorkItemIds.length} actionable plan-run work-item(s)`,
    payload: {
      kind: 'actionable-work-item-dispatch',
      workItemIds: wakeWorkItemIds,
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
    },
    source: args.source ?? 'system:plan-run-direct-dispatch',
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
  });
  const failure = classifyRequiredWakeFailure({
    target,
    wake,
    queuePreserved: assignment.executionWorkItemIds.length > 0,
  });
  return {
    ok: assignment.ok && failure === null,
    target,
    assignment,
    wake,
    ...(failure ? { failure, warning: failure.message } : {}),
  };
}
