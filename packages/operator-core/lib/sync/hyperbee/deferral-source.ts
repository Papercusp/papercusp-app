/**
 * deferral-source — where a deferred content op sits in its log, and what the content-deferral
 * buffers dropped (p2p-join-catchup-speed D-016, P-522).
 *
 * ## Why
 * `PendingEpochContent` and `PendingMembershipContent` drop entries: the oldest on their cap,
 * and (membership) any entry past its TTL. A dropped op's bytes stay in the log, so the fold
 * reads it again only if the cursor moves back to it. Before D-016 every drop owed a re-fold to
 * a coarse floor (the log position when both buffers were last empty). On a fresh join that
 * floor is the snapshot set's start, so P-007 run #5 re-applied all 1,053 chunks after its tail
 * had drained. It also owed that re-fold for an op whose blocker never clears, such as content
 * from a device that is never admitted, which would only defer it again.
 *
 * ## The contract
 *  - The merge fold runs each apply inside {@link runWithDeferralSource}, so a buffer can stamp
 *    the op's log key and position at defer time ({@link currentDeferralSource}). A drained
 *    re-apply runs under the entry's own source, so a re-defer keeps it.
 *  - A buffer records each drop under the entry's BLOCKER (the (pot, epoch) key, the author
 *    device, the unresolved source log) in {@link DroppedDeferrals}: the lowest source position
 *    per log, and whether any dropped entry had no source.
 *  - The record becomes OWED only when that blocker clears ({@link DroppedDeferrals.release}).
 *    boot.ts then rewinds each log to the owed position (see `eviction-refold.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { pinModuleState } from '@papercusp/module-singleton';

/** The log position the fold was applying when an op deferred. */
export interface DeferralSource {
  keyHex: string;
  position: number;
}

// Pinned: read-merge enters the store and both deferral buffers read it, so a split module
// record would stamp every deferral as source-less and send each re-fold to the coarse floor.
const deferralSourceStore = pinModuleState(
  '@papercusp/operator-core.sync.deferral-source-store',
  () => new AsyncLocalStorage<DeferralSource>(),
);

/** Run `fn` with `source` as the ambient deferral source. `undefined` runs it with none, so a
 *  source-less re-apply never inherits the source of the apply that drained it. */
export function runWithDeferralSource<T>(source: DeferralSource | undefined, fn: () => T): T {
  return source ? deferralSourceStore.run(source, fn) : deferralSourceStore.exit(fn);
}

/** The source of the apply this call runs inside, if any. */
export function currentDeferralSource(): DeferralSource | undefined {
  return deferralSourceStore.getStore();
}

/** What a set of released drops owes the fold. */
export interface OwedDeferralReFold {
  /** keyHex → the lowest source position among the released drops on that log. */
  floors: Map<string, number>;
  /** A released drop had no source: only the coarse floors are sure to reach it. */
  sourceless: boolean;
  /** Released drops (observability). */
  drops: number;
}

interface BlockerRecord {
  floors: Map<string, number>;
  sourceless: boolean;
  drops: number;
}

/** Drop counts since the last {@link DroppedDeferrals.takeDropCounts} (observability). */
export interface DeferralDropCounts {
  evicted: number;
  expired: number;
}

/**
 * Per-blocker record of dropped deferrals. Memory is one small map per distinct blocker, not
 * per op: only the lowest position per log is kept.
 */
export class DroppedDeferrals {
  private readonly byBlocker = new Map<string, BlockerRecord>();
  private owed: OwedDeferralReFold | null = null;
  private counts: DeferralDropCounts = { evicted: 0, expired: 0 };

  /** An entry waiting on `blocker` was dropped. */
  note(blocker: string, source: DeferralSource | undefined, why: 'evicted' | 'expired'): void {
    let rec = this.byBlocker.get(blocker);
    if (!rec) {
      rec = { floors: new Map(), sourceless: false, drops: 0 };
      this.byBlocker.set(blocker, rec);
    }
    rec.drops++;
    this.counts[why]++;
    if (!source) {
      rec.sourceless = true;
      return;
    }
    const prev = rec.floors.get(source.keyHex);
    if (prev === undefined || source.position < prev) rec.floors.set(source.keyHex, source.position);
  }

  /** Whether any drop is recorded against `blocker`. */
  has(blocker: string): boolean {
    return this.byBlocker.has(blocker);
  }

  /** `blocker` cleared: its drops are now worth re-reading, so they become owed. */
  release(blocker: string): void {
    const rec = this.byBlocker.get(blocker);
    if (!rec) return;
    this.byBlocker.delete(blocker);
    const owed = (this.owed ??= { floors: new Map(), sourceless: false, drops: 0 });
    owed.drops += rec.drops;
    owed.sourceless ||= rec.sourceless;
    for (const [keyHex, position] of rec.floors) {
      const prev = owed.floors.get(keyHex);
      if (prev === undefined || position < prev) owed.floors.set(keyHex, position);
    }
  }

  /** Read and clear what released drops owe. `null` when nothing was released. */
  takeOwed(): OwedDeferralReFold | null {
    const owed = this.owed;
    this.owed = null;
    return owed;
  }

  /** Whether an unreleased drop has no source, so the coarse floors must keep covering it. */
  get holdsSourceless(): boolean {
    for (const rec of this.byBlocker.values()) if (rec.sourceless) return true;
    return false;
  }

  /** Distinct blockers with unreleased drops (observability). */
  get blockerCount(): number {
    return this.byBlocker.size;
  }

  /** Read and clear the drop counts since the last call. */
  takeDropCounts(): DeferralDropCounts {
    const counts = this.counts;
    this.counts = { evicted: 0, expired: 0 };
    return counts;
  }
}
