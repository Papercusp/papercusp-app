/**
 * eviction-refold — when and how far the merge loop re-folds after a content-deferral
 * buffer evicts (p2p-join-catchup-speed P-522, WI-10002899).
 *
 * ## The problem
 * `PendingEpochContent` and `PendingMembershipContent` hold content ops that cannot apply
 * yet: the epoch key or the author's membership has not federated. Both are bounded, and
 * an evicted op is only safe to drop if the fold reads it again later. WI-3852 made every
 * eviction trip a full cursor reset on the very next pass. That livelocks a joiner. The
 * missing key sits far ahead in the log, every pass defers more than the buffer holds, and
 * the reset sends the fold back to its seed before it can reach the key. P-007 run #1 reset
 * log 5b00878b to 0 about every 2 min, 11 times in a row, while the device's epoch-key rows
 * sat near the tail.
 *
 * ## D-016: owed only when the blocker clears, rewound to the drop's own position
 * P-007 run #5 crossed its 1,053-chunk set, drained the tail to 5,180 ops, then re-folded
 * from the set start: some drop had owed a re-fold, and the coarse floor below was still the
 * seed. So each buffer now records a drop under its blocker with the op's log position
 * (`deferral-source.ts`), and the drop owes a re-fold only when that blocker clears
 * ({@link DeferralEvictionReFold.noteOwed}). The re-fold then moves only the logs a drop came
 * from, back to the drop's own position. The coarse floors below remain the fallback for a
 * drop with no recorded position ({@link DeferralEvictionReFold.noteEviction}).
 *
 * ## The policy
 *  - An eviction OWES a re-fold. It is paid only once the fold has SETTLED: after a pass
 *    in which no admitted log could advance any further (each is at its length, or the
 *    pass could not move it). The fold therefore always reaches the tail, where a missing
 *    key or member row lives, before it re-reads anything.
 *  - The re-fold REWINDS each log to its deferral floor instead of resetting the cursor.
 *    The floor is the log's position the last time both buffers were empty at a pass
 *    start. Every op a buffer holds or has evicted was deferred after that moment, at or
 *    above that position, so re-reading from the floor reaches all of them. The PG seed,
 *    the snapshot seed marks and the scan memo survive (see `rewindMergeCursor`).
 *  - Floors are frozen while a re-fold is owed. A log positioned since the last refresh
 *    gets its first position as its floor: nothing it defers can come from below it.
 *  - The floors describe ONE cursor. A replaced cursor (log removal, truncation, rekey)
 *    re-reads every log from its seed, which pays any owed re-fold, and its floors start
 *    over. Deferrals still buffered across that replacement came from positions no floor
 *    records, so until the buffers next drain an eviction falls back to the full reset.
 *
 * Pure bookkeeping over a `MergeCursor`: no I/O. boot.ts drives it once per merge pass.
 */
import { rewindMergeCursor, type AdmittedLog, type MergeCursor } from './read-merge';
import type { OwedDeferralReFold } from './deferral-source';

/** What `settle` decided for this pass. */
export type EvictionReFoldAction =
  /** Nothing owed, or the fold has not settled yet. */
  | { kind: 'none' }
  /** Paid in place: these logs moved back to their floors. */
  | { kind: 'rewound'; moved: Array<{ keyHex: string; floor: number }> }
  /** No trustworthy floor: the caller must replace the cursor and drop its PG seed. */
  | { kind: 'reset' };

export class DeferralEvictionReFold {
  private owed = false;
  /** An owed drop has no recorded position, so only the coarse floors reach it. */
  private coarse = false;
  /** D-016: keyHex → the lowest log position among owed drops that recorded one. */
  private owedFloors = new Map<string, number>();
  private settled = false;
  /** P-538: every admitted log is at its length (no stall exemption). */
  private caughtUp = false;
  private floors = new Map<string, number>();
  private exact = true;
  private floorsCursor: MergeCursor | null = null;

  /** A drop with no recorded position owes a re-fold to the coarse floors. */
  noteEviction(): void {
    this.owed = true;
    this.coarse = true;
  }

  /**
   * D-016: drops whose blocker has cleared owe a re-read from their own positions. A
   * released drop without a position falls back to the coarse floors.
   */
  noteOwed(owed: OwedDeferralReFold): void {
    if (owed.sourceless) this.noteEviction();
    for (const [keyHex, position] of owed.floors) {
      const prev = this.owedFloors.get(keyHex);
      if (prev === undefined || position < prev) this.owedFloors.set(keyHex, position);
      this.owed = true;
    }
  }

  /** Whether a re-fold is owed and not yet paid. */
  get isOwed(): boolean {
    return this.owed;
  }

