/**
 * presence-reaper.ts — the coord_presence RETENTION reaper
 * (presence-coord-unification-2026-07-01 P-004, WI-1347).
 *
 * "Consistent retention: a reaper evicts ended/stale coord_presence rows on a
 * TTL; long-term history lives ONLY in the append-only coord log + adv_sessions
 * ... No de-associated dead rows."
 *
 * The naive approach — delete anything whose heartbeat is older than a TTL,
 * exactly what the pre-existing 24h `sweepStalePresence` GC backstop does — is
 * WRONG: a `parked` row (stale heartbeat, but a still-live standing
 * `coord:inbox-wake` await) is the coordinator's IDEAL dispatch target
 * (presence-wakeability.ts §deriveSessionState) and must survive indefinitely
 * however old its heartbeat is. Only an `ended` row — NOT wakeable, i.e. no
 * live/unfired/uncancelled/unexpired inbox-wake await — is safe to evict, and
 * only once it's ALSO been ended for at least the TTL (so a row doesn't vanish
 * the instant its wake await lapses).
 *
 * This reaper reuses `fetchWakeability`'s exact predicate (the same one
 * coord:presence / fleet:status already surface as `sessionState`) rather than
 * re-deriving liveness, so "safe to reap" here can never drift from "shown as
 * ended" there.
 *
 * History is not lost on delete: named-fleet membership survives via the
 * append-only `fleet_membership_events` ledger (WI-1345 / migration 430 — a DB
 * projection trigger re-materializes it onto a fresh coord_presence row the next
 * time the owner writes presence), and session lifecycle survives via
 * `adv_sessions`. This reaper only removes the LIVE-roster row itself.
 */

import { getOrgPg } from '@papercusp/db-org';
import { listPresence } from './presence';
import { fetchWakeability } from './presence-wakeability';
import { readCoordLivenessConfig, COORD_LIVENESS_DEFAULTS } from '../../coord-liveness-config';

/** The minimal per-row shape `planPresenceReap` needs — a projection of
 *  `PresenceRecord`, kept narrow so the pure fn unit-tests without importing
 *  the full store type. */
export interface PresenceReapCandidate {
  ownerId: string;
  heartbeatAt: string;
}

/**
 * PURE: which owner ids are safe to reap right now.
 *
 * A row is reaped iff BOTH hold:
 *   1. NOT wakeable (absent from `wakeableOwnerIds` — the `ended` cohort;
 *      a `parked`/`live` row is always in the set and is therefore NEVER
 *      reaped, regardless of how stale its heartbeat reads).
 *   2. its heartbeat is at least `ttlMs` old (so an `ended` row gets a grace
 *      window — e.g. a session that crashed a second ago — before eviction).
 *
 * Injected inputs (rows, the wakeable set, now, ttl) so this is fully
 * unit-testable without PG. Exported for tests.
 */
export function planPresenceReap(
  rows: readonly PresenceReapCandidate[],
  wakeableOwnerIds: ReadonlySet<string>,
  nowMs: number,
  ttlMs: number,
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (wakeableOwnerIds.has(r.ownerId)) continue; // parked/live — never reaped
    const heartbeatMs = Date.parse(r.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) continue; // unparseable timestamp — skip, don't guess
    if (nowMs - heartbeatMs < ttlMs) continue; // ended, but still inside the grace window
    out.push(r.ownerId);
  }
  return out;
}

export interface PresenceReapResult {
  /** Rows actually deleted. */
  reaped: number;
  /** The reaped owner ids (bounded by the roster size — never huge). */
  ownerIds: string[];
  /** Rows considered but left alone (parked/live, or ended-but-inside-grace). */
  skipped: number;
  /** Auto/suggested awaits + predicate watches retired with the dead owners. */
  boundWatchesRetired: number;
}

const EMPTY_RESULT: PresenceReapResult = { reaped: 0, ownerIds: [], skipped: 0, boundWatchesRetired: 0 };

/**
 * IO: read the WHOLE (all-workspace) coord_presence roster, batch-fetch
 * wakeability for it (the same query shape the live presence snapshot already
 * pays for), plan the reap, and DELETE exactly the planned owner ids — never a
 * blunt age-only DELETE. `ttlMs` defaults to the coord-liveness-config override
 * (or its baked default, 4h) when omitted — the scheduled tick's call.
 *
 * Best-effort: any read/plan failure propagates to the caller (the scheduled
 * tick already wraps this in a DBOS step + retentionEnabled fail-safe), but an
 * empty roster or an empty plan short-circuits cleanly rather than issuing a
 * no-op DELETE.
 */
export async function reapEndedPresenceRows(
  opts: { ttlMs?: number; nowMs?: number } = {},
): Promise<PresenceReapResult> {
  const nowMs = opts.nowMs ?? Date.now();
  let ttlMs = opts.ttlMs;
  if (ttlMs == null) {
    const cfg = await readCoordLivenessConfig();
    ttlMs = cfg.presenceReaperTtlMs ?? COORD_LIVENESS_DEFAULTS.presenceReaperTtlMs;
  }

  const rows = await listPresence({});
  if (rows.length === 0) return EMPTY_RESULT;

  const ownerIds = rows.map((r) => r.ownerId);
  const wakeability = await fetchWakeability(ownerIds);
  const wakeableOwnerIds = new Set(ownerIds.filter((id) => wakeability.get(id)?.wakeable === true));
  const candidates: PresenceReapCandidate[] = rows.map((r) => ({
    ownerId: r.ownerId,
    heartbeatAt: r.heartbeatAt,
  }));
  const toReap = planPresenceReap(candidates, wakeableOwnerIds, nowMs, ttlMs);
  if (toReap.length === 0) {
    return { reaped: 0, ownerIds: [], skipped: rows.length, boundWatchesRetired: 0 };
  }

  // P-013 / D-003: retire the reaped owners' pending watches BEFORE deleting
  // the presence rows. If cleanup fails the presence row remains for the next
  // scheduled retry; deleting first would erase the only lifecycle edge and
  // strand the watches forever.
  //
  // WI-10002094: this sweep used to skip manual awaits (bound_to=NULL), which
  // left them stranded permanently precisely BECAUSE deleting the presence row
  // removes the only edge that could ever reach them again. `toReap` is already
  // TTL-expired AND non-wakeable, so retiring them here is safe. Declared gates
  // (policy='announce') are still preserved by the store.
  const { retireWatchesForReapedOwners } = await import('../../events/await/store');
  const retired = await retireWatchesForReapedOwners(toReap);

  const { sql } = getOrgPg();
  const deleted = await sql<{ owner_id: string }[]>`
    DELETE FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${toReap}::text[])
    RETURNING owner_id
  `;
  const reapedIds = deleted.map((r) => r.owner_id);
  // WI-5317: free any delegated seats the reaped (confirmed-dead) members held, so
  // their consumption row goes the moment we reap their presence instead of
  // lingering to the next lazy purge. Best-effort — seat-accounting's liveness
  // predicate is still the load-bearing floor.
  if (reapedIds.length > 0) {
    try {
      const { releaseSeatConsumptions } = await import('../../fleet/seat-accounting');
      await releaseSeatConsumptions(reapedIds);
    } catch {
      /* seat cleanup is hygiene, never load-bearing */
    }
  }
  return {
    reaped: deleted.length,
    ownerIds: reapedIds,
    skipped: rows.length - deleted.length,
    boundWatchesRetired: retired.awaits + retired.predicateWatches,
  };
}
