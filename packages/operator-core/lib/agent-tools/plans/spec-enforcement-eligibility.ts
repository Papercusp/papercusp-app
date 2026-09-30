/**
 * spec-enforcement-eligibility.ts — P-013.
 *
 * THE ONE PLACE that answers "may this plan's clauses REFUSE anything yet?".
 *
 * WHY IT IS ITS OWN MODULE. Four separate surfaces need this answer: the work-item
 * completion gate, the sync-resolver view that renders what that gate will do, the
 * plan-ship coverage gate, and the reconciliation ledger. The lane/adoption vocabulary
 * was born inside `spec-reconciliation.ts`, but that file imports the coverage gate
 * (`SpecReconciliationDeps extends PlanSpecCoverageDeps`), so the gate importing back
 * would close a cycle. This module therefore depends on NOTHING — it is pure data
 * classification — and `spec-reconciliation.ts` re-exports from here rather than
 * keeping its own copy.
 *
 * THE FAILURE THIS PREVENTS is drift between the gate and the view of the gate. The
 * completion gate and `sync-resolver/work-item-spec-adequacy.ts` each carried their own
 * copy of the `enforcedGroup` selection. Two copies of a refusal rule means a human can
 * be shown one enforced set while a different one refuses their completion, and nothing
 * fails when they diverge. Derive both from `isEnforcementEligible` instead.
 *
 * THE MIGRATION SEMANTICS, which are the whole point of P-013's scope line
 * ("enable enforcement for new and explicitly reconciled plans, THEN migrate active
 * plans individually"):
 *
 *   lane=historical      (shipped/superseded) -> never enforces. D-018 keeps shipped
 *                        plans historical and non-blocking; enforcing them would refuse
 *                        completions on work that already shipped.
 *   lane=pre-enforcement (draft)              -> never enforces. D-012: draft clauses are
 *                        candidate inputs, reported but not enforceable until promotion.
 *   lane=enforceable + adoption=adopted       -> ENFORCES. This is "explicitly reconciled":
 *                        the plan has actually adopted clauses.
 *   lane=enforceable + NOT adopted            -> reports only. Each such plan is one
 *                        per-plan migration step; refusing here would block active plans
 *                        that simply have not been reconciled yet, which is precisely the
 *                        fleet-wide refusal D-013/D-017/D-018 kept deferring.
 *
 * NOTE the asymmetry that makes this safe: eligibility can only ever NARROW what is
 * enforced relative to "every resolved clause". A plan becomes enforceable by having
 * clauses adopted, which is a deliberate authoring act, never a default.
 */

/** Plans whose behavior already shipped — carried for visibility, never blocking. */
export const HISTORICAL_STATUSES: ReadonlySet<string> = new Set(['shipped', 'superseded']);
/** Candidate inputs — reported, but never enforceable until promotion (D-012). */
export const PRE_ENFORCEMENT_STATUSES: ReadonlySet<string> = new Set(['draft']);

export type ReconciliationLane = 'enforceable' | 'pre-enforcement' | 'historical';
export type AdoptionState = 'adopted' | 'legacy-val-only' | 'no-behavior-declared';

/** One plan's adoption inputs, read once for the whole population. */
export interface PlanAdoptionRow {
  planSlug: string;
  status: string;
  clauseCount: number;
  /** Legacy VAL-* / coversVALs signals still present in the plan's text or items. */
  legacyValSignal: boolean;
}

export function laneOf(status: string): ReconciliationLane {
  if (HISTORICAL_STATUSES.has(status)) return 'historical';
  if (PRE_ENFORCEMENT_STATUSES.has(status)) return 'pre-enforcement';
  return 'enforceable';
}

export function adoptionOf(row: Pick<PlanAdoptionRow, 'clauseCount' | 'legacyValSignal'>): AdoptionState {
  if (row.clauseCount > 0) return 'adopted';
  if (row.legacyValSignal) return 'legacy-val-only';
  return 'no-behavior-declared';
}

/**
 * Why a plan is or is not enforcing — the REASON, not just a boolean.
 *
 * The reason is part of the contract, not a nicety: P-013 must instrument gate reasons,
 * and a bare `false` cannot distinguish "shipped, correctly exempt" from "active but not
 * yet reconciled, which is a migration TODO". Those two need opposite follow-up.
 */
export type EnforcementEligibility =
  | { enforcing: true; lane: 'enforceable'; adoption: 'adopted' }
  | {
      enforcing: false;
      lane: ReconciliationLane;
      adoption: AdoptionState;
      /** Stable machine-readable reason, safe to aggregate over. */
      reason: 'historical' | 'pre-enforcement' | 'not-yet-reconciled';
    };

/**
 * Decide whether a plan's clauses may refuse.
 *
 * `status` is the PLAN's status. `clauseCount` is how many clauses that plan has adopted;
 * pass the resolved group's clause count at a gate, or the ledger's count in a census.
 *
 * An UNKNOWN plan status must be passed as-is rather than defaulted: `laneOf` treats any
 * unrecognized status as `enforceable`, which is deliberate — a new plan status should
 * surface as enforcing-and-visible rather than silently exempting a plan from every gate.
 * Silent exemption is the failure mode this whole plan exists to remove.
 */
export function enforcementEligibility(input: {
  status: string;
  clauseCount: number;
  legacyValSignal?: boolean;
}): EnforcementEligibility {
  const lane = laneOf(input.status);
  const adoption = adoptionOf({
    clauseCount: input.clauseCount,
    legacyValSignal: input.legacyValSignal ?? false,
  });
  if (lane === 'historical') return { enforcing: false, lane, adoption, reason: 'historical' };
  if (lane === 'pre-enforcement') return { enforcing: false, lane, adoption, reason: 'pre-enforcement' };
  if (adoption !== 'adopted') return { enforcing: false, lane, adoption, reason: 'not-yet-reconciled' };
  return { enforcing: true, lane, adoption };
}

/** Boolean shorthand for callers that do not need the reason. */
export function isEnforcementEligible(input: {
  status: string;
  clauseCount: number;
  legacyValSignal?: boolean;
}): boolean {
  return enforcementEligibility(input).enforcing;
}
