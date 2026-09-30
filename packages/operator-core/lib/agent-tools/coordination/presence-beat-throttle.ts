/**
 * presence-beat-throttle — a per-owner in-process rate limiter for
 * coord_presence LIVENESS writes (EI-6797).
 *
 * Background: every liveness write is a hot write against the small,
 * heavily-indexed-and-triggered `harness_shared.coord_presence` table
 * (PK on owner_id + 3 partial indexes + triggers, incl. an unconditional
 * `pg_notify` on every write). Under a busy fleet — dozens of concurrently
 * active agents each looping `coord:orient` (→ `coord:inbox`) on a wake
 * cadence — the SYNCHRONIZED burst of these writes saturates PostgreSQL's
 * internal lock-manager (`Lock:transactionid` domino waits), stalling
 * UNRELATED write statements (`work_items` claims etc.) queued behind the
 * same lock traffic. Observed live 2026-07-02: 121/313 backends waiting on
 * a Lock, 84 concurrently touching coord_presence, every write-side MCP
 * tool timing out fleet-wide while reads kept working.
 *
 * The dispatch beat (`touchActivity`) already coalesces to ≤1 write per
 * window per owner via a module-scope throttle. This module extracts that
 * discipline into a reusable factory so the OTHER hot liveness path — the
 * `coord:inbox` `heartbeatPresence` upsert (the report's dominant
 * `INSERT ... ON CONFLICT ... DO UPDATE` wait pattern), which fired
 * UNTHROTTLED on every inbox/orient call — is coalesced the same way, cutting
 * the heavy-upsert write volume at the source.
 *
 * Each throttle owns its OWN Map (independent state) so the two paths never
 * suppress one another — critical because `heartbeatPresence` MINTS the
 * presence row if absent while `touchActivity` is a no-op on a missing row;
 * a shared window would let a no-op dispatch beat starve the row-minting
 * inbox beat. First call for an owner always beats (mints/refreshes); later
 * calls within the window are skipped.
 *
 * The throttle Map is per-process, in-memory rate-limiting state — NOT
 * durable state — so the storage-policy no-module-scoped-state rule does not
 * apply (losing it on restart costs at most one extra indexed write per
 * owner). Semantics are byte-identical to the prior inline dispatch throttle.
 */

/** Minimum gap between liveness beats for one owner. Presence staleness
 *  windows are 60s (roster LIVE_MS) and 10min (claims sweep) — 45s keeps
 *  both fresh while costing at most ~1.3 writes/min per busy agent. */
export const PRESENCE_BEAT_INTERVAL_MS = 45_000;

/** Drop throttle entries idle past this many windows (bounds the Map). */
const GC_IDLE_WINDOWS = 10;
const GC_SIZE_TRIGGER = 2_000;

export interface PresenceBeatThrottle {
  /**
   * Returns true (and records the beat) if a liveness write is due for this
   * owner, or false if one fired within the window. Injectable `now` keeps
   * unit tests pure (no fake timers fighting fire-and-forget writes).
   */
  shouldBeat(ownerId: string, now?: number): boolean;
  /** Test seam: clear all throttle state. */
  reset(): void;
  /** Current entry count (diagnostics/tests). */
  size(): number;
}

/**
 * Create an independent per-owner beat throttle. Each call returns a fresh
 * throttle with its own Map — instantiate one per distinct liveness write
 * path so paths never cross-suppress.
 */
export function createPresenceBeatThrottle(
  intervalMs: number = PRESENCE_BEAT_INTERVAL_MS,
): PresenceBeatThrottle {
  const lastBeat = new Map<string, number>();

  return {
    shouldBeat(ownerId: string, now: number = Date.now()): boolean {
      // `has`-based, not a `?? 0` sentinel: the first call for an owner ALWAYS
      // beats regardless of the clock value (a 0-sentinel would wrongly
      // suppress an owner first seen at now≈0).
      const last = lastBeat.get(ownerId);
      if (last !== undefined && now - last < intervalMs) return false;
      lastBeat.set(ownerId, now);

      if (lastBeat.size > GC_SIZE_TRIGGER) {
        const cutoff = now - GC_IDLE_WINDOWS * intervalMs;
        for (const [k, t] of lastBeat) {
          if (t < cutoff) lastBeat.delete(k);
        }
      }
      return true;
    },
    reset(): void {
      lastBeat.clear();
    },
    size(): number {
      return lastBeat.size;
    },
  };
}
