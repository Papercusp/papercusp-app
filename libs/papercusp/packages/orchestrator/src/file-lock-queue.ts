/**
 * FileLockQueue — exclusive, deadlock-free file-path locks for the
 * worker chunk loop.
 *
 * Why this exists: the chunk-locking model wants a worker to atomically
 * acquire a set of file paths, do its edits, commit, and release.
 * Multiple workers run concurrently and may want overlapping path sets.
 * We need a primitive that:
 *
 *   1. Acquires a whole set atomically (no partial holds).
 *   2. Never deadlocks, no matter how many workers contend.
 *   3. Is FIFO-fair per-path so hot files don't starve.
 *   4. Supports mid-chunk extension (atomic if all new paths are free,
 *      otherwise the caller must release-all and re-acquire).
 *
 * Deadlock-freedom comes from the no-hold-while-waiting rule: a caller
 * acquires its whole path set atomically and is never blocked on one
 * path while holding another — a waiter waits inside `acquire` before
 * it holds anything. That property alone makes deadlock impossible.
 * The alphabetical sort is NOT load-bearing for deadlock-freedom (an
 * earlier version of this header wrongly credited it); the sort only
 * buys FIFO determinism and stable indexing. An engineer porting this
 * pattern does not need to sort to stay deadlock-free.
 *
 * The extend operation is best-effort: it succeeds only when every new
 * path is free at the moment of the request; otherwise the caller
 * releases everything and re-acquires the full union.
 *
 * In-process only. The orchestrator runs in a single Node process; if
 * we ever need cross-process locking, the API surface stays the same
 * but the implementation switches to filesystem-backed advisory locks.
 *
 * Glob expansion is the caller's responsibility — pass in resolved
 * file paths, not patterns. Globs would either need to be expanded at
 * acquire time (slow + filesystem-dependent) or treated as opaque
 * strings (then `src/foo.ts` and `src/**` wouldn't conflict, defeating
 * the purpose). Forcing the caller to expand keeps the data model
 * simple.
 */

/**
 * Thrown by `acquire` when `options.timeoutMs` elapses before the
 * whole path set could be taken. Carries the paths the caller wanted
 * and the owners currently holding any of them — a degenerate hang
 * surfaces as a typed, attributable error instead of a forever-block.
 */
export class LockAcquireTimeoutError extends Error {
  readonly owner: string;
  readonly paths: readonly string[];
  readonly timeoutMs: number;
  readonly contendingOwners: readonly string[];
  constructor(
    owner: string,
    paths: readonly string[],
    timeoutMs: number,
    contendingOwners: readonly string[],
  ) {
    super(
      `FileLockQueue.acquire timed out after ${timeoutMs}ms for ${owner} ` +
        `on [${paths.join(', ')}]; contended by [${contendingOwners.join(', ')}]`,
    );
    this.name = 'LockAcquireTimeoutError';
    this.owner = owner;
    this.paths = paths;
    this.timeoutMs = timeoutMs;
    this.contendingOwners = contendingOwners;
  }
}

/** Per-acquire options. Omitted → today's behaviour (no timeout). */
export interface AcquireOptions {
  /** Reject with `LockAcquireTimeoutError` after this many ms. */
  timeoutMs?: number;
}

export interface LockHandle {
  /** Stable identifier used in diagnostics + reaping. Caller-supplied
   *  but typically `<feature-id>-<chunk-id>` or `<worker-pid>`. */
  readonly owner: string;
  /** Sorted, deduplicated list of paths currently held. Mutates on
   *  successful `extend`. */
  paths: readonly string[];
  /** Internal release callback — sets a flag so we no-op subsequent
   *  release() calls. */
  released: boolean;
}

interface Waiter {
  owner: string;
  /** Sorted list of paths the waiter wants to acquire atomically. */
  paths: readonly string[];
  /** Resolves with the LockHandle once all paths are taken. */
  resolve: (handle: LockHandle) => void;
  /** Resolves with an error if the queue is destroyed before grant. */
  reject: (err: Error) => void;
  /** Order-of-arrival sequence number, used for FIFO scheduling. */
  seq: number;
}

export class FileLockQueue {
  /** path → ownerId currently holding it. */
  private heldBy = new Map<string, string>();

  /** Ordered queue of pending waiters. We don't keep per-path queues
   *  because each waiter wants a *set* atomically — a per-path queue
   *  would break the all-or-nothing semantics. We process the queue
   *  on every release and grant any waiter whose entire set is free. */
  private waiters: Waiter[] = [];

