/**
 * WI-10002836 — the own-log compaction's CADENCE ANCHOR: where the latest snapshot set on
 * this peer's own log sits, how big it is, and whether the next (unfiltered) compaction
 * may seed from it.
 *
 * Its own module because it needs both halves of the snapshot code: the scan lives in
 * `read-merge.ts`, which imports `log-snapshot.ts`, so `log-snapshot.ts` cannot hold it
 * without an import cycle. `boot.ts` owns the mutable cadence state; this returns a value.
 *
 * ── THE DISTINCTION THIS EXISTS TO KEEP ──
 * MEASURED 2026-09-24 on the tower: boot logged `lastCoversUpTo=0` at 00:45Z and 01:52Z on
 * a log whose newest set sat ~48k blocks below the tail. A bounded read timed out under
 * load, `findLatestCompleteSnapshot` collapsed that `unreadable` outcome into `null`, and
 * boot treated `null` as "never snapshotted", which armed a fold of all 7.76M ops from 0.
 * That fold drove bg-host to 25 GB and an OOM recycle. So `unreadable` must stay
 * `known: false` here, and the caller must not compact until a retry resolves it.
 */
import type { OwnLog } from './peer-log';
import { describeSnapshotSet, isSeedableForUnfilteredFold } from './log-snapshot';
import { findLatestCompleteSnapshotDetailed, type AdmittedLog, type SnapshotScanOutcome } from './read-merge';

export type OwnCompactionAnchor =
  | {
      /** The scan could not read the tail. Says nothing about whether a set exists. */
      known: false;
      /** One token for the boot row, e.g. `unreadable(atIndex=7711093,cause=timeout)`. */
      outcome: string;
    }
  | {
      known: true;
      outcome: string;
      /** Index the cadence counts growth from (chunk 0 of the latest set; 0 if none). */
      lastCoversUpTo: number;
      /** Estimated rows in that set (0 if none or undescribable) — feeds the proportional cadence. */
      lastRows: number;
      /** The set the next UNFILTERED compaction may seed from, or null. */
      seedSet: { coversUpTo: number; chunkCount: number } | null;
    };

export async function discoverOwnCompactionAnchor(
  log: AdmittedLog & Pick<OwnLog, 'get'>,
  opts: { maxLookback?: number; getTimeoutMs?: number; describeBudgetMs?: number } = {},
): Promise<OwnCompactionAnchor> {
  const scan = await findLatestCompleteSnapshotDetailed(log, opts.maxLookback, opts.getTimeoutMs).catch(
    (): SnapshotScanOutcome => ({ kind: 'unreadable', atIndex: -1, cause: 'read-error' }),
  );
  if (scan.kind === 'unreadable') {
    return { known: false, outcome: `unreadable(atIndex=${scan.atIndex},cause=${scan.cause})` };
  }
  if (scan.kind === 'none-in-window') {
    return { known: true, outcome: 'none', lastCoversUpTo: 0, lastRows: 0, seedSet: null };
  }
  const { seed } = scan;
  const size = await describeSnapshotSet(log, seed, opts.describeBudgetMs);
  // A release-cut head snapshot excludes only `presence`, which regenerates, so it is a
  // valid seed for the unfiltered compaction too. When the set cannot be described, hint
  // it anyway: the producer re-checks exclusions itself (`conflictingSnapshotExclusion`)
  // and folds from 0 if the set really is unusable, so the hint can only save work.
  const seedable = !size || isSeedableForUnfilteredFold(size.excludeTables);
  return {
    known: true,
    outcome: `found(excludes=${size ? size.excludeTables.join('+') || 'none' : 'unknown'})`,
    lastCoversUpTo: seed.seedIndex,
    lastRows: size?.rowEstimate ?? 0,
    seedSet: seedable ? { coversUpTo: seed.coversUpTo, chunkCount: seed.chunkCount } : null,
  };
}
