/**
 * plans/remote-seat-inventory.ts — pot-seat-pools-prose-ux-2026-07-18
 * P-007/P-013/P-014: resolves the pot-wide standing remote seat-offer
 * inventory (`RemoteSeatSummary`, see `launch-prompt.ts`) for the routing-gate
 * kickoff text. This is the IMPURE half — `launch-prompt.ts` stays
 * dependency-free (no DB import), so any DB/hive-scope read lives here and the
 * caller (bootstrap-su.ts today) awaits this before composing the kickoff.
 *
 * "The plan's pot is shared" = this workspace resolves to exactly one shared
 * Hive (resolveWorkspaceHiveScope kind==='one') — none/many never guesses.
 * "Seat-offers exist" reads harness_shared.p2p_work_offers pot-wide (kind
 * 'seat', status 'open') via the offer-store read (offer-store.ts
 * listOffers), then keeps only the rows with a non-null `potSlug` (P-001)
 * — a TRUE pot-scoped standing offer, spendable by ANY fleet in the pot. A
 * fleet-SCOPED offer (fleetSlug set, potSlug null) is donated to one already-
 * EXISTING fleet and is not spendable by the not-yet-created fleet this
 * routing gate is about to launch, so it is deliberately excluded here (it
 * still counts for an existing fleet's own placement:'remote' spread —
 * P-004/P-005, a different code path).
 *
 * Fail-soft by contract (mirrors offer-store-publish.ts / federation-scope.ts
 * discipline): any resolution error degrades to the "unshared/no offers"
 * summary — an inventory-check must never break a plan launch.
 */

import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { listOffers as listOffersDefault } from '../../p2p/offer-store';
import type { RemoteSeatSummary } from './launch-prompt';

/** DI seam (federation-scope / offer-store-publish discipline) so unit tests
 *  run without PG. */
export interface RemoteSeatInventoryDeps {
  resolveScope?: typeof resolveWorkspaceHiveScope;
  listOffers?: typeof listOffersDefault;
}

const EMPTY_SUMMARY: RemoteSeatSummary = {
  potShared: false,
  donorCount: 0,
  totalSeats: 0,
};

/**
 * Resolve this workspace's pot-wide remote seat-offer inventory for the
 * routing-gate kickoff. `workspaceId` unresolved (null/undefined) or the
 * workspace's shared-Hive scope not exactly-one ⇒ `{ potShared:false, ... }`
 * (today's static option-C text, unchanged). Never throws.
 */
export async function resolveRemoteSeatInventory(
  workspaceId: string | null | undefined,
  deps: RemoteSeatInventoryDeps = {},
): Promise<RemoteSeatSummary> {
  if (!workspaceId) return EMPTY_SUMMARY;
  const resolveScope = deps.resolveScope ?? resolveWorkspaceHiveScope;
  const listOffers = deps.listOffers ?? listOffersDefault;
  try {
    const scope = await resolveScope(workspaceId);
    if (scope.kind !== 'one') return EMPTY_SUMMARY;
    const rows = await listOffers(workspaceId, scope.homeSlug, {
      kind: 'seat',
      status: 'open',
    });
    const donors = new Set<number>();
    const labels = new Set<string>();
    let totalSeats = 0;
    for (const row of rows) {
      // P-001: only a TRUE pot-scoped offer (potSlug set) is spendable by the
      // not-yet-created fleet this routing gate is about — a fleet-scoped
      // offer (potSlug null) belongs to a specific existing fleet.
      if (row.potSlug == null) continue;
      if (!row.record || row.record.kind !== 'seat' || !row.record.seat) continue;
      donors.add(row.publisherGithubUserId);
      totalSeats += row.record.seat.count;
      // P-013 ("donors named"): hostLabel is optional at delegate time — only
      // surface it when the offering host actually set one, never invent one.
      const label = row.record.seat.hostLabel?.trim();
      if (label) labels.add(label);
    }
    return {
      potShared: true,
      donorCount: donors.size,
      totalSeats,
      donorLabels: labels.size > 0 ? Array.from(labels).sort() : undefined,
    };
  } catch (e) {

    console.warn(
      `[remote-seat-inventory] resolve failed for ws=${workspaceId} (routing gate falls back to local-only text):`,
      e instanceof Error ? e.message : String(e),
    );
    return EMPTY_SUMMARY;
  }
}
