/**
 * lease-steal-semantics.ts — the INTENDED semantics of a work-item lease steal
 * (shared-hive-loop-e2e-testing-2026-06-10 P-004; recorded as that plan's
 * D-007). Before this, the steal path was mechanically possible (acquire
 * steals a lapsed lease — work-item-claims.ts) but its OUTCOME semantics were
 * unspecified: when swarm B steals mid-pipeline and re-runs, and zombie swarm
 * A later finishes anyway, which completion is the system's truth?
 *
 * ## The defined semantics (D-007)
 *
 * 1. **A steal is legitimate exactly when the lease has lapsed.** A lapsed
 *    lease means the holder failed to heartbeat for its whole TTL — the
 *    holder is presumed dead and its run is ABANDONED BY DEFINITION. The
 *    steal mints a NEW claim_id; the old claim ceases to exist in the store.
 *
 * 2. **Completion adoption is lease-current-first.** When one work item
 *    accumulates multiple completion records (zombie + stealer; partition
 *    double-claims), the record whose `claimId` is STILL THE STORE'S CURRENT
 *    CLAIM for the item is adopted. This deliberately differs from the raw
 *    reconcile total order (earliest-acquire first): in a steal, the EARLIER
 *    acquire is precisely the abandoned one — the live lease wins, not the
 *    first mover. The raw order stays correct for its own case (concurrent
 *    fail-open claims, where no store holds both and neither has lapsed).
 *
 * 3. **Deterministic fallback.** When NO record is lease-current (the lease
 *    was since released / re-stolen / the stores diverged under partition),
 *    adoption falls back to the reconcile total order — earliest acquire →
 *    lowest holder pubkey → lowest claim_id (`compareClaims`) — so every
 *    adjudication is total, order-independent, and idempotent.
 *
 * 4. **Duplicated side effects are tolerated, detected, never rolled back.**
 *    A superseded run's external effects (branch, commits) are left in place
 *    and MARKED superseded — adoption selects whose work integrates; it does
 *    not undo the loser's. (Same philosophy as fail-open reconcile, D-007 of
 *    decentralized-dispatch-scaling.)
 *
 * 5. **Zombies should self-abort at the heartbeat seam.** A pipeline holding
 *    a lease SHOULD heartbeat between side-effecting steps; `renewed: false`
 *    (the lapsed/stolen signal `heartbeatClaim` already returns) is the abort
 *    signal — stop before the next side effect. Wiring this heartbeat into
 *    the DBOS pipeline's step boundary is the production follow-up this
 *    module's adjudicator makes safe to defer: even an un-aborted zombie's
 *    completion is rejected at adoption time by rule 2.
 *
 * Pure + standalone (no PG, no transport) — unit-testable, reusable by the
 * completion-record path and by the P-012 cross-swarm double-completion
 * detector.
 */
import { compareClaims, type AdvisoryClaim } from '../work-item-claim-reconcile';

/** One recorded completion of a work item by some executor's run. */
export interface CompletionRecord {
  workItemId: string;
  /** The executing cell/swarm's label (reporting only — not part of the order). */
  executor: string;
  /** The lease under which the run executed. */
  claim: AdvisoryClaim;
  completedAtMs: number;
}

export interface AdoptionVerdict {
  workItemId: string;
  adopted: CompletionRecord;
  superseded: CompletionRecord[];
  /** Which rule decided: 'single' (no contest), 'lease-current' (rule 2), 'total-order' (rule 3). */
  rule: 'single' | 'lease-current' | 'total-order';
}

/**
 * Adjudicate the completion records for ONE work item against the (authority
 * view of the) store's current claim. Returns null for an empty input.
 */
export function adoptCompletion(
  records: readonly CompletionRecord[],
  currentClaimId: string | null,
): AdoptionVerdict | null {
  if (records.length === 0) return null;
  const workItemId = records[0].workItemId;
  if (records.some((r) => r.workItemId !== workItemId)) {
    throw new Error('adoptCompletion: records span multiple work items — group first');
  }
  if (records.length === 1) {
    return { workItemId, adopted: records[0], superseded: [], rule: 'single' };
  }

  // Rule 2 — lease-current wins (the steal rule).
  const leaseCurrent = currentClaimId ? records.filter((r) => r.claim.claimId === currentClaimId) : [];
  if (leaseCurrent.length === 1) {
    return {
      workItemId,
      adopted: leaseCurrent[0],
      superseded: records.filter((r) => r !== leaseCurrent[0]),
      rule: 'lease-current',
    };
  }

  // Rule 3 — deterministic total order over the records' claims.
  const ranked = [...records].sort((x, y) => compareClaims(x.claim, y.claim));
  return {
    workItemId,
    adopted: ranked[0],
    superseded: ranked.slice(1),
    rule: 'total-order',
  };
}

/**
 * Adjudicate a flat list of completion records spanning many items.
 * `currentClaimFor` is the authority-view lookup (store.getClaim's claimId, or
 * null when no live claim exists). Sorted by workItemId for stable diffing.
 */
export function adoptAll(
  records: readonly CompletionRecord[],
  currentClaimFor: (workItemId: string) => string | null,
): AdoptionVerdict[] {
  const byItem = new Map<string, CompletionRecord[]>();
  for (const r of records) {
    let bucket = byItem.get(r.workItemId);
    if (!bucket) byItem.set(r.workItemId, (bucket = []));
    bucket.push(r);
  }
  const out: AdoptionVerdict[] = [];
  for (const [item, bucket] of byItem) {
    const v = adoptCompletion(bucket, currentClaimFor(item));
    if (v) out.push(v);
  }
  out.sort((a, b) => (a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0));
  return out;
}
