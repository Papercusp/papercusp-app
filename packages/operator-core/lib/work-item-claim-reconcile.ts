/**
 * Tolerate-and-reconcile fallback for work-item claims
 * (decentralized-dispatch-scaling-2026-06-08 P-005, the fail-open branch of D-007's
 * proposed hybrid consistency mode).
 *
 * A work-item claim is normally arbitrated by the per-Hive lock authority (the
 * lowest-live-device-pubkey peer — `lockAuthorityForHive`, [[shared-hive-federation-2026-06-08]]
 * Track B / P-009). By the CALM theorem, claiming ("assign to exactly one Swarm") is
 * NON-monotonic, so it needs either that authority OR tolerate-and-reconcile. D-007's
 * recommended hybrid is **authority-arbitrated exactly-once, fail-open to
 * tolerate-and-reconcile**: when the authority is unreachable (a network partition),
 * claims fail OPEN to local advisory leases so a Swarm never STALLS — at the price that
 * two partitioned Swarms can both hold an advisory lease on the same work item.
 *
 * This module is that reconcile step: given the set of advisory claims that exist for a
 * work item after a partition heals, it deterministically picks the ONE winner so the
 * loser(s) drop their work. "Deterministic" is the load-bearing property — every peer
 * runs the IDENTICAL pure function and so agrees on the winner WITHOUT any further
 * coordination (the resolution is itself monotonic/idempotent/commutative, which is what
 * makes the fail-open path CALM-safe). We accept rare wasted LLM work over either a stall
 * (pure-strong) or a double-completion (no reconcile).
 *
 * Tie-break order (a TOTAL order, so the winner is always unique + stable):
 *   1. earliest `acquiredTs` wins — the Swarm that started soonest has done the most
 *      work; dropping the later starter wastes the least.
 *   2. ties on the timestamp → lowest `holderPubkey` — the SAME rule the authority
 *      election uses (lowest-live-pubkey), so the reconcile winner matches who the
 *      authority WOULD have granted, keeping the two paths consistent.
 *   3. ties on the pubkey → lowest `claimId` — the final disambiguator (two claims from
 *      the same Swarm/process at the same instant); guarantees a total order.
 *
 * Pure + standalone (no PG, no authority, no React) so the policy is unit-tested in
 * isolation and reused identically on every peer + in the cross-Swarm E2E (P-013).
 */

/** One advisory claim on a work item, as recorded by a fail-open (un-arbitrated) acquire. */
export interface AdvisoryClaim {
  /** The contested work item. */
  workItemId: string;
  /** The claiming Swarm's device pubkey (base64) — the authority-election identity. */
  holderPubkey: string;
  /** The claiming agent/owner id (for reporting which session must drop). */
  owner: string;
  /** The lease's claim_id (uuid). Final tiebreak; also identifies the row to drop. */
  claimId: string;
  /** ISO-8601 acquire time (the lease's `acquired_ts`). */
  acquiredTs: string;
}

/** The resolution of one work item's competing claims. */
export interface ClaimResolution {
  workItemId: string;
  /** The single surviving claim — keeps its work. */
  winner: AdvisoryClaim;
  /** Every other claim — must drop its work (release the lease, requeue/abandon the turn). */
  losers: AdvisoryClaim[];
}

/**
 * The total order over competing claims. Returns < 0 when `a` should win over `b`.
 * Earliest acquire → lowest pubkey → lowest claimId. Exported for testing the order
 * directly + for callers that want to sort a claim list into priority order.
 */
export function compareClaims(a: AdvisoryClaim, b: AdvisoryClaim): number {
  // 1. Earliest acquire wins. Compare as epoch ms; an unparseable/missing ts sorts LAST
  //    (it's the least-trustworthy "I started first" assertion).
  const ta = claimEpoch(a.acquiredTs);
  const tb = claimEpoch(b.acquiredTs);
  if (ta !== tb) return ta - tb;
  // 2. Lowest holder pubkey (matches the authority election).
  if (a.holderPubkey !== b.holderPubkey) return a.holderPubkey < b.holderPubkey ? -1 : 1;
  // 3. Lowest claimId — total-order guarantee.
  if (a.claimId !== b.claimId) return a.claimId < b.claimId ? -1 : 1;
  return 0;
}

function claimEpoch(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/**
 * Reconcile the competing advisory claims on ONE work item into a single winner + the
 * losers that must drop. Returns null only for an empty input (nothing to reconcile).
 * Idempotent + commutative: the winner does not depend on input order, and feeding the
 * winner back in yields the same winner.
 */
export function reconcileClaims(claims: readonly AdvisoryClaim[]): ClaimResolution | null {
  if (claims.length === 0) return null;
  let winner = claims[0];
  for (let i = 1; i < claims.length; i += 1) {
    if (compareClaims(claims[i], winner) < 0) winner = claims[i];
  }
  const losers = claims.filter((c) => c !== winner && c.claimId !== winner.claimId);
  return { workItemId: winner.workItemId, winner, losers };
}

/**
 * Reconcile a flat list of advisory claims spanning MANY work items: group by
 * `workItemId`, resolve each group, return one resolution per contested item. Groups
 * with a single claim resolve to `{ winner, losers: [] }` (no contention — harmless to
 * include; callers can filter on `losers.length > 0` for the "someone must drop" set).
 * Output is sorted by `workItemId` for stable diffing.
 */
export function reconcileAll(claims: readonly AdvisoryClaim[]): ClaimResolution[] {
  const byItem = new Map<string, AdvisoryClaim[]>();
  for (const c of claims) {
    let bucket = byItem.get(c.workItemId);
    if (!bucket) {
      bucket = [];
      byItem.set(c.workItemId, bucket);
    }
    bucket.push(c);
  }
  const out: ClaimResolution[] = [];
  for (const bucket of byItem.values()) {
    const r = reconcileClaims(bucket);
    if (r) out.push(r);
  }
  out.sort((a, b) => (a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0));
  return out;
}

/** Convenience: only the contested resolutions (≥2 claims → at least one loser). */
export function contestedResolutions(claims: readonly AdvisoryClaim[]): ClaimResolution[] {
  return reconcileAll(claims).filter((r) => r.losers.length > 0);
}
