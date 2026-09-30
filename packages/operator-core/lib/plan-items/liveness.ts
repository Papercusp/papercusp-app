/**
 * plan-item liveness + the claim POLICY coordinator + the merged view.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 2 + Phase 3 view).
 *
 * Three things live here, all sitting ABOVE the low-level lease (claims.ts):
 *
 *  1. LIVENESS MODE (D-003) — `harnessLivenessMode`. A LOCAL harness uses
 *     'availability' (an idle claim only hurts its owner → held while the session is
 *     alive); a SHARED harness uses 'activity' (an idle claim blocks all members →
 *     the lease renews on a completed turn / explicit extend, and lapses on
 *     inactivity). Shared-ness is resolved from harness membership (>1 contributor),
 *     behind a SEAM `setHarnessSharedResolver` that su-584a8's per-user-identity /
 *     harness-membership model swaps in. Default LOCAL — correct on a single box.
 *
 *  2. CLAIM POLICY (D-004/D-005) — `claimPlanItem`. The interplay of the two stores:
 *     an ASSIGNED item may only be claimed by its assignee-NAME (even when currently
 *     unclaimed/lapsed — the assignment anchors it, so a sleeper's work is never
 *     stolen); an UNASSIGNED item is a pool pull, gated by work-group membership when
 *     a work-group is declared (cross-user) and open otherwise (single-user/local).
 *
 *  3. THE MERGED VIEW (Risks: assignment/claim drift) — `mergedPlanItemStates` /
 *     `myItemsWithState`. Assignment (federated source of truth) + claim (authority
 *     source of truth) merged into one coherent per-item disposition.
 */
import { getOrgPg } from '@papercusp/db-org';
import { readPlanBySlug } from '../agent-tools/plans/source';
import {
  getAssignment,
  listAssignmentsForName,
  listAssignmentsForNames,
  listAssignmentsForPlan,
  type PlanItemAssignment,
} from './assignments';
import {
  acquireClaim,
  forceTakeoverClaim,
  getClaim,
  listClaimsForPlan,
  type PlanItemClaim,
  type LivenessMode,
} from './claims';
import { workGroupExists, isWorkGroupMember } from './work-group';
import { projectClaimHolder, type ClaimHolder } from './claim-holder';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  assessForceRelease,
  forceRefusalHint,
  type ForceReleaseBasis,
  type HolderLiveness,
} from '../agent-tools/work_items/release-force-guard';

/** P-029/D-060: the holder projection for a live claim row, or null when unheld.
 *  One helper so `plan_items:status` and `plan_items:my_items` cannot render the
 *  same holder two different ways. */
function holderOfClaim(claim: PlanItemClaim | null): ClaimHolder | null {
  if (!claim) return null;
  return projectClaimHolder({
    ownerId: claim.owner,
    ownerLabel: claim.ownerLabel,
    itemId: claim.itemId,
    intent: claim.intent,
    acquiredTs: claim.acquiredTs,
    lastActivityTs: claim.lastActivityTs,
  });
}

// ── 1. Liveness mode (shared-ness) ──────────────────────────────────────────────

export type HarnessSharedResolver = (workspaceId: string, harnessSlug: string) => Promise<boolean>;

