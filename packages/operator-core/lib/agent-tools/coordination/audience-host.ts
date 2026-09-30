/**
 * audience-host.ts — the PG-backed wiring of the pure audience resolver
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 *
 * Mirrors topics.ts: constructs the capability stores over the org embedded-pg
 * handle and adapts them to the small `AudienceResolvers` port `expandAudience`
 * needs. Kept separate from the pure ./audience core so that core stays
 * dependency-free + unit-testable, and from messages.ts so the send path takes a
 * single import.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PgEntitySubscriptionStore, PgLinkStore } from '@papercusp/coordination/capabilities';
import { listPresence } from './presence';
// The SAME roster oracle the direct-id path refuses on, so the selector path cannot
// accept an address the literal id would have been refused for (EI-22180848452883121).
import { knownOwnerIdSet } from './recipient-resolve';
import { coordWorkspaceId } from './log';
// The locks shim (NOT `@papercusp/locks` directly) — it imports ./configure for its
// side effect, so the package's host seam is wired before the first store call.
import { ensureBootstrap, getTxPool, readQueue, normalizePaths } from '../locks/su-lock-store';
import { liveFleetMemberIds, liveFleetMemberIdsDiagnosed } from '../../fleet/fleet-roster';
import { getFleet, fleetSlugFromName } from '../../agent-fleets-store';
import { latestFleetLeader } from '../../fleet-membership-store';
import { getFleetDeliveryOverrides } from './fleet-delivery';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { isQualifiedFeatureRef } from '../../issue-blocks-merge';
import {
  listFederatedFleetMembers,
  type FederatedFleetMemberRow,
} from '../../sync/hyperbee/session-presence-store';
import {
  resolveFederatedFleetLeader,
  unionFederatedFleetMembers,
} from '../../fleet/federated-fleet-registry';
import type { ActivePresence, AudienceMode, AudienceResolvers } from './audience';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migration 123; the host seam is a no-op.
  ensureSchema: async () => {},
};
const subStore = new PgEntitySubscriptionStore(storeOpts);
const linkStore = new PgLinkStore(storeOpts);

/**
 * Resolve the live roster used by typed fleet control operations.
 *
 * This is intentionally separate from the @fleet: delivery audience: muted and
 * digest members are still fleet members and must receive binding wind-down/resume
 * control, including the durable release latch that prevents queued wakes from
 * reanimating a released session.
 */
export async function listFleetControlMembers(fleetSlug: string): Promise<string[]> {
  const slug = fleetSlugFromName(fleetSlug);
  const ws = coordWorkspaceId();
  const localMembers = await liveFleetMemberIds(slug, ws);

  // A session leading several fleets carries only its newest fleet label on the
  // singular coord_presence.fleet_slug column (mig 407). Union the durable or
  // federated leader so control reaches every fleet it leads.
  let federatedMembers: FederatedFleetMemberRow[] = [];
  try {
    federatedMembers = await listFederatedFleetMembers({
      workspaceId: ws,
      fleetSlug: slug,
      staleMs: PRESENCE_STALE_MS,
    });
  } catch {
    /* federated roster unavailable — local members alone */
  }
  let localRegistryLeader: string | null = null;
  try {
    localRegistryLeader = (await getFleet(ws, slug))?.leaderOwnerId ?? null;
  } catch {
    /* registry unavailable — no local leader to union */
  }
  const leaderOwnerId = resolveFederatedFleetLeader({ localRegistryLeader, federatedMembers });
  return unionFederatedFleetMembers({
    localMemberIds: localMembers,
    federatedMemberIds: federatedMembers.map((m) => m.ownerId),
    leaderOwnerId,
  });
}

