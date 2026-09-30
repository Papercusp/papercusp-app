/**
 * P-011: the claim-time BEHAVIOR CONTRACT leg — WHICH promises a claimed item is
 * on the hook for, at WHICH revision.
 *
 * WHY THIS IS A PORT RATHER THAN INLINE AT EACH SURFACE. Four surfaces hand an
 * agent a claimed item (scheduler:get_next, work_items:claim, work_items:claim_next,
 * plan_items:claim) and `claim-time-enrichment-parity.test.ts` obliges all four to
 * attach every registered leg. Three of them still hand-wire their own enrichment
 * batch, so inlining the resolve-plus-note logic would have copied it four times —
 * and a leg that is copied is a leg that drifts. This module is the single
 * implementation the parity guard matches on, exactly like its `*-claim-port`
 * siblings (`plan-decisions-claim-port`, `premises-claim-port`).
 *
 * The claimant is exactly who needs this and the claim is exactly when — until now
 * the resolved contract was legible only to the COMPLETION gate, so an agent
 * discovered which clauses it had to satisfy by being REFUSED at the end, after the
 * work was done. This calls the SAME port the gate uses
 * (`resolveWorkItemBehaviorContract`), so what a claimant is told cannot drift from
 * what they will be held to.
 *
 * ⚠ ADVISORY (D-017): reported, never enforced here. P-013 owns any refusal.
 */

import type { WorkItemBehaviorContract } from './agent-tools/plans/behavior-contract-resolver';

/** The subject fields this leg needs. A superset-tolerant shape, like its siblings. */
export interface BehaviorContractClaimSubject {
  id: string;
  payload?: unknown;
  harness?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
}

export interface ClaimTimeBehaviorContract {
  behaviorContract: WorkItemBehaviorContract;
  behaviorContractNote: string;
}

/**
 * Resolve the claimed item's behavior contract and render the claimant-facing note.
 *
 * Returns null when there is nothing worth saying — an item on the hook for NOTHING
 * is a real and common answer, and decorating every such claim would be noise.
 *
 * ⚠ Does NOT swallow its own failures: callers attach `.catch(() => null)` at their
 * own seam, matching every sibling leg. That keeps the decision about how to treat a
 * failed read at the surface that knows what its caller can distinguish (the module
 * header on claim-time-enrichment.ts: a swallowed read must never render as "the
 * guard passed").
 */
export async function getClaimTimeBehaviorContract(
  workItem: BehaviorContractClaimSubject,
  harness?: string | null,
): Promise<ClaimTimeBehaviorContract | null> {
  const m = await import('./agent-tools/plans/behavior-contract-resolver');
  const contract = await m.resolveWorkItemBehaviorContract({
    id: workItem.id,
    kind: null,
    harness: harness ?? workItem.harness ?? null,
    payload: workItem.payload,
    sourcePlanSlug: workItem.sourcePlanSlug,
    ...(workItem.sourcePlanItemIds ? { sourcePlanItemIds: workItem.sourcePlanItemIds } : {}),
  });
  if (!contract || contract.enforceable.length === 0) return null;
  const staleEdges = contract.groups.reduce((n, g) => n + g.staleEdges.length, 0);
  return {
    behaviorContract: contract,
    behaviorContractNote:
      `⚠ ADVISORY — this item is on the hook for ${contract.enforceable.length} behavior ` +
      `clause(s); satisfy them at their CURRENT revision or the completion gate will refuse` +
      (staleEdges > 0
        ? `. ${staleEdges} existing coverage claim(s) are pinned to a SUPERSEDED revision and must be re-proven`
        : '') +
      '.',
  };
}
