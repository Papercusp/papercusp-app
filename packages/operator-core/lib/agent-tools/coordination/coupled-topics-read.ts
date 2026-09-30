/**
 * coupled-topics-read.ts — the ASSEMBLY for P-023's coupled-topic feed: one
 * place that walks roster → couplings → peers' work-items → topics → feed.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-023 (rulings D-081 / D-082).
 *
 * ⚠ A CONSUMER OF THE UNION, NOT A SECOND COUPLING PATH (D-078 (b), D-081).
 * The peer set comes from `resolveCoupledPeers` — the ONE shared predicate
 * (`derived ∪ declared − suppressed`) that `coord:presence` already uses — so
 * this cannot drift from what `expanded[]` shows, and an agent that DECOUPLED a
 * peer stays decoupled here too. Re-deriving a private notion of "coupled" was
 * the obvious shortcut and is exactly what the ruling forbids.
 *
 * ⚠ PULL ONLY, ZERO WRITES (D-081 (c)). Recomputed per read; nothing is stored,
 * so the projection narrows on its own as coupling decays and there is no
 * cleanup path to forget. Push belongs to P-021 surprisal, in its own item.
 */
import { resolvePresenceScope, assemblePresenceSnapshot } from './presence-snapshot';
import { couplingSourcesFor } from './coupling-sources';
import { coupledTopicSourcesFor } from './coupled-topic-sources';
import { deriveCouplings } from '../../coord/coupling-derivation';
import type { DerivedSignalCensus } from '../../coord/derived-signal-census';
import { listCouplingsFor, resolveCoupledPeers } from '../../coord/couplings';
import { deriveCoupledTopics, type CoupledTopicFeed } from '../../coord/coupled-topics';

export interface CoupledTopicsReadCtx {
  workspaceId?: string | null;
  harnessSlug?: string | null;
}

/**
 * Everything the caller's COUPLED PEERS are working on, by topic.
 *
 * Fail-soft as a whole: this is an enrichment, and a caller asking for its
 * coupled topics must never be handed an error because one leg was unavailable
 * — an empty list is the honest degraded answer.
 */
export async function readCoupledTopics(
  selfOwnerId: string,
  ctx: CoupledTopicsReadCtx = {},
  opts: {
    withFeed?: boolean;
    /**
     * P-009 — the dead-signal census sink, threaded from the TOOL layer (the only
     * layer holding a `ctx.metadata` channel) via `censusObserverFor(ctx)`.
     *
     * ⚠ "PULL ONLY, ZERO WRITES" above is about COUPLING STATE and still holds:
     * this writes no coupling row and stores no projection. It rides the calling
     * invocation's existing metadata record, which is the reuse the census was
     * designed around (derived-signal-census.ts) rather than a new surface.
     */
    observe?: (census: DerivedSignalCensus) => void;
  } = {},
): Promise<CoupledTopicFeed[]> {
  const self = selfOwnerId?.trim();
  if (!self) return [];

  try {
    const resolved = await resolvePresenceScope(ctx, {});
    const snapshot = await assemblePresenceSnapshot(resolved, {});
    const rosterOwnerIds = snapshot.active
      .map((r) => (r as { ownerId?: unknown }).ownerId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    const derived = await deriveCouplings(
      self,
      snapshot.active,
      {
        ...couplingSourcesFor({
          selfOwnerId: self,
          rosterOwnerIds,
          ...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        }),
        ...(opts.observe ? { observe: opts.observe } : {}),
      },
    );
    const edges = await listCouplingsFor(self, ctx.workspaceId ?? undefined);
    const peers = resolveCoupledPeers(self, derived, edges);

    // `resolveCoupledPeers` returns the union's richer `CoupledPeer`; the topic
    // derivation only needs the ownerId, and says so in its own signature — so
    // this narrows rather than fabricating the rest of a `DerivedCoupling`. It
    // used to pass a synthetic `because` that the derivation never read.
    return await deriveCoupledTopics(
      self,
      peers.map((p) => ({ ownerId: p.ownerId })),
      coupledTopicSourcesFor(),
      opts,
    );
  } catch {
    return [];
  }
}