  /** Monotonic sequence used both for FIFO and for diagnostics. */
  private nextSeq = 1;

  /** Set on destroy() so subsequent acquires reject immediately and
   *  pending waiters get drained. */
  private destroyed = false;

  /**
   * Acquire all paths atomically. Resolves once every path is held by
   * `owner`. If any path is held by someone else, the request joins
   * the FIFO and resolves later (after some release frees the
   * contended paths).
   *
   * Paths are normalized: whitespace-trimmed, deduplicated, sorted. The
   * sort is the deadlock-freedom rule.
   */
  async acquire(
    owner: string,
    paths: readonly string[],
    options?: AcquireOptions,
  ): Promise<LockHandle> {
    if (this.destroyed) throw new Error('FileLockQueue destroyed');
    const sorted = canonicalize(paths);
    if (sorted.length === 0) {
      // Empty acquire is legal (no-op handle); makes calling code
      // simpler when the chunk happens to declare zero files.
      return makeHandle(owner, sorted);
    }

    // Fast path: all free, no waiters ahead of us. Take immediately.
    if (this.waiters.length === 0 && this.allFree(sorted)) {
      this.takeAll(owner, sorted);
      return makeHandle(owner, sorted);
    }

    // Queued path. We push the waiter, then drain — drainWaiters may
    // immediately grant us if our path-set doesn't conflict with the
    // head waiter's reservation. (Without this, a non-conflicting
    // waiter would sit queued forever even though it could proceed.)
    return new Promise<LockHandle>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        owner,
        paths: sorted,
        resolve: (h) => {
          if (timer) clearTimeout(timer);
          resolve(h);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
        seq: this.nextSeq++,
      };
      this.waiters.push(waiter);
      // Opt-in timeout (#8). A degenerate hang (a holder that never
      // releases) surfaces as a typed error rather than a forever-block.
      if (options?.timeoutMs !== undefined) {
        const timeoutMs = options.timeoutMs;
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          const contending = new Set<string>();
          for (const p of sorted) {
            const held = this.heldBy.get(p);
            if (held) contending.add(held);
          }
          // waiter.reject clears the (already-fired) timer, then rejects.
          waiter.reject(
            new LockAcquireTimeoutError(owner, sorted, timeoutMs, [...contending]),
          );
        }, timeoutMs);
      }
      this.drainWaiters();
    });
  }

  /**
   * Try to add additional paths to an existing handle without
   * releasing what's already held. Succeeds only if every new path is
   * currently free AND no FIFO-earlier waiter wants any of them. On
   * success the handle's `paths` is updated to include them and
   * `release` will release all of them.
   *
   * On failure the caller should `release(handle)` and re-acquire the
   * full union via `acquire`. That's the deadlock-free fallback.
   */
  tryExtend(handle: LockHandle, additional: readonly string[]): boolean {
    if (this.destroyed) return false;
    if (handle.released) {
      throw new Error(`tryExtend: handle for ${handle.owner} already released`);
    }
    const want = canonicalize(additional).filter((p) => !handle.paths.includes(p));
    if (want.length === 0) return true;

    // Refuse if any older waiter is queued for any of these paths;
    // otherwise an extender perpetually starves a fair waiter.
    const hasEarlierWaiterWanting = this.waiters.some((w) =>
      w.paths.some((p) => want.includes(p)),
    );
    if (hasEarlierWaiterWanting) return false;

    if (!this.allFree(want)) return false;

    this.takeAll(handle.owner, want);
    // `LockHandle.paths` is a mutable property (its array type is
    // readonly, the field itself is not) — assign directly; the old
    // `as { paths }` cast was gratuitous.
    handle.paths = canonicalize([...handle.paths, ...want]);
    return true;
  }

  /**
   * Release every path the handle holds. Idempotent — calling release
   * on an already-released handle is a no-op (so callers can `release`
   * unconditionally in `finally` blocks).
   */
  release(handle: LockHandle): void {
    if (handle.released) return;
    handle.released = true;
    for (const p of handle.paths) {
      const cur = this.heldBy.get(p);
      if (cur === handle.owner) this.heldBy.delete(p);
      // If cur is some other owner, that's a bug somewhere upstream;
      // we do nothing rather than throw — release should be safe to
      // call from cleanup paths.
    }
    this.drainWaiters();
  }

  /**
   * For tests + diagnostics. Returns a snapshot of held paths.
   */
  snapshot(): { held: Record<string, string>; queueLength: number } {
    const held: Record<string, string> = {};
    for (const [p, o] of this.heldBy) held[p] = o;
    return { held, queueLength: this.waiters.length };
  }

  /**
   * Force-release everything held by `owner` AND drop its queued
   * waiters — a complete reap of a dead owner.
   *
   * NO PRODUCTION CALLER yet (file-locking #7). Wiring this to abnormal
   * lane termination needs lane-cancellation infrastructure that does
   * not exist: `LanePool` is a slot counter with no kill path, and
   * `runChunkLoop` takes no `AbortSignal`. Until that lands, a wedged
   * lane's leak is bounded by the next orchestrator restart — the
   * queue is an in-process Map with no persistence. `reap` is kept as
   * a correct, tested primitive (exercised by the #11 conformance
   * suite) and is ready the day lane cancellation is built.
   */
  reap(owner: string): number {
    let n = 0;
    for (const [p, o] of [...this.heldBy]) {
      if (o === owner) {
        this.heldBy.delete(p);
        n++;
      }
    }
    // Also drop any QUEUED waiters for this owner. Without this, a
    // reaped owner's waiter stays in the queue and `drainWaiters` could
    // later grant it — handing locks to an owner that no longer exists
    // (file-locking #7: a complete reap clears holds AND pending
    // claims). The waiter's promise is rejected so a still-awaiting
    // caller fails fast rather than hanging.
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].owner === owner) {
        const [w] = this.waiters.splice(i, 1);
        w.reject(new Error(`FileLockQueue: waiter for "${owner}" was reaped`));
        n++;
      }
    }
    if (n > 0) this.drainWaiters();
    return n;
  }

  /**
   * Read-only peek: for each requested path that's currently held,
   * return `{ path → ownerId }`. Free paths are absent from the map.
   *
   * Added for the file-claim adapter (file-locking #11) so an
   * adapter-level "acquire failed; here's the contention" path can
   * report exact holders rather than a cross-product approximation.
   * Pure read; safe to call mid-grant.
   */
  peekHolders(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of paths) {
      const o = this.heldBy.get(p);
      if (o !== undefined) out.set(p, o);
    }
    return out;
  }

  /**
   * Reject all pending waiters and refuse new acquires. Held locks are
   * untouched (the caller can still `release` outstanding handles).
   */
  destroy(): void {
    this.destroyed = true;
    const err = new Error('FileLockQueue destroyed');
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w.reject(err);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private allFree(paths: readonly string[]): boolean {
    for (const p of paths) if (this.heldBy.has(p)) return false;
    return true;
  }

  private takeAll(owner: string, paths: readonly string[]): void {
    for (const p of paths) this.heldBy.set(p, owner);
  }

  /**
   * Walk the FIFO and grant any waiter whose full path-set is free.
   * Strictly-FIFO would only grant waiter[0] when its set frees, but
   * that's pessimistic — if waiter[0] needs `a, b` and `a` is held,
   * waiter[1] who needs `c, d` (entirely free) shouldn't have to wait.
   *
   * The fairness compromise: we never *skip past* waiter[0] for a
   * waiter that conflicts with what waiter[0] wants. So waiter[0]
   * gets first dibs on every path it touches, but unrelated waiters
   * can proceed.
   */
  private drainWaiters(): void {
    if (this.waiters.length === 0) return;
    // Reserved set = paths the head waiter wants but can't yet take.
    // Any later waiter touching one of these must wait for the head.
    const head = this.waiters[0];
    const headBlocked = !this.allFree(head.paths);
    const reserved = new Set<string>(headBlocked ? head.paths : []);

    const next: Waiter[] = [];
    for (const w of this.waiters) {
      const conflictsWithReserved = w.paths.some((p) => reserved.has(p));
      const allMine = this.allFree(w.paths);
      if (allMine && !conflictsWithReserved) {
        this.takeAll(w.owner, w.paths);
        w.resolve(makeHandle(w.owner, w.paths));
      } else {
        next.push(w);
      }
    }
    this.waiters = next;
  }
}

function canonicalize(paths: readonly string[]): readonly string[] {
  const trimmed = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  const dedup = Array.from(new Set(trimmed));
  dedup.sort();
  return dedup;
}

function makeHandle(owner: string, paths: readonly string[]): LockHandle {
  return { owner, paths, released: false };
}