async function defaultSharedResolver(workspaceId: string, harnessSlug: string): Promise<boolean> {
  // A harness is SHARED if >1 distinct contributor (github user) participates in it.
  // This is the v1 heuristic; su-584a8's harness-membership model is the real answer.
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(DISTINCT github_user_id)::int AS n
        FROM harness_shared.contributors
       WHERE harness_slug = ${harnessSlug}
         AND (${workspaceId === '*'} OR workspace_id = ${workspaceId})
    `;
    return (rows[0]?.n ?? 0) > 1;
  } catch {
    return false; // unknown → LOCAL (availability)
  }
}

let sharedResolver: HarnessSharedResolver = defaultSharedResolver;

/** Swap in a real harness-shared resolver (su-584a8's membership model). */
export function setHarnessSharedResolver(r: HarnessSharedResolver): void {
  sharedResolver = r;
}
export function resetHarnessSharedResolver(): void {
  sharedResolver = defaultSharedResolver;
}

/** The liveness mode for a harness: 'activity' if SHARED, else 'availability' (LOCAL). */
export async function harnessLivenessMode(workspaceId: string, harnessSlug: string): Promise<LivenessMode> {
  return (await sharedResolver(workspaceId, harnessSlug)) ? 'activity' : 'availability';
}

// ── 2. Claim policy coordinator ─────────────────────────────────────────────────

export interface ClaimPlanItemOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  ownerUser: string;
  intent?: string;
  /** Force a mode (tests / explicit). Default: resolved from harness shared-ness. */
  livenessMode?: LivenessMode;
  ttlSec?: number;
  /**
   * A tool-layer force guard has already authorized replacing this exact
   * holder. The low-level force-takeover op re-checks the claim_id + owner CAS;
   * this option only carries that authorization into the policy coordinator.
   */
  forceTakeover?: {
    expectedClaimId: string;
    expectedOwner: string;
    basis: ForceReleaseBasis;
    reason: string;
    holderLiveness?: HolderLiveness;
  };
}

/**
 * A force takeover is a TOOL-LAYER decision plus a low-level exact-CAS mutation.
 * Keep the preflight here so plan_items:claim and plan_items:convert cannot drift
 * on the reason/liveness/claim-id contract. This helper deliberately does not
 * decide assignment or work-group eligibility; claimPlanItem remains the sole
 * policy coordinator and checks those gates for both ordinary and forced claims.
 */
export interface PlanItemForceTakeover {
  expectedClaimId: string;
  expectedOwner: string;
  basis: ForceReleaseBasis;
  reason: string;
  holderLiveness?: HolderLiveness;
}

export type PlanItemForcePreflight =
  | { ok: true; current: PlanItemClaim | null; forceTakeover?: PlanItemForceTakeover }
  | {
      ok: false;
      code: 'force_state_unknown' | 'force_requires_reason' | 'force_unauthorized';
      reason: string;
      holder?: PlanItemClaim;
      holderLiveness?: HolderLiveness;
      hint?: string;
    };

/**
 * Prepare a checked cross-holder takeover for a plan-item claim. A force flag is
 * inert for an unclaimed item or the caller's own claim; only a foreign holder
 * requires a reason plus the shared liveness/authority guard. A claim read failure
 * fails closed because an unknown holder must never be treated as a vacancy.
 */
export async function preparePlanItemForceTakeover(opts: {
  force?: boolean;
  reason?: string;
  callerOwnerId: string;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
}): Promise<PlanItemForcePreflight> {
  if (!opts.force) return { ok: true, current: null };

  let current: PlanItemClaim | null;
  try {
    current = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
  } catch (error) {
    return {
      ok: false,
      code: 'force_state_unknown',
      reason: 'the current plan-item claim could not be read, so force was refused before mutation',
      hint:
        `Cannot make a force decision for ${opts.planSlug}#${opts.itemId} because its holder state is unknown ` +
        `(${error instanceof Error ? error.message : String(error)}). Retry after checking coordination-store health.`,
    };
  }

  if (!current || current.owner === opts.callerOwnerId) return { ok: true, current };

  const reason = opts.reason?.trim() ?? '';
  if (!reason) {
    return {
      ok: false,
      code: 'force_requires_reason',
      reason: `force would replace ${current.owner}'s plan-item claim — a reason is required`,
      holder: current,
      hint: `force would replace ${current.owner}'s claim — pass a \`reason\` the holder and owner can audit (EI-21618203307569668).`,
    };
  }

  const verdict = await assessForceRelease({
    callerOwnerId: opts.callerOwnerId,
    holderOwnerId: current.owner,
    workspaceId: opts.workspaceId,
    // Plan-item claims have no separate progress column. The claim's activity
    // timestamp is the safest available lower-bound progress signal.
    itemLastProgressAt: current.lastActivityTs,
  });
  if (!verdict.allowed) {
    return {
      ok: false,
      code: 'force_unauthorized',
      reason: `force was refused because ${current.owner} still has a live plan-item claim`,
      holder: current,
      holderLiveness: verdict.holderLiveness,
      hint: forceRefusalHint(current.owner),
    };
  }

  return {
    ok: true,
    current,
    forceTakeover: {
      expectedClaimId: current.claimId,
      expectedOwner: current.owner,
      basis: verdict.basis as ForceReleaseBasis,
      reason,
      holderLiveness: verdict.holderLiveness,
    },
  };
}