  /** Whether the last pass left the fold settled: every log at its length or stuck. */
  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * P-538: whether the last pass left every admitted log at its length. Unlike
   * {@link isSettled}, a log that is behind but could not move (a read stall while blocks
   * download, a fresh log held for its seed scan) is NOT caught up. boot.ts holds the member
   * TTL on this: P-007 run #10 read settled before a 943 s snapshot-set pass, the TTL ran
   * through the whole set, and 12 deferrals expired minutes before their member arrived.
   */
  get isCaughtUp(): boolean {
    return this.caughtUp;
  }

  /**
   * Top of a pass, after any cursor replacement and before seeding: pay an owed re-fold
   * if the previous pass left the fold settled. A `rewound` result has already moved the
   * cursor. A `reset` result asks the caller to replace it.
   */
  settle(cursor: MergeCursor): EvictionReFoldAction {
    if (this.floorsCursor !== cursor) {
      // Replaced since the floors were taken: its re-read from the seeds pays the debt.
      this.clearOwed();
      return { kind: 'none' };
    }
    if (!this.owed || !this.settled) return { kind: 'none' };
    const coarse = this.coarse;
    const precise = this.owedFloors;
    this.clearOwed();
    if (coarse && !this.exact) return { kind: 'reset' };
    // A precise re-fold moves only the logs a drop came from; every other log keeps its
    // position (rewindMergeCursor sends a log with no floor to 0).
    const floors = coarse ? new Map(this.floors) : new Map(cursor.positions);
    for (const [keyHex, position] of precise) {
      const prev = floors.get(keyHex);
      if (prev === undefined ? !coarse : position < prev) floors.set(keyHex, position);
    }
    const moved = rewindMergeCursor(cursor, floors).map((keyHex) => ({
      keyHex,
      floor: floors.get(keyHex) ?? 0,
    }));
    // P-541: a moved log is behind again, whatever the last pass ended at.
    if (moved.length > 0) this.caughtUp = false;
    return { kind: 'rewound', moved };
  }

  /**
   * P-541: after `settle` (and any cursor replacement), before seeding. A log that has ops
   * but no position was admitted since the last pass, belongs to a replaced cursor, or was
   * rewound to 0, so this pass starts it from its seed: the fold is catching up. The last
   * pass's {@link isCaughtUp} never saw it, and P-007 run #15 folded a 1,206 s snapshot set
   * on a log admitted that way with the member TTL live, which dropped 12 deferrals mid-set.
   */
  noteUnpositioned(logs: readonly AdmittedLog[], cursor: MergeCursor): void {
    if (logs.some((log) => log.length > 0 && !cursor.positions.has(log.keyHex))) this.caughtUp = false;
  }

  private clearOwed(): void {
    this.owed = false;
    this.coarse = false;
    this.owedFloors = new Map();
  }

  /**
   * After seeding, before the fold: refresh the floors to where this pass's fold starts.
   * `buffersHold` is whether either deferral buffer holds anything right now.
   */
  markFloors(cursor: MergeCursor, buffersHold: boolean): void {
    if (this.floorsCursor !== cursor) {
      this.floorsCursor = cursor;
      this.floors = new Map();
      this.exact = !buffersHold;
    }
    if (!this.owed && !buffersHold) {
      this.floors = new Map(cursor.positions);
      this.exact = true;
      return;
    }
    for (const [keyHex, position] of cursor.positions) {
      if (!this.floors.has(keyHex)) this.floors.set(keyHex, position);
    }
  }

  /**
   * After the fold: settled means no admitted log can advance any further right now.
   * Each one is at its length, or this pass could not move it (a read stall or an
   * apply-failure hold, which a re-fold would only repeat). A log with no position that
   * has ops (one held for its seed scan) has not started, so it is not settled.
   */
  noteFold(logs: readonly AdmittedLog[], cursor: MergeCursor, positionsBefore: ReadonlyMap<string, number>): void {
    this.settled = logs.every((log) => {
      const position = cursor.positions.get(log.keyHex);
      if (position === undefined) return log.length === 0;
      return position >= log.length || position === positionsBefore.get(log.keyHex);
    });
    this.caughtUp = logs.every((log) => {
      const position = cursor.positions.get(log.keyHex);
      return position === undefined ? log.length === 0 : position >= log.length;
    });
  }

  /** A pass that found nothing to fold: every log is at its length. */
  noteIdle(): void {
    this.settled = true;
    this.caughtUp = true;
  }

  /** The floor recorded for `keyHex` (tests and logging). */
  floorOf(keyHex: string): number | undefined {
    return this.floors.get(keyHex);
  }
}
