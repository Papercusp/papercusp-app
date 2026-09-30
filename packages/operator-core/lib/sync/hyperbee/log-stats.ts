/**
 * log-stats — per-peer substrate log-growth + new-joiner replay-cost metrics.
 *
 * Plan: substrate-peer-log-compaction-2026-06-13 P-001/P-002 (Phase 1 —
 * non-design-gated, single-box). Spun out of shared-hive-hardening P-009.
 *
 * The compaction gap (P-009): the Model-B per-peer op-log (`peer-log.ts`) is an
 * append-only Hypercore with NO compaction, and the read-merge cursor is not
 * persisted — so the per-peer log grows unbounded and a NEW joiner (or any
 * restart) re-folds the FULL history from index 0. Before you can decide WHEN to
 * compact (and measure whether a future compaction helped), you need the SIGNAL:
 * how big are the logs, and what does a fresh joiner have to fold. This module is
 * that signal — pure, read-only, no PG/FS/fetch, single-box-testable.
 *
 *   - `replayCostOps` — the sum of every admitted log's length: exactly the op
 *     count a fresh joiner folds on first sync (read-merge reads each admitted
 *     log from index 0). This is the number a compaction must shrink.
 *   - `ownLogOps` — this peer's own-log growth (the ops IT published; what its
 *     own compaction would collapse).
 *   - `largestLogOps` — the biggest single contributor (the per-author tail the
 *     merge's `maxOpsPerPass` budget chunks through).
 */

import { listBootedHandles, getBootedHarness } from './boot-all';

/** One log's contribution. */
export interface PeerLogStat {
  /** 64-char hex hypercore key of the log. */
  keyHex: string;
  /** True for this peer's OWN writable log. */
  isOwn: boolean;
  /** Op-count (Hypercore length). */
  ops: number;
}

/** Per-harness substrate log-growth + replay-cost snapshot. */
export interface HarnessLogStats {
  workspaceId: string;
  harnessSlug: string;
  /** This peer's own-log op-count (its published ops; what its compaction collapses). */
  ownLogOps: number;
  /** Number of logs in the admitted set (this peer + every admitted remote peer). */
  admittedLogCount: number;
  /**
   * Total ops a fresh joiner folds on first sync = sum of every admitted log's
   * length. The headline number a compaction/snapshot must shrink (P-009).
   */
  replayCostOps: number;
  /** Largest single admitted log (the dominant per-author tail). */
  largestLogOps: number;
  /** Per-log breakdown, largest-first. */
  perLog: PeerLogStat[];
}

/**
 * The minimal structural view of a booted handle this module reads — just the
 * own-log identity/length and the admitted-set lengths. `BootedHarnessHandle`
 * satisfies it; tests pass a fake with the same shape.
 */
export interface LogStatsHandleLike {
  workspaceId: string;
  harnessSlug: string;
  ownLog: { readonly keyHex: string; readonly length: number };
  admitted: ReadonlyMap<string, { readonly keyHex: string; readonly length: number }>;
}

/**
 * Compute the log-growth + replay-cost snapshot for one booted harness. Pure.
 * `replayCostOps` sums the admitted set (which is seeded with the own log, so it
 * includes own ops — a joiner folds those too); `ownLogOps` is read from the own
 * log directly so it is correct even if the own log were ever absent from the
 * admitted map.
 */
export function computeHarnessLogStats(handle: LogStatsHandleLike): HarnessLogStats {
  const ownKey = handle.ownLog.keyHex;
  const perLog: PeerLogStat[] = [];
  let replayCostOps = 0;
  let largestLogOps = 0;
  for (const [keyHex, log] of handle.admitted) {
    const ops = log.length;
    perLog.push({ keyHex, isOwn: keyHex === ownKey, ops });
    replayCostOps += ops;
    if (ops > largestLogOps) largestLogOps = ops;
  }
  perLog.sort((a, b) => b.ops - a.ops);
  return {
    workspaceId: handle.workspaceId,
    harnessSlug: handle.harnessSlug,
    ownLogOps: handle.ownLog.length,
    admittedLogCount: handle.admitted.size,
    replayCostOps,
    largestLogOps,
    perLog,
  };
}

/**
 * Collect log-stats for every currently-booted harness. Read-only over the boot
 * registry; safe to call any time (returns `[]` when nothing is booted).
 */
export function collectSubstrateLogStats(): HarnessLogStats[] {
  const out: HarnessLogStats[] = [];
  for (const { workspaceId, harnessSlug } of listBootedHandles()) {
    const handle = getBootedHarness(workspaceId, harnessSlug);
    if (handle) out.push(computeHarnessLogStats(handle));
  }
  return out;
}
