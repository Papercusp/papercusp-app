/**
 * arm-reversible-work-item — the `work_items` wiring of the P-114 arming seam
 * (queen-autonomy-policy-2026-06-13 P-114). The two canonical reversible Queen
 * actions — `work_items:set_state` and `work_items:set_priority` — wire their
 * arming through here so the logic (autonomous-only · gate-first · faithful
 * prior-state handle) lives once.
 *
 * FLOW (two-phase, matching arm-reversible-action.ts):
 *   1. {@link planWorkItemArm} runs BEFORE the mutation: skip unless the caller is
 *      an autonomous fleet agent (a human/SU/operator deliberately steering must
 *      NOT be auto-watched), run the decider gate, and — only if it rules `auto` —
 *      capture the work-item's PRIOR state and build the revert-handle. Returns
 *      `null` (the common case: human caller, disarmed policy, or never-auto
 *      ceiling) so the verb proceeds unchanged.
 *   2. {@link commitWorkItemArm} runs AFTER a committed mutation: record the `act`
 *      disposition + arm the revert-watch, linked by the shared decisionId.
 *
 * BEST-EFFORT: callers MUST `.catch()` both phases — a safety-net write can never
 * fail the underlying verb. BEHAVIOR-NEUTRAL until the owner arms AND lowers a
 * reversible category's ceiling (D-007).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { isAutonomousAgent } from '../coordination/agent-question-gate';
import { getWorkItem, type WorkItem } from '../../work-items';
import {
  planReversibleArm,
  commitReversibleArm,
  type ArmReversibleDeps,
  type ReversibleArmProvenance,
} from '../../autonomy/arm-reversible-action';
import type { AutonomyDecision } from '../../autonomy/decider';
import type { RevertHandle } from '../../autonomy/tripwire/core';
import type { RiskTier, Authority } from '@papercusp/plan-parser';

/**
 * The decision-context an autonomous agent declares when it auto-takes a reversible
 * work-item action — the per-item risk the gate's risk half needs (the verb itself
 * has no item risk; emit.ts keeps action risk NULL by design). Same shape as
 * `chat:ask_choice`'s `decision` arg. Absent ⇒ fail-safe `critical` (conservative).
 */
export interface DeclaredDecisionContext {
  riskTier?: RiskTier;
  authority?: Authority;
}

/** Which reversible facet of a work-item the action changed (→ the revert-handle kind). */
export type ReversibleWorkItemFacet = 'state' | 'priority';

/** Loose ctx shape: the identity fields + the ledger-provenance fields. */
export interface ArmReversibleCtx extends ResolveIdentityCtx {
  role?: string | null;
  spawnId?: string | null;
  transport?: string | null;
}

/** Injected IO (tests pass fakes; prod resolves the live org PG + work-item reader). */
export interface WorkItemArmIo {
  resolveSql: () => Sql;
  readWorkItem: (id: string, harness?: string) => Promise<WorkItem | null>;
  /** Forwarded to plan/commit (decider + disposition + tripwire writers). */
  arm?: ArmReversibleDeps;
}

function liveIo(): WorkItemArmIo {
  return {
    resolveSql: () => getOrgPg().sql,
    readWorkItem: (id, harness) => getWorkItem(id, harness),
  };
}

/** Build the B-16 revert-handle from a work-item's PRIOR state (the BUILTIN_REVERTERS contract). */
export function buildWorkItemRevertHandle(
  facet: ReversibleWorkItemFacet,
  prior: WorkItem,
  harness?: string,
): RevertHandle {
  const base = { id: prior.id, ...(harness ? { harness } : {}) };
  return facet === 'state'
    ? { kind: 'work-item-state', ...base, priorState: prior.state }
    : { kind: 'work-item-priority', ...base, priorPriority: prior.priority };
}

/** A planned arming, carried from {@link planWorkItemArm} to {@link commitWorkItemArm}. */
export interface WorkItemArmPlan {
  sql: Sql;
  workspaceId: string;
  decision: AutonomyDecision;
  revertHandle: RevertHandle;
  itemRef: string;
  harnessSlug: string | null;
  provenance: ReversibleArmProvenance;
  io: WorkItemArmIo;
}

/**
 * PHASE 1 (pre-mutation). Returns a plan IFF: the caller is an autonomous fleet
 * agent, the decider rules the action `auto`, and the work-item's prior state could
 * be read. Otherwise `null` (the verb proceeds with no arming). Throws nothing the
 * caller can't `.catch()`.
 */
export async function planWorkItemArm(
  ctx: ArmReversibleCtx,
  action: string,
  facet: ReversibleWorkItemFacet,
  workItemId: string,
  harness: string | undefined,
  declared?: DeclaredDecisionContext,
  io: WorkItemArmIo = liveIo(),
): Promise<WorkItemArmPlan | null> {
  // Autonomous-only: a human/SU/operator's deliberate steering is not auto-watched.
  let identity;
  try {
    identity = resolveAgentIdentity(ctx);
  } catch {
    return null; // unattributable ctx — never arm
  }
  if (!isAutonomousAgent(identity)) return null;

  const workspaceId = identity.workspaceId ?? ctx.workspaceId ?? null;
  if (!workspaceId) return null;

  const sql = io.resolveSql();
  // Gate FIRST (cheap on the disarmed path) — null unless posture is `auto`. The
  // declared per-item risk/authority is what makes the verdict faithful to the
  // upstream decision (the verb has no inherent item risk).
  const decision = await planReversibleArm(
    sql,
    workspaceId,
    {
      action,
      ...(declared?.riskTier != null ? { riskTier: declared.riskTier } : {}),
      ...(declared?.authority != null ? { authority: declared.authority } : {}),
    },
    io.arm,
  );
  if (!decision) return null;

  // Now (and only now) capture the PRIOR state for a faithful revert-handle.
  const prior = await io.readWorkItem(workItemId, harness);
  if (!prior) return null;

  return {
    sql,
    workspaceId,
    decision,
    revertHandle: buildWorkItemRevertHandle(facet, prior, harness),
    itemRef: workItemId,
    harnessSlug: ctx.harnessSlug ?? prior.harness ?? null,
    provenance: {
      actorRole: ctx.role ?? null,
      actorSpawnId: ctx.spawnId ?? identity.ownerId ?? null,
      actorPrincipal: ctx.principal?.slug ?? null,
      transport: ctx.transport ?? null,
    },
    io,
  };
}

/** PHASE 2 (post-mutation). Record the `act` disposition + arm the revert-watch. */
export async function commitWorkItemArm(plan: WorkItemArmPlan): Promise<void> {
  await commitReversibleArm(
    plan.sql,
    plan.workspaceId,
    plan.decision,
    {
      revertHandle: plan.revertHandle,
      itemRef: plan.itemRef,
      harnessSlug: plan.harnessSlug,
      provenance: plan.provenance,
    },
    plan.io.arm,
  );
}
