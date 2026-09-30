/**
 * @papercusp/file-claim — shared FileClaimCoordinator vocabulary.
 *
 * file-locking-improvements #11. Papercusp has two file-claim
 * coordinators that grew up independently:
 *
 *   - `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts`
 *     (in-process; async worker dispatches inside one orchestrator
 *      Node process; Map-backed)
 *   - `apps/operator/lib/agent-tools/locks/su-lock-store.ts`
 *     (cross-process; independent papercusp-su agents; PG-backed)
 *
 * They share a contract (acquire/release/extend/heartbeat/reap, FIFO,
 * atomic multi-path) but ship with **different names, different
 * argument shapes, different deadlock-freedom rationales recorded in
 * headers**. Two engineers staring at the codebase shouldn't have to
 * learn two APIs that mean the same thing.
 *
 * This interface is the **vocabulary alignment** — not implementation
 * reuse. Each backend implements it via a thin adapter; the
 * `conformance` subsuite asserts that any implementation satisfies
 * the shared semantic contract (FIFO fairness, atomic multi-path,
 * release/extend invariants, reap idempotence).
 *
 * Per the plan, the interface deliberately:
 *   - Models "extend returns a NEW claim" (file-locking #10 — never
 *     mutate the caller's handle via a cast).
 *   - Uses a single `acquire(...)` with `waitMs` for backends that
 *     can block, and a `waitMs: 0` for backends that only do
 *     try-acquire. SU-locks-style "queue a waiter then poll" is an
 *     internal-to-adapter concern.
 *   - Surfaces a `busy[]` shape with the contending owner(s) so
 *     callers can render a useful refusal regardless of backend.
 */

/** Stable opaque identifier the coordinator returns on a successful
 *  acquire. Both backends use it: PG = uuid lock_id, in-process =
 *  fresh string per acquire. Required to release a specific claim
 *  (owner alone is insufficient since the same owner may hold
 *  multiple concurrent claims with different path sets). */
export interface FileClaim {
  readonly claimId: string;
  readonly owner: string;
  /** Sorted, deduplicated paths currently held by this claim. */
  readonly paths: readonly string[];
  /** Wall-clock expiry. `null` for backends without a TTL (the
   *  in-process coordinator: orphans clear on process restart, no
   *  per-claim timer needed). */
  readonly expiresAt: Date | null;
}

/** One contention entry: who holds (or recently held) one of the
 *  requested paths. Returned in the `busy` array of a failed acquire
 *  so callers can render a useful refusal. */
export interface BusyEntry {
  readonly path: string;
  readonly owner: string;
  readonly ownerLabel?: string | null;
  readonly intent?: string;
  /** Wall-clock expiry of the holder's claim if the backend tracks
   *  one. `null` / undefined when no TTL. */
  readonly expiresAt?: Date | null;
}

export type AcquireResult =
  | { readonly ok: true; readonly claim: FileClaim }
  | { readonly ok: false; readonly busy: readonly BusyEntry[] };

export interface AcquireOptions {
  /** Time-to-live for the claim. Ignored by backends that have none
   *  (in-process). Defaults are backend-defined. */
  readonly ttlMs?: number;
  /** Short string surfaced in `BusyEntry.intent` to disambiguate
   *  what the holder is doing (e.g. `"tool_call:write"`). */
  readonly intent?: string;
  /** Human-friendly owner label for diagnostics. */
  readonly ownerLabel?: string | null;
  /** Max wait when contended. `0` = no wait (return busy immediately).
   *  Adapters may cap this at their own ceilings. */
  readonly waitMs?: number;
}

export interface ExtendOptions {
  /** Additional paths to add to the claim. Existing paths are kept;
   *  the result reflects the union. Empty means "just bump TTL." */
  readonly addPaths?: readonly string[];
  /** Refresh TTL to this many ms from now. Ignored by no-TTL
   *  backends. */
  readonly ttlMs?: number;
}

export type ExtendResult =
  | { readonly ok: true; readonly claim: FileClaim }
  | { readonly ok: false; readonly busy: readonly BusyEntry[] };

export type HeartbeatResult =
  | { readonly ok: true; readonly claim: FileClaim }
  | { readonly ok: false; readonly expired: true };

/**
 * Cooperative file-claim coordinator.
 *
 * Invariants every adapter MUST preserve (the conformance suite
 * asserts these; see `./conformance`):
 *
 *   - **Atomic multi-path.** A single `acquire(paths)` either takes
 *     every path or none. Partial holds are never visible to callers.
 *   - **FIFO fairness per path.** Among waiters contending on the
 *     same path, earlier arrivals are granted first.
 *   - **No deadlock.** Atomic whole-set acquire = no caller holds a
 *     path while waiting on another. (The historical claim that
 *     alphabetic sort enforces deadlock-freedom is misleading — the
 *     no-hold-while-waiting property does. See file-locking #9.)
 *   - **Extend never mutates the input claim.** `extend()` always
 *     returns a fresh claim (file-locking #10).
 *   - **Release is idempotent.** Releasing a claim that's already
 *     released, or never existed, is a no-op (not an error).
 *   - **Reap drops every claim the owner currently holds and returns
 *     the count.** Subsequent reaps of the same owner return 0.
 *   - **Empty-path acquire is legal.** Returns a no-op claim with
 *     `paths === []` and a stable claimId. Simplifies callers that
 *     happen to compute an empty set.
 */
export interface FileClaimCoordinator {
  acquire(
    owner: string,
    paths: readonly string[],
    options?: AcquireOptions,
  ): Promise<AcquireResult>;

  release(claim: FileClaim): Promise<void>;

  extend(claim: FileClaim, options: ExtendOptions): Promise<ExtendResult>;

  heartbeat(claim: FileClaim, ttlMs?: number): Promise<HeartbeatResult>;

  /** Drop every claim the `owner` currently holds. Returns the count
   *  of claims dropped (NOT the count of paths). */
  reap(owner: string): Promise<number>;
}