/** EI-7189: surfaced when the item's PREVIOUS claim had just lapsed (TTL-expired,
 *  not released) yet its owner still looks alive — the WI-2086 double-start
 *  signature (a busy agent's claim ages out from under them while they keep
 *  working, and the next claimant sails in with zero warning). Advisory only:
 *  never blocks the claim, just tells the new holder to coordinate first. */
export interface PriorHolderWarning {
  owner: string;
  ownerLabel: string | null;
  sessionState: SessionState;
  note: string;
}

/**
 * PURE: should a just-stolen LAPSED claim warn the new claimant that its previous
 * owner still looks alive? Exported for unit tests — the presence/wakeability FETCH
 * that produces `priorSessionState` is the untested IO seam (best-effort, mirrors
 * presence-wakeability.ts's own fetchWakeability/deriveSessionState split: the
 * decision is pure, the lookup is glue).
 */
export function priorHolderStillLive(
  priorClaim: Pick<PlanItemClaim, 'owner' | 'expired'> | null,
  callerOwner: string,
  priorSessionState: SessionState | null,
): boolean {
  if (!priorClaim || !priorClaim.expired) return false; // nothing lapsed to warn about
  if (priorClaim.owner === callerOwner) return false; // reclaiming your OWN lapsed lease
  return priorSessionState === 'live' || priorSessionState === 'parked';
}

/** IO glue: this owner's coordinator-facing session state, or null when presence
 *  is unknown (no row / a lookup failure) — treated as "can't tell", never a warning. */
async function sessionStateForOwner(ownerId: string): Promise<SessionState | null> {
  try {
    // Unification P-003: ONE derivation via the shared oracle — the old
    // hand-rolled call fed no hardStale, so a reboot-killed holder with a
    // zombie wake-await read `parked` here and triggered a takeover warning
    // for a dead session (the F2 bug class).
    const { resolveSessionStates } = await import('../agent-tools/coordination/liveness-oracle');
    const verdicts = await resolveSessionStates([{ ownerId }], { hydratePerId: true });
    return verdicts.get(ownerId)?.sessionState ?? null;
  } catch {
    return null; // best-effort — never blocks or fails the claim
  }
}

/**
 * P-006 (agent-trap-guards-2026-07-26): notify the holder of a work-item that
 * IMPLEMENTS this plan item when the plan item is claimed by someone else —
 * the "notify" half of closing "holding the linked work-item is not holding
 * the plan item" (the passive readback half lives in
 * scheduler/plan-item-claim-collision.ts, read at `work_items:get`).
 *
 * Fires on EVERY successful claim, but is a no-op in the overwhelming common
 * case (an unconverted item has no implementing work-item yet, or the
 * claimant IS the work-item's own assignee re-claiming). It DOES also fire on
 * a legitimate convert-at-pickup resume of a lapsed peer's claim (convert.ts
 * §2) — that is intentional, not a false positive: it is exactly the same
 * advisory shape as `priorHolderWarning` above (a heads-up to a possibly-still
 * -alive prior holder), and is the earliest possible point to warn them,
 * instead of only at close time via a `conflict` (the incident this closes).
 *
 * Best-effort: a lookup/send failure never blocks or fails the claim. Uses a
 * dynamic import of `./convert` to avoid the module cycle (convert.ts
 * statically imports `claimPlanItem` from this file).
 */
