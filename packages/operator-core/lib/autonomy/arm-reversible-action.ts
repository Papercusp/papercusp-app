/**
 * arm-reversible-action — THE P-114 execution-layer call-site seam
 * (queen-autonomy-policy-2026-06-13 P-114; D-006 / D-025 / D-030).
 *
 * B-16 built the auto-revert tripwire + the real executor (revert-executor.ts,
 * D-030); B-12 built the decider gate; B-13 built the disposition ledger. The ONE
 * piece left was the CALL SITE: nothing invoked `armTripwireForDecision` after an
 * autonomous agent auto-took a reversible action, so the safety net was never
 * actually armed. This is that call site, factored as a small reusable helper the
 * canonical reversible-action verbs call.
 *
 * TWO-PHASE so the revert-handle is FAITHFUL and the disarmed hot path is cheap:
 *   - {@link planReversibleArm} runs the SAME D-004 gate (`resolveAutonomyDecision`,
 *     B-12) BEFORE the mutation and returns the decision IFF the verdict is `auto`
 *     (else `null` — a no-op). The caller captures the action's PRIOR state only
 *     when a plan comes back, so the prior-state read never runs on the common
 *     `gated`/disarmed path.
 *   - {@link commitReversibleArm} runs AFTER the mutation: it records an `act`
 *     disposition row (B-13) and arms the revert-watch (`armTripwireForDecision`,
 *     B-16) threaded with the disposition row's id as the SHARED `decisionId`, so
 *     the recent-auto-decisions feed's read-side LEFT-JOIN (decision_ledger ↔
 *     autonomy_tripwires.decision_id, mig 269 — su-4e592's read.ts) lights up the
 *     per-row one-click undo.
 *
 * BEHAVIOR-NEUTRAL until armed (D-007): while the policy is disarmed OR the action's
 * category ceiling is `never-auto` (the shipped default for every category), the
 * gate is `gated` for every input, so `planReversibleArm` returns `null` and NOTHING
 * fires. It only starts arming once the owner deliberately lowers a reversible
 * category's ceiling AND graduation earns up within it (D-005).
 *
 * BEST-EFFORT (fail-open): this is a SAFETY-NET write, never part of the action's
 * own success. Callers MUST wrap it so a throw here can never fail the underlying
 * verb (mirroring the decision-ledger emit + every other autonomy write).
 *
 * WIRED INTO: the reversible Queen actions whose revert-handle kinds the B-16
 * executor knows how to undo (revert-executor `BUILTIN_REVERTERS`) —
 * `work_items:set_state` (→ `work-item-state`) + `work_items:set_priority`
 * (→ `work-item-priority`). A new reversible action family wires the same seam with
 * its own handle kind (`registerReverter`).
 */

import type { Sql } from 'postgres';
import type { RiskTier, Authority } from '@papercusp/plan-parser';
import {
  resolveAutonomyDecision,
  defaultDeciderDeps,
  type DeciderDeps,
  type AutonomyDecision,
} from './decider';
import { categoryForAction } from './capability-category-map';
import { effectiveCeiling as computeEffectiveCeiling } from './policy';
import { armTripwireForDecision } from './tripwire/scan';
import type { RevertHandle } from './tripwire/core';
import { recordDecisionDisposition } from '../decision-ledger/disposition';

/** Ledger provenance (who/where) lifted off the dispatch ctx for the disposition row. */
export interface ReversibleArmProvenance {
  actorRole?: string | null;
  actorSpawnId?: string | null;
  actorPrincipal?: string | null;
  transport?: string | null;
}

export interface PlanReversibleArmInput {
  /** The MCP verb (`group:verb`) — keys the autonomy category (B-04) + the gate. */
  action: string;
  /**
   * The acting agent's declared per-ITEM risk (the gate's risk half is per-item, not
   * per-verb — emit.ts keeps action risk NULL by design). Absent ⇒ `planReversibleArm`
   * derives the risk from the category's effective ceiling (so the arm gate agrees with
   * the chokepoint); falls through to `critical` only when the category is unmapped or
   * its ceiling is `never-auto` (in which case the gate still correctly returns null).
   */
  riskTier?: RiskTier | null;
  /** Declared authority (`owner` always gates). Default `system`. */
  authority?: Authority | null;
}

export interface CommitReversibleArmInput {
  /** How to undo the action if the watch trips — built from the captured PRIOR state. */
  revertHandle: RevertHandle;
  /** The item the action touched (work-item id) — the disposition's `links.itemRef`. */
  itemRef?: string;
  harnessSlug?: string | null;
  /** Ledger provenance from the dispatch ctx. */
  provenance?: ReversibleArmProvenance;
}

