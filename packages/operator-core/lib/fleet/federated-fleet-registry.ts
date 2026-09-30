/**
 * federated-fleet-registry — the PURE resolver that ports the 2026-07-02
 * multi-fleet-leadership registry-union fix (audience-host.ts) to the CROSS-MACHINE
 * view (p2p-work-distribution-2026-07-02 P-301).
 *
 * Background — the local fix it generalizes:
 *   A session leading SEVERAL fleets carries only its newest fleet's label on
 *   coord_presence.fleet_slug (the column is singular, mig 407), so folding
 *   `@fleet:<slug>` from presence alone silently drops the leader from every OTHER
 *   fleet's member audience. audience-host.ts fixed this LOCALLY by unioning the
 *   durable registry leader (agent_fleets.leader_owner_id) into the presence members.
 *
 * The cross-machine generalization (P-301): once a fleet's members + leader can live
 * on DIFFERENT machines, the same union must also fold in:
 *   (a) FEDERATED members — remote live sessions carrying this fleet_slug, projected
 *       from the session-presence gossip into shared_session_presence (mig 479); and
 *   (b) a FEDERATED leader — when the durable agent_fleets row (and thus its
 *       leader_owner_id) lives on ANOTHER machine, the local registry read returns
 *       null, so the leader is derived from a federated member advertising
 *       fleet_role='leader'.
 *
 * This module is PURE (no PG, no imports beyond types) so the union/leader semantics
 * are unit-testable in isolation; audience-host.ts supplies the IO (local presence,
 * federated presence, the local registry row) and calls these.
 *
 * ADDITIVE + inert on a single box: with no federated peers the federated inputs are
 * empty and every function collapses to exactly today's local-only behavior.
 */

/** A federated fleet member as projected from shared_session_presence (mig 479):
 *  a remote live session's real ownerId + its advertised fleet role. */
export interface FederatedFleetMember {
  /** The remote session's real ownerId (su-<uuid> / bee / queen id) — directly
   *  addressable, exactly like a local coord_presence owner. */
  ownerId: string;
  /** 'leader' | 'member' (advisory, free text — mirrors coord_presence.fleet_role).
   *  Null/absent on rows written before the membership columns landed. */
  fleetRole?: string | null;
}

/**
 * Resolve a fleet's leader across machines. The durable LOCAL registry row wins when
 * present (it is the accountable identity, D-002, and — unlike live presence — reaches
 * an OFFLINE leader's durable inbox). Only when the registry row lives on another
 * machine (localRegistryLeader == null) do we derive the leader from a federated member
 * advertising fleet_role='leader'. Deterministic on ties: the lowest ownerId, so every
 * machine agrees on the same derived leader without coordination.
 *
 * Returns null when neither source names a leader (a leaderless fleet).
 */
export function resolveFederatedFleetLeader(input: {
  /** agent_fleets.leader_owner_id from the LOCAL durable registry (null if the fleet's
   *  registry row is not on this machine, or the fleet has no leader set). */
  localRegistryLeader?: string | null;
  /** Federated live members (shared_session_presence) with their advertised roles. */
  federatedMembers?: readonly FederatedFleetMember[];
}): string | null {
  const local = normalizeId(input.localRegistryLeader);
  if (local) return local;
  const leaders = (input.federatedMembers ?? [])
    .filter((m) => (m.fleetRole ?? '').toLowerCase() === 'leader')
    .map((m) => normalizeId(m.ownerId))
    .filter((id): id is string => id !== null);
  if (leaders.length === 0) return null;
  // Deterministic pick so independent machines converge on the same leader.
  return leaders.sort()[0];
}

/**
 * Union a fleet's audience members across the local roster, the federated roster, and
 * the (possibly cross-machine) leader — the cross-machine form of audience-host's
 * "the leader is definitionally a member" union. Order is stable + provenance-ordered:
 * local members first (in given order), then federated members not already present,
 * then the leader if still absent. Deduped; blank/nullish ids dropped.
 *
 * The leader is folded in LAST-if-missing (never reordered ahead of a real member) so
 * an already-present leader keeps its natural position — matching the local fix, which
 * only pushes the leader when `!members.includes(lead)`.
 */
export function unionFederatedFleetMembers(input: {
  localMemberIds?: readonly string[];
  federatedMemberIds?: readonly string[];
  leaderOwnerId?: string | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined): void => {
    const id = normalizeId(raw);
    if (id === null || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of input.localMemberIds ?? []) push(id);
  for (const id of input.federatedMemberIds ?? []) push(id);
  push(input.leaderOwnerId);
  return out;
}

/** Trim + reject empty; a normalized id is a non-empty string. */
function normalizeId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}