export async function notifyImplementingWorkItemHolderOfCollision(opts: ClaimPlanItemOpts): Promise<void> {
  try {
    const [{ findImplementingWorkItem, TERMINAL_WORK_ITEM_STATES }, { sendMessage }] = await Promise.all([
      import('./convert'),
      import('../agent-tools/coordination/messages'),
    ]);
    const wi = await findImplementingWorkItem(opts.planSlug, opts.itemId);
    if (!wi || !wi.assignee || wi.assignee === opts.owner) return;
    if (TERMINAL_WORK_ITEM_STATES.has(wi.state)) return; // no one is actively executing a closed record
    const identity: AgentIdentity = {
      ownerId: 'system:plan-item-claim-collision',
      ownerLabel: 'system:plan-item-claim-collision',
      source: 'static-client' as const,
      workspaceId: opts.workspaceId,
      userId: null,
    };
    await sendMessage(identity, {
      to: [wi.assignee],
      summary:
        `Plan item ${opts.planSlug}#${opts.itemId} — your work-item ${wi.id} implements it — was just claimed by ` +
        `${opts.ownerLabel ?? opts.owner}. Holding the linked work-item is not holding the plan item: you may be ` +
        `mid-execution on an item that is no longer (solely) yours. Coordinate with them before continuing to ` +
        `avoid duplicated work.`,
      category: 'plan-item-claim-collision',
      harnessSlug: opts.harnessSlug,
      extra: {
        auto: true,
        lifecycle: 'plan-item-claim-collision',
        plan_slug: opts.planSlug,
        item_id: opts.itemId,
        work_item_id: wi.id,
        claimed_by: opts.owner,
      },
    });
  } catch {
    /* best-effort — never blocks the claim */
  }
}

export type LinkedClaimHold = {
  workItemId: string;
  provenance: {
    heldOpen: { by: string; reason: string | null; at: string | null } | null;
    parked: { by: string; reason: string | null; at: string | null } | null;
    attributed: boolean;
  };
};

export type ClaimPlanItemResult =
  | {
      status: 'claimed';
      claim: PlanItemClaim;
      mode: LivenessMode;
      viaAssignment: boolean;
      priorHolderWarning?: PriorHolderWarning;
      forced?: {
        holder: string;
        basis: ForceReleaseBasis;
        reason: string;
        holderLiveness?: HolderLiveness;
      };
    }
  | { status: 'conflict'; conflict: PlanItemClaim }
  | {
      status: 'refused';
      reason: string;
      assignee?: string;
      holder?: PlanItemClaim;
      holderLiveness?: HolderLiveness;
      hint?: string;
      claimHold?: LinkedClaimHold;
    };

/**
 * EI-23133179677607394: a plan-item claim must honor the claim-hold on its
 * linked execution record. `convertPlanItem` has a later check for this, but
 * `coord:declare-intent` reaches `claimPlanItem` through `claimForWork` and
 * otherwise acquires the plan lease before it ever reaches conversion.
 *
 * Keep the lookup dynamic: convert.ts imports this module for claimPlanItem.
 * A missing/broken implements link is treated as no linked hold, preserving
 * the existing optional-link behavior of the merged view; a found non-terminal
 * held record is a deliberate park and blocks the pre-lease claim.
 */
