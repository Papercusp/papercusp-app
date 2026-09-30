/**
 * pending-epoch-content — the KEY-BEFORE-CONTENT ordering invariant for the
 * read-plane re-key (Brief RE-KEY / C-001 / Move 2; P-005, 46b7a's federation
 * half, co-built with K / su-313d1).
 *
 * ## The invariant
 * Content ops are encrypted under the hive's current epoch key (app-layer AEAD on
 * the op payload — findings-REKEY §P4). A peer can only decrypt an epoch-N content
 * op once it holds epoch-N's wrapped key (a `hive_epoch_keys` row for
 * `(hive, epoch, ownDevice)`). The two federate as SEPARATE ops on SEPARATE
 * surfaces (the key row vs the content row), so there is NO transport guarantee
 * the key arrives first — even when `fed_hlc` orders the key BEFORE the content
 * (HLC is a per-table LWW order; it does not globally serialize cross-table
 * APPLY). A content op can therefore reach `applyOpVia` before its key.
 *
 * ## Why `fed_hlc` alone is insufficient (the D-001 tie-in, stated precisely)
 * `fed_hlc` (migration 314) made the producer write the key row with an HLC ≤ the
 * first epoch-N content op, and makes each LWW table converge. But the consumer
 * applies ops as they ARRIVE (the merge advances its cursor by log position, not
 * by a global HLC sort across tables). So the ordering must ALSO be enforced at
 * the apply seam — fail-closed: a content op whose epoch key is not yet local is
 * DEFERRED here (never applied as garbage, never lost) and re-applied once the key
 * row lands. This buffer is that deferral.
 *
 * ## Fail-closed handles BOTH cases for free
 *   - a REMAINING member: the key row federates → `drainEpoch(hive, epoch)` returns
 *     the deferred ops → they re-apply + decrypt → converge.
 *   - a REMOVED member: the key row is NEVER written to it → its deferred epoch-N+
 *     content stays undecryptable forever = the C-001 read cut-off. (Bounded below
 *     so an excluded peer's pending set can't grow without limit — the ciphertext
 *     stays in the log, so a dropped deferral is re-encountered on any re-fold.)
 *
 * Pure (no DB, no I/O, no crypto) — the apply-wiring (P-005, gated on the (a′)
 * hive-home federation seam) calls `defer` when `EpochKeyProvider.keyForEpoch`
 * rejects, and `drainEpoch` when a `hive_epoch_keys` row applies. Mirrors the
 * shape of boot.ts's admission pending-retry, kept separate (different dependency:
 * a key row, not an admission).
 */
import type { OpEnvelope } from './op-envelope-types';
import { currentDeferralSource, DroppedDeferrals, type DeferralSource } from './deferral-source';

/** One deferred content op + the (hive, epoch) key it is waiting on. */
export interface DeferredContentOp {
  /** The applied-against projection set is the caller's; we hold only the op. */
  op: OpEnvelope;
  potId: string;
  epoch: number;
  /** Insertion order — for deterministic FIFO drain + oldest-first eviction. */
  seq: number;
  /** D-016: the log position the fold read this op at. Absent outside a fold apply. */
  source?: DeferralSource;
}

/** Default cap on the TOTAL deferred ops held across all (hive, epoch) buckets.
 *  Bounds memory for a removed/excluded peer that keeps receiving epoch-N+ content
 *  it can never decrypt (the ciphertext is still in the log, so dropping the oldest
 *  deferral loses nothing — a re-fold re-defers it). */
export const DEFAULT_MAX_PENDING = 10_000;

/** `${potId}\x00${epoch}` — the bucket key (NUL can't appear in a slug). */
function bucketKey(potId: string, epoch: number): string {
  return `${potId}\x00${epoch}`;
}

/**
 * A bounded, FIFO-per-bucket buffer of content ops deferred because their epoch
 * key is not yet local. NOT thread-shared — one per booted harness apply loop
 * (single-threaded JS, same as the merge cursor).
 */
export class PendingEpochContent {
  /** bucket → deferred ops keyed by {@link opIdentity}, in insertion order. P-523: a Map
   *  makes dedupe and oldest-eviction O(1); the array this replaced cost a scan of the
   *  whole bucket per defer, which set the pace of a fresh join (D-009). */
  private readonly buckets = new Map<string, Map<string, DeferredContentOp>>();
  /** Monotone insertion counter (deterministic ordering; never wall-clock). */
  private seqCounter = 0;
  /** Total deferred ops across all buckets (kept in sync for O(1) bound checks). */
  private total = 0;
  /** WI-3852 + D-016: every deferral `evictOldest` drops, recorded under its (hive, epoch)
   *  bucket key. An evicted op's ciphertext stays in the peer log, but nothing re-reads it
   *  unless the fold moves back to it. That is worth doing only once the epoch key is local
   *  (before that it would only defer again), so boot.ts releases the record when this
   *  device resolves the key ({@link releaseEpoch}) and rewinds to the owed positions. */
  readonly dropped = new DroppedDeferrals();

