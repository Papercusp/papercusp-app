/**
 * lock-set-reconstructor — the HANDOVER state machine (D-005 of
 * distributed-coordination-shared-harness-2026-06-04).
 *
 * When the lock authority for a harness fails over (the previous authority's
 * presence went stale → the next-lowest live peer is now the authority,
 * automatically, per the deterministic selection), the new authority starts with
 * NO lock state. Holders re-assert their locks to it via TTL heartbeats; within
 * one heartbeat interval the authority has heard from every live holder and its
 * lock set is rebuilt. The brief gap before that is FAIL-OPEN (D-004 — git is the
 * data backstop), never a block.
 *
 * This is that reconstruction, as a pure, injected-clock state machine:
 *  - `assert(path, owner, ttlMs)` — a holder re-asserts a lock (a heartbeat).
 *  - `hydrateFromEvents(locks)` — seed the set INSTANTLY from the federated
 *    lock-event stream (P-015), skipping the heartbeat-interval wait.
 *  - `current()` — the active (non-expired) lock set.
 *  - `isRebuilt()` — true once the set is authoritative: either hydrated from the
 *    lock-event stream, or a full heartbeat interval has elapsed since takeover
 *    (so every live holder has had a chance to re-assert).
 *  - `shouldFailOpen()` — true during the rebuild gap; the authority grants
 *    optimistically (fail-open) until rebuilt, so a contended acquire mid-handover
 *    never blocks on incomplete state.
 *
 * Two reconstruction sources, instant preferred with the slow path as the floor:
 *  1. INSTANT (P-015) — `hydrateFromEvents` folds the append-only lock-event
 *     stream on the peer-log (see ./lock-event-stream) the moment the new
 *     authority takes over. When the stream yields state, the set is authoritative
 *     immediately (no fail-open gap).
 *  2. FALLBACK — holders re-assert their TTL heartbeats; the set is authoritative
 *     after one heartbeat interval. This is the floor when the stream is
 *     unavailable (no replica yet, not federating, read error) — the fail-open
 *     contract (D-004) is preserved either way.
 *
 * The transport that carries the heartbeats (holder → authority RPC) is the same
 * PeerRpcTransport seam; this state machine is the authority-side accumulation it
 * feeds, and is fully testable without a live mesh.
 */

export interface HeldLock {
  path: string;
  owner: string;
  /** epoch ms after which this assertion is stale (the holder must re-heartbeat). */
  expiresAtMs: number;
}

export interface LockSetReconstructorOpts {
  /** epoch ms when this peer became the authority (the handover start). */
  becameAuthorityAtMs: number;
  /** One heartbeat interval — the window within which holders re-assert. The set
   *  is considered rebuilt once this has elapsed. */
  heartbeatMs: number;
  /**
   * The monotonic FENCING epoch this authority was elected under (the same token
   * a grant minted now carries; see {@link ./hardened-authority}). When set, a
   * heartbeat re-assertion ({@link LockSetReconstructor.assert}) carrying an OLDER
   * epoch is FENCED OUT — a deposed authority's holder cannot re-assert a hold
   * minted under a stale grant over the new authority's lock set (the split-brain
   * the grant fence already blocks, now closed on the reconstructor leg too).
   * Omit (or 0) to keep the unfenced behaviour — every assert is accepted (the
   * single-box / no-federation default, where there is no prior epoch to fence).
   */
  epoch?: number;
}

export class LockSetReconstructor {
  private readonly locks = new Map<string, HeldLock>();
  private readonly startMs: number;
  private readonly heartbeatMs: number;
  /** The fencing epoch this authority was elected under; 0 = unfenced. */
  private readonly epoch: number;
  /** True once the set was seeded instantly from the lock-event stream (P-015):
   *  the set is then authoritative immediately, bypassing the heartbeat wait. */
  private hydrated = false;

  constructor(opts: LockSetReconstructorOpts) {
    this.startMs = opts.becameAuthorityAtMs;
    this.heartbeatMs = opts.heartbeatMs;
    this.epoch = opts.epoch ?? 0;
  }

  /**
   * INSTANT handover (P-015): seed the lock set from the federated lock-event
   * stream — the live locks already folded by `reconstructLockSet`. When `locks`
   * is non-empty the set becomes authoritative IMMEDIATELY (`isRebuilt` true, no
   * fail-open gap), so the new authority serializes against the real lock set
   * without waiting a heartbeat interval. Returns true when it hydrated.
   *
   * An EMPTY `locks` is a no-op that leaves the reconstructor in the
   * heartbeat-reassert fallback — the documented behavior when the stream is
   * unavailable (no replica / not federating / read error). Only TTL-live locks
   * are kept (an already-expired event contributes nothing).
   */
  hydrateFromEvents(locks: HeldLock[], nowMs: number): boolean {
    if (locks.length === 0) return false;
    let seeded = false;
    for (const l of locks) {
      if (l.expiresAtMs > nowMs) {
        this.locks.set(l.path, { path: l.path, owner: l.owner, expiresAtMs: l.expiresAtMs });
        seeded = true;
      }
    }
    if (seeded) this.hydrated = true;
    return seeded;
  }

  /**
   * A holder re-asserts its lock (a heartbeat RPC). Last assertion per path wins
   * (a holder owns the path; a re-assert refreshes the TTL).
   *
   * FENCING (D-006, the split-brain close): when this reconstructor carries an
   * `epoch` AND the caller passes the `assertEpoch` the holder's grant was minted
   * under, a re-assertion stamped with an OLDER epoch is REJECTED — a no-op. That
   * stops a deposed authority's holder (whose hold was granted under a stale
   * epoch) from clobbering the current-epoch lock set during the split-brain
   * window. Returns true if the assertion was applied, false if it was fenced out.
   * An omitted `assertEpoch` (or an unfenced reconstructor) is always applied — the
   * unfenced default, preserved for the single-box / no-federation path.
   */
  assert(path: string, owner: string, ttlMs: number, nowMs: number, assertEpoch?: number): boolean {
    if (!path || !owner) return false;
    // Fence: a stale-epoch re-assert from a deposed authority's holder is dropped.
    if (this.epoch > 0 && assertEpoch !== undefined && assertEpoch < this.epoch) return false;
    this.locks.set(path, { path, owner, expiresAtMs: nowMs + ttlMs });
    return true;
  }

  /** Drop assertions that have aged out (the holder stopped re-asserting). */
  prune(nowMs: number): void {
    for (const [path, lock] of this.locks) {
      if (lock.expiresAtMs <= nowMs) this.locks.delete(path);
    }
  }

  /** The active reconstructed lock set (non-expired). */
  current(nowMs: number): HeldLock[] {
    return [...this.locks.values()].filter((l) => l.expiresAtMs > nowMs);
  }

  /** Is `path` held by someone OTHER than `owner` right now? (the contended check
   *  the authority uses once rebuilt). */
  isHeldByOther(path: string, owner: string, nowMs: number): boolean {
    const l = this.locks.get(path);
    return !!l && l.expiresAtMs > nowMs && l.owner !== owner;
  }

  /** True once the set is authoritative: either hydrated instantly from the
   *  lock-event stream (P-015), or a full heartbeat interval has elapsed since
   *  takeover (every live holder has had the chance to re-assert). */
  isRebuilt(nowMs: number): boolean {
    return this.hydrated || nowMs - this.startMs >= this.heartbeatMs;
  }

  /** True during the rebuild gap: the authority should grant optimistically
   *  (fail-open, D-004) rather than block on a not-yet-complete lock set. */
  shouldFailOpen(nowMs: number): boolean {
    return !this.isRebuilt(nowMs);
  }
}