async function parkedImplementingWorkItem(
  planSlug: string,
  itemId: string,
): Promise<LinkedClaimHold | null> {
  try {
    const [
      { findImplementingWorkItem, TERMINAL_WORK_ITEM_STATES },
      { isClaimHoldParked, readWorkItemClaimHoldProvenance },
    ] = await Promise.all([
      import('./convert'),
      import('../work-items'),
    ]);
    const workItem = await findImplementingWorkItem(planSlug, itemId);
    if (
      !workItem ||
      TERMINAL_WORK_ITEM_STATES.has(workItem.state) ||
      !isClaimHoldParked(workItem.payload)
    ) {
      return null;
    }
    return {
      workItemId: workItem.id,
      provenance: readWorkItemClaimHoldProvenance(workItem.payload),
    };
  } catch {
    // An implementing record is optional for an unconverted plan item. Keep
    // the established fail-open behavior if its best-effort lookup is down.
    return null;
  }
}

/**
 * Take the live claim on a plan item, enforcing the assignment + work-group policy,
 * then leasing via the authority-mediated store.
 */
export async function claimPlanItem(opts: ClaimPlanItemOpts): Promise<ClaimPlanItemResult> {
  const mode = opts.livenessMode ?? (await harnessLivenessMode(opts.workspaceId, opts.harnessSlug));

  const assignment = await getAssignment(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);

  let viaAssignment = false;
  if (assignment?.assigneeName) {
    // Assigned → only the assignee-NAME may claim, even when currently unclaimed/lapsed (D-004).
    // EI-2299: `assigneeName` is not always a genuinely-ADOPTED stable name — a push
    // assignment made programmatically (a coordinator loop, plan_items:assign called
    // with a target's raw ownerId as `assignee`) stores that raw ownerId AS the
    // "name", since the assigner has no other handle on the target. The assignee's
    // OWN session, having never called plan_items:adopt_name, then resolves
    // opts.ownerName === null and is refused claiming an item that is unambiguously
    // theirs. So a caller matches the assignment on EITHER identity axis: their
    // adopted name (the intended, stable path) OR their raw ownerId (the fallback
    // that makes "assigned to ownerId X" and "claimed by ownerId X" the same
    // identity, which is what an ownerId-keyed assignment always meant in practice).
    const acting = [opts.ownerName, opts.owner].filter((n): n is string => !!n);
    if (!acting.includes(assignment.assigneeName)) {
      return {
        status: 'refused',
        reason: `plan item ${opts.itemId} is assigned to '${assignment.assigneeName}' — only that agent-name (or that ownerId) may claim it`,
        assignee: assignment.assigneeName,
      };
    }
    viaAssignment = true;
  } else {
    // Unassigned → a pool pull. Gate cross-user pulls on work-group membership; a
    // plan with no declared work-group is open (single-user / local, D-005).
    if (await workGroupExists(opts.workspaceId, opts.harnessSlug, opts.planSlug)) {
      const member = await isWorkGroupMember(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.ownerUser);
      if (!member) {
        return {
          status: 'refused',
          reason: `plan item ${opts.itemId} is unassigned and this plan has a work-group — join it to pull (plan_items:join_group)`,
        };
      }
    }
  }

  const parked = await parkedImplementingWorkItem(opts.planSlug, opts.itemId);
  if (parked) {
    return {
      status: 'refused',
      reason:
        `work item ${parked.workItemId} is parked by claimHold; clear the claim hold explicitly ` +
        'before claiming this plan item again',
      claimHold: parked,
    };
  }

  // A force takeover is authorized by the tool layer, where the caller's
  // identity/liveness/authority can be checked. Assignment and work-group policy
  // was intentionally evaluated ABOVE this branch: force changes only the
  // holder-CAS leg, never who is entitled to claim the plan item.
  if (opts.forceTakeover) {
    const takeover = await forceTakeoverClaim({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      planSlug: opts.planSlug,
      itemId: opts.itemId,
      owner: opts.owner,
      ownerLabel: opts.ownerLabel,
      ownerName: opts.ownerName,
      intent: opts.intent,
      livenessMode: mode,
      ttlSec: opts.ttlSec,
      expectedClaimId: opts.forceTakeover.expectedClaimId,
      expectedOwner: opts.forceTakeover.expectedOwner,
    });
    if (!takeover.ok) return { status: 'conflict', conflict: takeover.conflict };
    await notifyImplementingWorkItemHolderOfCollision(opts);
    return {
      status: 'claimed',
      claim: takeover.claim,
      mode,
      viaAssignment,
      forced: {
        holder: opts.forceTakeover.expectedOwner,
        basis: opts.forceTakeover.basis,
        reason: opts.forceTakeover.reason,
        ...(opts.forceTakeover.holderLiveness ? { holderLiveness: opts.forceTakeover.holderLiveness } : {}),
      },
    };
  }

  // EI-7189: peek at any prior claim BEFORE stealing it — best-effort, advisory
  // only. A presence-check failure (or the prior claim simply not existing / not
  // lapsed / same owner) never blocks anything; it only ever adds a warning field.
  let priorHolderWarning: PriorHolderWarning | undefined;
  try {
    const prior = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
    if (prior && prior.expired && prior.owner !== opts.owner) {
      const state = await sessionStateForOwner(prior.owner);
      if (priorHolderStillLive(prior, opts.owner, state)) {
        priorHolderWarning = {
          owner: prior.owner,
          ownerLabel: prior.ownerLabel,
          sessionState: state as SessionState,
          note:
            `plan item ${opts.itemId}'s previous claim lapsed (TTL) but its owner ` +
            `'${prior.ownerLabel ?? prior.owner}' still looks ${state} — coordinate before ` +
            `continuing (they may be mid-build/mid-edit; a TTL lapse does not mean they stopped).`,
        };
      }
    }
  } catch {
    /* advisory-only — never blocks the claim */
  }

  const res = await acquireClaim({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    owner: opts.owner,
    ownerLabel: opts.ownerLabel,
    ownerName: opts.ownerName,
    intent: opts.intent,
    livenessMode: mode,
    ttlSec: opts.ttlSec,
  });
  if (res.ok) {
    await notifyImplementingWorkItemHolderOfCollision(opts);
    return { status: 'claimed', claim: res.claim, mode, viaAssignment, priorHolderWarning };
  }
  return { status: 'conflict', conflict: res.conflict };
}