  constructor(private readonly maxPending: number = DEFAULT_MAX_PENDING) {}

  /**
   * Defer a content op whose epoch key is not yet available. Idempotent per op
   * IDENTITY within a bucket: re-deferring the SAME op (same table+hbKey+hlc — a
   * re-fold re-encountering it) does not duplicate it, so a cursor reset can't
   * inflate the buffer. Returns true if stored (false if it was already pending).
   * Enforces `maxPending` by evicting the GLOBALLY-oldest deferral first.
   */
  defer(op: OpEnvelope, potId: string, epoch: number): boolean {
    const k = bucketKey(potId, epoch);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(k, bucket);
    }
    const id = opIdentity(op);
    if (bucket.has(id)) return false; // already pending (re-fold)
    const source = currentDeferralSource();
    bucket.set(id, { op, potId, epoch, seq: this.seqCounter++, ...(source ? { source } : {}) });
    this.total++;
    if (this.total > this.maxPending) this.evictOldest();
    return true;
  }

  /**
   * The epoch-N key for `potId` just became available (a `hive_epoch_keys` row
   * for it applied). Remove + return that bucket's deferred ops in FIFO order so
   * the caller can re-apply them (now decryptable). Returns [] if none pending.
   */
  drainEpoch(potId: string, epoch: number): DeferredContentOp[] {
    const k = bucketKey(potId, epoch);
    const bucket = this.buckets.get(k);
    if (!bucket || bucket.size === 0) return [];
    this.buckets.delete(k);
    this.total -= bucket.size;
    // FIFO: insertion order (a Map iterates in insertion order); explicit sort for safety
    // against any future out-of-order insert path.
    return [...bucket.values()].sort((a, b) => a.seq - b.seq);
  }

  /** D-016: whether evicted deferrals are recorded against (potId, epoch). */
  hasEvicted(potId: string, epoch: number): boolean {
    return this.dropped.has(bucketKey(potId, epoch));
  }

  /** D-016: this device now holds the epoch-N key for `potId`, so the ops evicted while it
   *  was missing would decrypt if read again. Their positions become owed to the fold. */
  releaseEpoch(potId: string, epoch: number): void {
    this.dropped.release(bucketKey(potId, epoch));
  }

  /** Total deferred ops (observability / tests). */
  size(): number {
    return this.total;
  }

  /** Distinct (hive, epoch) buckets currently holding deferrals. */
  bucketCount(): number {
    return this.buckets.size;
  }

  /** Read and clear whether `evictOldest` has dropped anything since the last call
   *  (observability; it shares {@link dropped}'s counts, so boot.ts reads those instead). */
  consumeEvictionSignal(): boolean {
    const { evicted, expired } = this.dropped.takeDropCounts();
    return evicted + expired > 0;
  }

  /** Drop the globally-oldest deferral to honour `maxPending`. The op's ciphertext
   *  remains in the peer log, so a later re-fold re-defers it — dropping is safe
   *  back-pressure, not data loss (as long as that later re-fold actually happens —
   *  see `dropped`). */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestSeq = Infinity;
    // Scans buckets, not ops: one bucket per (hive, epoch), so this loop is short.
    for (const [k, bucket] of this.buckets) {
      const head = bucket.values().next().value; // each bucket is seq-ascending (insertion order)
      if (head && head.seq < oldestSeq) {
        oldestSeq = head.seq;
        oldestKey = k;
      }
    }
    if (oldestKey === null) return;
    const bucket = this.buckets.get(oldestKey)!;
    const [id, head] = bucket.entries().next().value!;
    bucket.delete(id);
    this.total--;
    if (bucket.size === 0) this.buckets.delete(oldestKey);
    this.dropped.note(oldestKey, head.source, 'evicted');
  }
}

/** Two ops are the SAME deferral iff they project the same row version: same
 *  table + hbKey + ordering key (hlc when present, else ts). This is the LWW
 *  identity — a strictly-newer op for the same key is a DIFFERENT deferral (it
 *  should supersede, and the apply path's LWW guard handles that on re-apply).
 *  JSON keeps the tuple unambiguous whatever characters a key holds. */
export function opIdentity(op: Pick<OpEnvelope, 'table' | 'hbKey' | 'hlc' | 'ts' | 'type'>): string {
  return JSON.stringify([op.table, op.hbKey, op.hlc ?? '', op.ts ?? 0, op.type]);
}
