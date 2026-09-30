/**
 * severe-event-owner — the ownership/routing leg for severe-event broadcasts
 * (EI-10060, a follow-up to EI-9939's flap-episode suppression).
 *
 * ## The gap this closes
 *
 * EI-9939 stops a repeating severe-event condition from re-broadcasting to the whole
 * fleet (`to: ['*']`) forever — after 2 fires it digest-suppresses. Peer review of the
 * 2026-07-12 fleet retrospective found this is HALF the fix: suppression-to-digest
 * without a ROUTED responsible party creates the dual failure — everyone digest-defers
 * AND nobody acts, because nobody was ever ON THE HOOK for the condition.
 *
 * This module resolves, for a given condition key, WHO is responsible:
 *   1. a registered condition owner (a small static registry, extensible per class), else
 *   2. the relevant fleet leader — ONLY when the caller can name a fleet the condition
 *      belongs to (this module never guesses; the caller alone knows that domain fact), else
 *   3. unresolved (`null`) — the caller is expected to escalate toward human attention
 *      instead of relying on the ambient broadcast alone.
 *
 * Deliberately NOT a database-backed registry yet (see the plan's Phase 3 non-goal) — a
 * hardcoded map, grown as real condition classes get an identified owner, is the
 * appropriately-scoped Phase 1: it needs zero migration, zero admin UI, and is trivially
 * auditable in a code review. Phase 3 revisits this IF the static map's coverage proves
 * too narrow once real routing data exists.
 *
 * Full design: docs/plans/severe-event-ownership-routing-2026-07-18.md.
 */

/**
 * The static condition-key -> owner registry. Keys are PREFIXES matched against the
 * start of the incoming condition key (e.g. `'health-tick-stale'` matches
 * `'health-tick-stale'` and `'health-tick-stale:papercusp'` alike) — most condition
 * keys carry a `:<install_slug>` / `:<detail>` suffix, and the registry should route
 * the whole CLASS, not one exact instance.
 *
 * `'@role:<slot>'` is the SAME stable-slot coord:send addressing convention EI-2312
 * established for the Mug/Queen (`MUG_COORD_SLOT = '@role:mug'`,
 * packages/operator-core/lib/pot/placement-watchdog.ts) — reused here rather than
 * inventing a second addressing scheme. `@role:mug` is the fleet's own
 * general-purpose "keep the pot healthy" role, so it is the sensible default owner
 * for the fleet-health-flavored condition classes below.
 */
const CONDITION_OWNER_REGISTRY: ReadonlyArray<{ prefix: string; ownerSelector: string; reason: string }> = [
  {
    prefix: 'health-tick-stale',
    ownerSelector: '@role:mug',
    reason: 'a frozen health tick blinds fleet placement — the Mug is the fleet-health role responsible for noticing and driving a restart',
  },
  {
    prefix: 'dead-routines',
    ownerSelector: '@role:mug',
    reason: 'dead background routines stall placement + drains the Mug depends on',
  },
];

export interface SevereEventOwnerRoute {
  /** A coord:send audience selector ('@role:<slot>' or '@fleet-leader:<slug>') or a
   *  concrete ownerId — whichever resolved. */
  ownerSelector: string;
  /** Human-readable — who/why, for the directed message body. */
  reason: string;
  /** Which resolution step matched — 'registry' or 'fleet-leader'. */
  source: 'registry' | 'fleet-leader';
}

export interface ResolveSevereEventOwnerOpts {
  /** The fleet this condition belongs to, IF the caller can name one. Only the
   *  caller knows whether a condition is fleet-scoped — this module never guesses.
   *  When present and the static registry has no match, resolves to that fleet's
   *  current leader (`@fleet-leader:<slug>`, an EXISTING coord:send selector). */
  fleetSlug?: string | null;
}

/**
 * Resolve the responsible party for a severe-event condition key. Pure (no I/O) —
 * `@fleet-leader:<slug>` resolves to the LIVE leader at coord:send time, not here, so
 * this function never goes stale relative to a leadership change.
 */
export function resolveSevereEventOwner(
  conditionKey: string,
  opts: ResolveSevereEventOwnerOpts = {},
): SevereEventOwnerRoute | null {
  const key = conditionKey.trim();
  if (!key) return null;

  for (const entry of CONDITION_OWNER_REGISTRY) {
    if (key === entry.prefix || key.startsWith(`${entry.prefix}:`)) {
      return { ownerSelector: entry.ownerSelector, reason: entry.reason, source: 'registry' };
    }
  }

  const fleetSlug = opts.fleetSlug?.trim();
  if (fleetSlug) {
    return {
      ownerSelector: `@fleet-leader:${fleetSlug}`,
      reason: `condition '${key}' is scoped to fleet '${fleetSlug}' — its leader is the responsible party`,
      source: 'fleet-leader',
    };
  }

  return null;
}