// ── 3. The merged per-item view ─────────────────────────────────────────────────

export type PlanItemDisposition =
  | 'pooled' // unassigned + no live claim → open to pull
  | 'assigned-idle' // assigned + no live claim → awaiting its assignee (or lapsed back to it)
  | 'active' // assigned + live claim held by the assignee
  | 'claimed-pooled' // unassigned + live claim → pulled from the pool
  | 'claimed-mismatch'; // assigned + live claim held by someone who is NOT the assignee (drift)

export interface MergedPlanItemState {
  itemId: string;
  /** The plan item's effective status (todo/wip/…); null if the id isn't in the plan (orphan record). */
  itemStatus: string | null;
  /** Structured plan-DAG dependencies. Empty for roots and orphan records. */
  blockedBy: string[];
  disposition: PlanItemDisposition;
  assignment: PlanItemAssignment | null;
  /** The live claim (a lapsed/expired claim is reported as null — it no longer holds). */
  claim: PlanItemClaim | null;
  /** P-029/D-060: WHO holds it and WHY, in the shape every non-conflict reader
   *  renders — the claim's declared goal (or an honest `goalUnknown`) plus
   *  staleness. Null when unheld. Projected from `claim`, so it adds no read. */
  holder: ClaimHolder | null;
  /**
   * The work-item execution record linked to this plan item, when one exists.
   * This is deliberately separate from `disposition`: a claim-hold is a
   * work-item self-select floor and must not rewrite the plan-item assignment /
   * lease vocabulary (EI-22024943221800341).
   *
   * The lookup is best-effort. A missing or temporarily unreadable link leaves
   * this field null so the established assignment/claim view remains usable.
   */
  implementingWorkItem: ImplementingWorkItemState | null;
  inPlan: boolean;
}