export const hostAudienceResolvers: AudienceResolvers = {
  async listTargetSubscribers(targetKind, targetRef) {
    const rows = await subStore.listTargetSubscribers(targetKind, targetRef);
    return rows.map((r) => r.subscriber_id);
  },
  async listObjectOwners(objectKind, objectRef) {
    try {
      if (objectKind !== 'issue' && objectKind !== 'feature') return [];

      let id = objectRef;
      let harness: string | undefined;
      if (objectKind === 'feature') {
        if (!isQualifiedFeatureRef(objectRef)) return [];
        const separator = objectRef.indexOf('#');
        harness = objectRef.slice(0, separator);
        id = objectRef.slice(separator + 1);
      }

      // Lazy-load the unified work-item facade so audience expansion does not
      // create a module cycle for hosts that only use subscription selectors.
      const { getWorkItem } = await import('../../work-items');
      const item = await getWorkItem(id, harness);
      if (!item || item.family !== objectKind) return [];
      // Feature ObjectRefs are harness-qualified; reject a same-id row from a
      // different harness rather than leaking its owner across projects.
      if (objectKind === 'feature' && item.harness !== harness) return [];
      const owner = item.assignee?.trim();
      return owner ? [owner] : [];
    } catch {
      // Owner enrichment is additive; a work-item read failure must leave the
      // subscription/topic audience deliverable.
      return [];
    }
  },
  async listActivePresence(): Promise<ActivePresence[]> {
    const recs = await listPresence();
    const active: ActivePresence[] = [];
    for (const r of recs) {
      if (r.stale || r.revoked) continue;
      active.push({ ownerId: r.ownerId, planSlug: r.currentPlanSlug, files: r.currentFiles });
    }
    return active;
  },
  async listPathLockAgents(path): Promise<string[]> {
    // The AUTOMATIC half of `@file:` (EI-18772330418885814). The presence half
    // (current_files) is opt-in and near-always empty — see the rationale on the
    // `@file:` branch in ./audience — so without this the selector the playbook
    // points agents at for "who is on this file" answered ZERO while a peer held a
    // live lock, and did so with language that reads as proof of absence.
    //
    // Domain: `null` = read across EVERY coordination domain, which su-lock-store
    // documents as the right mode for a non-ENFORCEMENT reader ("wrong for any
    // 'what is this agent holding?' read, where `owner` is already globally
    // unique"). Deliberate, and load-bearing here: a domain-scoped read "reports a
    // genuinely-held lock as absent — silently", which is precisely the failure this
    // whole fix exists to remove. The domain landscape makes that risk concrete —
    // observed live 2026-07-27, an su agent editing the STAGING tree had its lock
    // recorded under `/…/papercup-release` (the domain resolves from whichever
    // checkout the OPERATOR process loaded), so a reader that pinned "this
    // checkout" could silently miss real holders. An audience is not a mutex: a
    // false POSITIVE only means an extra agent hears about a path they are working
    // on, while a false NEGATIVE is the collision we are fixing.
    //
    // Fail-soft on EVERY error (locks unconfigured, side-DB unreachable, a path the
    // lock plane refuses): the coord send path must never break because the lock
    // plane is down — degrade to the presence-only audience, i.e. exactly the
    // pre-fix behavior.
    try {
      // Canonicalize to the form the lock key hashes on, so `./a/b.ts` and `a/b.ts`
      // both match the stored row. Throws on absolute/traversal paths — caught below.
      const canonical = normalizePaths([path])[0];
      if (!canonical) return [];
      await ensureBootstrap();
      const queue = await readQueue(getTxPool(), {
        coordinationDomain: null,
        paths: [canonical],
      });
      const ids = new Set<string>();
      // readQueue already filters holders to expires_ts > clock_timestamp() and
      // waiters to status='waiting', so both sets are live by construction.
      for (const lock of queue.active_locks) ids.add(lock.owner);
      for (const waiter of queue.waiting) ids.add(waiter.owner);
      return [...ids];
    } catch {
      return [];
    }
  },
  async listTaggedTopics(objectKind, objectRef) {
    // Best-effort: a links-query failure must never drop the whole emission.
    try {
      const links = await linkStore.listOut({ kind: objectKind, ref: objectRef }, { rel: 'tagged' });
      return links.filter((l) => l.dst.kind === 'topic').map((l) => l.dst.ref);
    } catch {
      return [];
    }
  },
  // P-003: the DIAGNOSTIC sibling of listFleetMembers — who this `@fleet:` audience
  // dropped, and why. Fail-soft to [] (an unavailable roster must never fail a send);
  // callers therefore read [] as "no omissions KNOWN", not as "nobody was dropped".
  //
  // Deliberately reports only the drops made by the LOCAL presence resolver. The
  // federated/leader union below can only ADD recipients, and a delivery override
  // (muted/digest) is a recipient's own standing choice rather than a delivery failure —
  // folding either in would make `omitted` mean two different things.
  async explainFleetAudience(fleetSlug) {
    try {
      const { omitted } = await liveFleetMemberIdsDiagnosed(
        fleetSlugFromName(fleetSlug),
        coordWorkspaceId(),
      );
      return omitted;
    } catch {
      return [];
    }
  },
  async listFleetMembers(fleetSlug) {
    // The @fleet: DELIVERY audience: live members (coord_presence.fleet_slug label,
    // mig 407) MINUS those who set a per-member delivery override (D-001). Slugify so
    // `@fleet:Backend Team` resolves to the stored handle; workspace-scoped (the slug
    // is unique only per-workspace, mig 406).
    //   muted  → excluded entirely (no live `to`; history still pullable via coord:catch-up)
    //   digest → excluded from the live `to`; a terse coalesced notify is delivered
    //            separately in the send path (deliverFleetDigests)
    // NB: this is the deliverable audience, NOT a membership check — the catch-up gate
    // checks membership directly (fetchPresenceFleet) so a muted member still reads history.
    const slug = fleetSlugFromName(fleetSlug);
    const members = await listFleetControlMembers(slug);
    const overrides = await getFleetDeliveryOverrides(slug);
    if (overrides.size === 0) return members;
    return members.filter((id) => {
      const mode = overrides.get(id);
      return mode !== 'muted' && mode !== 'digest';
    });
  },
  async listFleetLeader(fleetSlug) {
    // The current leader from the durable registry (agent_fleets.leader_owner_id) —
    // NOT liveness-gated, so an escalation reaches the lead even if they're offline
    // (it lands in their durable inbox for when they return). Null leader → no one.
    const slug = fleetSlugFromName(fleetSlug);
    const ws = coordWorkspaceId();
    let localFleet: Awaited<ReturnType<typeof getFleet>> = null;
    let localRegistryLeader: string | null = null;
    try {
      localFleet = await getFleet(ws, slug);
      localRegistryLeader = localFleet?.leaderOwnerId ?? null;
    } catch {
      /* registry unavailable */
    }
    if (localRegistryLeader) return [localRegistryLeader];
    // P-301: the durable registry row may live on ANOTHER machine (so the local read
    // is null) — derive the leader from a federated member advertising
    // fleet_role='leader'. Best-effort: no federated signal → no leader.
    try {
      const federatedMembers = await listFederatedFleetMembers({
        workspaceId: ws,
        fleetSlug: slug,
        staleMs: PRESENCE_STALE_MS,
      });
      const lead = resolveFederatedFleetLeader({ localRegistryLeader: null, federatedMembers });
      if (lead) return [lead];
    } catch {
      // Continue to the durable wind-down fallback below. A federated roster
      // failure must not erase the local lifecycle history.
    }

    // fleet:leave intentionally clears the current registry pointer for an
    // active fleet, but a leader leaving DURING wind-down still needs to be a
    // durable recipient for the final stand-down report. The append-only
    // membership ledger retains the last recorded leader after presence and
    // the registry pointer have been cleared. Never use this history fallback
    // for an active leaderless fleet: that would resurrect stale authority.
    if (localFleet?.controlState === 'winding-down') {
      try {
        const lastLeader = await latestFleetLeader(ws, slug);
        return lastLeader ? [lastLeader] : [];
      } catch {
        /* history unavailable — unresolved audience is safer than a failed send */
      }
    }
    return [];
  },
  // EI-22180848452883121: the reaped-recipient probe behind `unreachableSelectors`.
  //
  // Reuses the SAME roster oracle the direct-id path already refuses on
  // (`unknown_recipient` — recipient-resolve.ts calls its miss set "typos /
  // dead-and-swept"), so a selector can no longer launder an address that the
  // identical literal id would have been refused for. That asymmetry WAS the bug:
  // `coord:send { to: ['su-98873d1c…'] }` refused, while an `@fleet-leader:` selector
  // resolving to that very id returned ok:true / recipients_resolved:1.
  //
  // Diagnostic only — it never changes who is delivered to, so the deliberate
  // liveness-independence of `listFleetLeader` above is untouched: an ended-but-
  // recorded leader is still IN the roster and still gets its durable inbox.
  //
  // Fail-soft in the direction that cannot manufacture a false refusal: a null
  // roster (read unavailable) reports NOTHING unreachable rather than declaring
  // every recipient dead.
  async listUnreachableRecipients(ids) {
    try {
      const known = await knownOwnerIdSet(coordWorkspaceId());
      if (!known) return [];
      return ids.filter((id) => !known.has(id));
    } catch {
      return [];
    }
  },
};

