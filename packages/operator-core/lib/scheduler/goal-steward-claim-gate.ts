/**
 * goal-steward-claim-gate.ts — WI-2092233: refuse to SERVE self-selected work to a caller
 * holding active GOAL-holder (steward) authority, with a route-it-instead verdict.
 *
 * WHY (the filed breach): the work-on-everything goal holder cleanly wound down a stewardship
 * pass, then pulled an implementation item (WI-1801547, a plan's focused-tests/repair lane) via
 * scheduler:get_next, checkpointed a claim, and declared implementation intent — the one cardinal
 * violation of the GOAL contract (modes/registry.ts): "you CREATE, PLACE, ARBITRATE and KILL
 * work. You never IMPLEMENT it. Not a feature, not a fix, not a test, and NOT INFRASTRUCTURE —
 * there is no exception... Every unit of execution below is a LAUNCHED AGENT." The holder caught
 * itself minutes later and released, but the released item then sat stranded for hours — both
 * halves (the wrong-hands claim AND the strand it causes on release) are what this rail prevents.
 *
 * WHY A BLANKET self-select refusal rather than a kind filter: the breached item was
 * kind:'feature'; a change/bug-only filter would have missed it, and a 'task' can be
 * implementation too ("run tests and repair failures"). The contract is categorical — a steward
 * has no business in the self-select queue at all — so the rail is categorical. The DELIBERATE
 * escapes are named in the refusal: work_items:claim (the by-id door, deliberately ungated per
 * claim-door-census `by-id-ungated` — it warns instead), or exiting/handing off GOAL mode.
 *
 * WHY ONE SHARED MODULE: same anti-drift shape as context-pressure-claim-gate.ts — both
 * self-select surfaces (`scheduler:get_next` and its `work_items:claim_next` wrapper) must answer
 * identically (the WI-6409 failure mode: a refusal that exists on one branch only).
 *
 * ⚠ THE CENTRAL HAZARD — a false 'steward' reading must never manufacture a false drain.
 * Unlike the context gate's ~2-min-stale cached bucket, `readGoalHolderAuthority` is the
 * canonical live election SQL, so a false positive is unlikely — but an UNREADABLE authority is
 * still unknown, and unknown SERVES (fail-open, property 1 below). The refusal itself leads with
 * the cause and states plainly that the lane was never consulted (EI-19931420102632438's lesson).
 *
 * Properties, each asserted by a test:
 *   1. FAIL-OPEN ON UNKNOWN. A null/unreadable authority serves — never coerced to a refusal.
 *   2. ONLY ACTIVE STEWARD AUTHORITY REFUSES. 'elected' and a live 'handoff' hold the steward
 *      contract; 'none' and 'superseded' are ordinary agents and are served unchanged.
 *   3. A KILL-SWITCH THE OWNER OWNS. The flag (SCHEDULER_GOAL_STEWARD_GATE) disables the gate
 *      wholesale; consulted BEFORE the authority so a stale reading cannot defeat it.
 *
 * PURE (no PG, no clock): the IO seam is the caller's `readGoalHolderAuthority` read, exactly
 * like the context gate's `fetchContextPressure` seam. Keeps this unit-testable in one place.
 */

import type { GoalHolderAuthority } from '../goals/holder-authority';

/** Typed verdict code, named by the filing so a reader can grep the item from the wire. */
export const GOAL_STEWARD_REFUSAL_CODE = 'claim_refused_goal_steward';

/** Why the gate let a pull through — reported so "served" is never an unexplained default. */
export type GoalStewardServeReason =
  /** No goal-mode row, or authority long since superseded — an ordinary agent. */
  | 'not-steward'
  /** Authority unreadable/absent this call. Fail-open by contract: unknown means unknown. */
  | 'authority-unknown'
  /** Kill-switch off. */
  | 'gate-disabled';