/** The status and canonical claim-hold provenance of a linked execution record. */
export interface ImplementingWorkItemState {
  id: string;
  state: string;
  claimHold: boolean;
  claimHoldBy: string | null;
  claimHoldReason: string | null;
  claimHoldAt: string | null;
  /** Both supported provenance conventions, as returned by the canonical reader. */
  provenance: {
    heldOpen: { by: string; reason: string | null; at: string | null } | null;
    parked: { by: string; reason: string | null; at: string | null } | null;
    attributed: boolean;
  };
}

/**
 * Read the linked execution record without making the plan-item liveness module
 * statically depend on convert.ts (convert.ts imports claimPlanItem from here).
 * The optional read intentionally fails open: status' existing assignment/claim
 * projection must not disappear because a historical implements edge is broken.
 */
async function implementingWorkItemState(planSlug: string, itemId: string): Promise<ImplementingWorkItemState | null> {
  try {
    const [{ findImplementingWorkItem }, { isClaimHoldParked, readWorkItemClaimHoldProvenance }] = await Promise.all([
      import('./convert'),
      import('../work-items'),
    ]);
    const workItem = await findImplementingWorkItem(planSlug, itemId);
    if (!workItem) return null;

    const provenance = readWorkItemClaimHoldProvenance(workItem.payload);
    // A record can carry both conventions while a liveness-bound lease coexists
    // with a durable park. Prefer the lease for the flattened compatibility
    // fields; `provenance` preserves both sources without losing information.
    const selected = provenance.heldOpen ?? provenance.parked;
    return {
      id: workItem.id,
      state: workItem.state,
      claimHold: isClaimHoldParked(workItem.payload),
      claimHoldBy: selected?.by ?? null,
      claimHoldReason: selected?.reason ?? null,
      claimHoldAt: selected?.at ?? null,
      provenance,
    };
  } catch {
    return null;
  }
}

function disposition(assignment: PlanItemAssignment | null, liveClaim: PlanItemClaim | null): PlanItemDisposition {
  const assignee = assignment?.assigneeName ?? null;
  if (liveClaim) {
    if (!assignee) return 'claimed-pooled';
    // EI-2299: mirror claimPlanItem's identity match — the claimant matches the
    // assignment via EITHER their adopted name (ownerName) OR their raw ownerId
    // (owner), since an assignment's `assigneeName` may itself be a raw ownerId.
    const isAssignee = liveClaim.ownerName === assignee || liveClaim.owner === assignee;
    return isAssignee ? 'active' : 'claimed-mismatch';
  }
  return assignee ? 'assigned-idle' : 'pooled';
}