export type CommitReversibleArmResult =
  | { armed: true; tripwireId: string; decisionId: string | null }
  | { armed: false; reason: string };

/** Injected IO (unit tests pass fakes; prod binds the live decider + ledger + store). */
export interface ArmReversibleDeps {
  decider: DeciderDeps;
  recordDisposition: typeof recordDecisionDisposition;
  armTripwire: typeof armTripwireForDecision;
  nowMs: () => number;
}

/** Live deps: the flag/PG-backed decider + the real disposition + tripwire writers. */
export function defaultArmReversibleDeps(sql: Sql, workspaceId: string): ArmReversibleDeps {
  return {
    decider: defaultDeciderDeps(sql, workspaceId),
    recordDisposition: recordDecisionDisposition,
    armTripwire: armTripwireForDecision,
    nowMs: () => Date.now(),
  };
}

/**
 * PHASE 1 (pre-mutation): would the live policy AUTO-decide this reversible action?
 * Returns the decision iff posture is `auto` — the caller then captures prior state
 * + mutates + calls {@link commitReversibleArm}. Returns `null` for EVERY non-`auto`
 * verdict (the whole population today, D-007), so the caller skips the prior-state
 * read entirely on the common path. `reversibility:'reversible'` is asserted because
 * the caller only wires this on actions it can undo.
 */
export async function planReversibleArm(
  sql: Sql,
  workspaceId: string,
  input: PlanReversibleArmInput,
  deps?: ArmReversibleDeps,
): Promise<AutonomyDecision | null> {
  if (!workspaceId) return null;
  const d = deps ?? defaultArmReversibleDeps(sql, workspaceId);

  // When the caller omits riskTier (the common arm-call-site path — bees never
  // pass decision.riskTier), derive a proxy from the category's effective ceiling
  // so the arm gate agrees with the chokepoint (EI-570). The chokepoint already
  // ruled `auto` at or below the ceiling; defaulting to `critical` instead makes
  // the arm gate always disagree → 0 tripwires ever arm. Using the ceiling as the
  // risk means: if the policy would auto-decide this action the arm fires too.
  // Safe: AutonomyCeiling \ {'never-auto'} ⊆ RiskTier; the `never-auto` check
  // keeps the ceiling-gated categories untouched (falls through to the `critical`
  // default in decideAutonomy, which still gates correctly for unmapped actions).
  let riskTier = input.riskTier;
  if (riskTier == null) {
    const category = categoryForAction(input.action ?? '');
    if (category != null) {
      const policy = await d.decider.getPolicy(category);
      const ceiling = computeEffectiveCeiling(policy);
      if (ceiling !== 'never-auto') {
        riskTier = ceiling; // narrowed: Exclude<AutonomyCeiling, 'never-auto'> = RiskTier
      }
    }
  }

  const decision = await resolveAutonomyDecision(
    {
      action: input.action,
      reversibility: 'reversible',
      ...(riskTier != null ? { riskTier } : {}),
      ...(input.authority != null ? { authority: input.authority } : {}),
    },
    d.decider,
  );
  return decision.posture === 'auto' ? decision : null;
}

/**
 * PHASE 2 (post-mutation): record the `act` disposition (B-13) FIRST so its row id
 * is the shared link, then arm the revert-watch (B-16) threaded with that
 * `decisionId`. `decision` is the {@link planReversibleArm} verdict; `revertHandle`
 * is built from the PRIOR state the caller captured before mutating.
 */
export async function commitReversibleArm(
  sql: Sql,
  workspaceId: string,
  decision: AutonomyDecision,
  input: CommitReversibleArmInput,
  deps?: ArmReversibleDeps,
): Promise<CommitReversibleArmResult> {
  if (!workspaceId) return { armed: false, reason: 'no workspace' };
  const d = deps ?? defaultArmReversibleDeps(sql, workspaceId);

  const dispId = await d.recordDisposition({
    workspaceId,
    harnessSlug: input.harnessSlug ?? null,
    decision,
    disposition: 'act',
    ...(input.itemRef ? { links: { itemRef: input.itemRef } } : {}),
    actorRole: input.provenance?.actorRole ?? null,
    actorSpawnId: input.provenance?.actorSpawnId ?? null,
    actorPrincipal: input.provenance?.actorPrincipal ?? null,
    transport: input.provenance?.transport ?? null,
  });
  const decisionId = dispId != null ? String(dispId) : null;

  const armed = await d.armTripwire(
    sql,
    workspaceId,
    {
      decision,
      revertHandle: input.revertHandle,
      ...(decisionId != null ? { decisionId } : {}),
    },
    d.nowMs(),
  );
  if (!armed.armed) return { armed: false, reason: armed.reason };
  return { armed: true, tripwireId: armed.id, decisionId };
}