export type GoalStewardGateDecision =
  | { refuse: false; reason: GoalStewardServeReason; authority: GoalHolderAuthority | null }
  | {
      refuse: true;
      reason: 'steward-authority';
      authority: GoalHolderAuthority;
      code: typeof GOAL_STEWARD_REFUSAL_CODE;
      error: string;
      diagnosis: {
        goalStewardBlocked: true;
        goalId: string | null;
        authorityStatus: 'elected' | 'handoff';
        /** The lane was never queried — say so, so this is not read as a drain verdict. */
        laneEvaluated: false;
        remedy: string;
      };
    };

/**
 * The refusal text. Shaped like the sibling gates: cause first, explicit "the lane was NOT
 * evaluated" disclaimer, then the remedy — which names the contract's own route (launch/place)
 * and the two deliberate escapes, so a steward is never left without a move.
 */
function goalStewardRefusalMessage(goalId: string | null, status: 'elected' | 'handoff'): string {
  const who =
    status === 'elected'
      ? `you are the ELECTED holder of goal '${goalId ?? 'unknown'}'`
      : `you hold a live HANDOFF window on goal '${goalId ?? 'unknown'}'`;
  return (
    `goal-steward self-pull refused: ${who}, and the GOAL contract is categorical — the holder ` +
    `CREATEs/PLACEs/ARBITRATEs/KILLs work and never IMPLEMENTS it (not a feature, not a fix, not a ` +
    `test, not infrastructure); every unit of execution is a LAUNCHED agent. A self-selected claim ` +
    `puts implementation in the steward's hands and, on the inevitable release, strands the item ` +
    `(WI-2092233: the breached item sat unassigned for hours). ` +
    `REMEDY: place the work instead — plans:new/plans:add-item + plans:start with a fleet on its ` +
    `items, or route it to a live implementer and VERIFY pickup. ` +
    `(The claim lane itself was NOT evaluated — this is not a statement about lane contents, and ` +
    `NOT a drain verdict.) Deliberate escapes: a stewardship-scoped claim by id via ` +
    `work_items:claim { id } (ungated by design — it warns instead), or exit/hand off GOAL mode; ` +
    `the SCHEDULER_GOAL_STEWARD_GATE flag is the owner's kill-switch.`
  );
}

/**
 * PURE decision. `authority` is the caller's canonical goal-holder authority read
 * (null ⇒ unreadable/unknown). Ordering is deliberate: the kill-switch is consulted BEFORE
 * the authority, so a bad reading cannot defeat it.
 */
export function decideGoalStewardGate(input: {
  authority: GoalHolderAuthority | null | undefined;
  /** Kill-switch (flag). Default true — finished work does not ship dark. */
  enabled?: boolean;
}): GoalStewardGateDecision {
  const authority = input.authority ?? null;
  if (input.enabled === false) return { refuse: false, reason: 'gate-disabled', authority };
  // Fail-open on unknown: an absent/unreadable authority is never coerced into a refusal.
  if (authority == null) return { refuse: false, reason: 'authority-unknown', authority: null };
  if (authority.status !== 'elected' && authority.status !== 'handoff') {
    return { refuse: false, reason: 'not-steward', authority };
  }
  return {
    refuse: true,
    reason: 'steward-authority',
    authority,
    code: GOAL_STEWARD_REFUSAL_CODE,
    error: goalStewardRefusalMessage(authority.goalId, authority.status),
    diagnosis: {
      goalStewardBlocked: true,
      goalId: authority.goalId,
      authorityStatus: authority.status,
      laneEvaluated: false,
      remedy: 'place the work (plan + fleet) or route to a live implementer; never self-pull',
    },
  };
}

/** The full wire body for a refusing tool result — shared so both surfaces emit one shape. */
export function goalStewardRefusalResult(decision: Extract<GoalStewardGateDecision, { refuse: true }>): {
  ok: false;
  error: string;
  code: string;
  diagnosis: Record<string, unknown>;
} {
  return {
    ok: false,
    error: decision.error,
    code: decision.code,
    diagnosis: decision.diagnosis,
  };
}