/** Per-item merged disposition for every item in a plan (+ any orphan assignment/claim records). */
export async function mergedPlanItemStates(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<MergedPlanItemState[]> {
  const read = await readPlanBySlug(planSlug, { harnessSlug });
  const planItems = read
    ? read.row.items.length > 0
      ? read.row.items.map((i) => ({ id: i.id, status: i.status, blockedBy: i.blockedBy }))
      : read.parsed.items.map((i) => ({
          id: i.id,
          status: i.storedStatus as string,
          blockedBy: i.blockedBy,
        }))
    : [];

  const [assignments, claims] = await Promise.all([
    listAssignmentsForPlan(workspaceId, harnessSlug, planSlug),
    listClaimsForPlan(workspaceId, harnessSlug, planSlug),
  ]);
  const aByItem = new Map(assignments.map((a) => [a.itemId, a]));
  const cByItem = new Map(claims.map((c) => [c.itemId, c]));

  const ids = new Set<string>();
  for (const i of planItems) ids.add(i.id);
  for (const a of assignments) ids.add(a.itemId);
  for (const c of claims) ids.add(c.itemId);

  // Keep this optional join separate from the assignment/claim reads. The
  // implementing record is useful status context, but a stale/missing link
  // must not make the established liveness projection fail closed.
  const implementingByItem = new Map(
    await Promise.all(
      [...ids].map(async (id) => [id, await implementingWorkItemState(planSlug, id)] as const),
    ),
  );

  const planStatus = new Map(planItems.map((i) => [i.id, i.status] as const));
  const planBlockers = new Map(planItems.map((i) => [i.id, i.blockedBy] as const));
  const out: MergedPlanItemState[] = [];
  for (const id of [...ids].sort()) {
    const assignment = aByItem.get(id) ?? null;
    const claimRow = cByItem.get(id) ?? null;
    const liveClaim = claimRow && !claimRow.expired ? claimRow : null;
    out.push({
      itemId: id,
      itemStatus: planStatus.has(id) ? (planStatus.get(id) ?? null) : null,
      blockedBy: planBlockers.get(id) ?? [],
      disposition: disposition(assignment, liveClaim),
      assignment,
      claim: liveClaim,
      holder: holderOfClaim(liveClaim),
      implementingWorkItem: implementingByItem.get(id) ?? null,
      inPlan: planStatus.has(id),
    });
  }
  return out;
}

export interface MyItemState {
  assignment: PlanItemAssignment;
  claim: PlanItemClaim | null;
  /** P-029/D-060 — see {@link MergedPlanItemState.holder}. Non-null here whenever
   *  a live claim exists, INCLUDING the `claimed-mismatch` case where the holder
   *  is a peer rather than the assignee: that is precisely the reader who needs to
   *  see the goal without colliding. */
  holder: ClaimHolder | null;
  disposition: PlanItemDisposition;
}

/** Pair each assignment with its live claim + merged disposition (shared by
 *  myItemsWithState / myItemsWithStateForIdentities). */
async function pairAssignmentsWithClaims(workspaceId: string, assignments: PlanItemAssignment[]): Promise<MyItemState[]> {
  const out: MyItemState[] = [];
  for (const a of assignments) {
    const claimRow = await getClaim(workspaceId, a.harnessSlug, a.planSlug, a.itemId);
    const liveClaim = claimRow && !claimRow.expired ? claimRow : null;
    out.push({
      assignment: a,
      claim: liveClaim,
      holder: holderOfClaim(liveClaim),
      disposition: disposition(a, liveClaim),
    });
  }
  return out;
}

/** Active assignments to an agent-name across all plans, each with its live claim state. */
export async function myItemsWithState(workspaceId: string, agentName: string): Promise<MyItemState[]> {
  const assignments = await listAssignmentsForName(workspaceId, agentName);
  return pairAssignmentsWithClaims(workspaceId, assignments);
}

/**
 * EI-15910: the identity-axis counterpart to myItemsWithState. An assignment's
 * assignee_name is sometimes a stable adopted agent-NAME and sometimes a raw
 * ownerId (EI-2299 — a coordinator with no better handle on its target, e.g.
 * coord:dispatch, assigns directly to that ownerId); claimPlanItem/disposition()
 * already match on either axis, so a caller reading "my items" must too, or an
 * item assigned straight to its own ownerId is invisible until it happens to
 * adopt that exact string as a "name". Pass every identity the caller might be
 * assigned under (its adopted name, if any, plus its raw ownerId) to see the
 * union — never throws for a caller with no adopted name (an empty/one-identity
 * list is a normal, valid case, mirroring claim's graceful degrade).
 */
export async function myItemsWithStateForIdentities(workspaceId: string, identities: string[]): Promise<MyItemState[]> {
  const uniq = [...new Set(identities.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (uniq.length === 0) return [];
  const assignments = await listAssignmentsForNames(workspaceId, uniq);
  return pairAssignmentsWithClaims(workspaceId, assignments);
}