/**
 * The fleet-wide kill-switch (D-005): `PAPERCUSP_COORD_EMIT_SCOPE=broadcast`
 * makes every selector collapse back to `['*']` — an instant revert to the
 * legacy global broadcast without a code change, for the case where scoping
 * ever starves real coordination. Default (`scoped`, or unset) honors watchers.
 */
export function audienceMode(): AudienceMode {
  return process.env.PAPERCUSP_COORD_EMIT_SCOPE === 'broadcast' ? 'broadcast' : 'scoped';
}

/**
 * Canonicalize a single audience selector for durable storage / lookup: fleet
 * selectors are slugified (so `@fleet:Backend Team` and `@fleet:backend-team` key
 * the same history, matching how the resolver slugifies); every other selector is
 * stored as-typed (trimmed). Shared by the send path (which preserves the key on
 * the envelope) and the catch-up read (which queries by it), so write and read
 * always agree. (fleet-broadcast-audience-history-integration-2026-06-30 D-003.)
 */
export function canonicalizeAudienceSelector(sel: string): string {
  for (const prefix of ['@fleet-leader:', '@fleet:']) {
    if (sel.startsWith(prefix)) {
      const body = sel.slice(prefix.length).trim();
      return body ? `${prefix}${fleetSlugFromName(body)}` : sel;
    }
  }
  return sel.trim();
}

/**
 * The durable audience KEY for an envelope: the original `@`-selectors + `*` from
 * `to`, canonicalized + deduped. Plain ownerIds are omitted — they're already
 * queryable by `to`, so the audience key is exactly the selector provenance that
 * expandAudience would otherwise discard. Empty for a plain-id-only send.
 */
export function deriveAudienceKey(to: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of to) {
    if (t === '*') out.add('*');
    else if (t.startsWith('@')) out.add(canonicalizeAudienceSelector(t));
  }
  return [...out];
}
