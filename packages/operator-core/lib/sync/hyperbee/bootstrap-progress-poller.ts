/**
 * bootstrap-progress-poller — Phase 5b P-066 wiring.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * The Model B substrate doesn't emit a typed merge-complete event we
 * can subscribe to. As a pragmatic bridge, this helper polls a length
 * getter on a setInterval and records the count via `recordMergedOps`.
 * Stage 4 repointed it from the (retired) Autobase `base.base.view.length`
 * to the per-peer own-log length (`readLength`). Once the substrate grows
 * a typed event source we can swap this for an event listener with
 * the same external behavior.
 *
 * Returns a `stop()` cleanup hook. Idempotent; the BootedHarnessHandle
 * close() should call stop() to prevent leaks across reboots.
 */

import { recordMergedOps } from './bootstrap-progress';

export interface PollerOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Length getter for the substrate's local op count (Model B own-log
   * length). Called every tick; throwing or returning a non-finite value
   * skips the tick. Stage 4: `() => ownLog.length`.
   */
  readLength: () => number;
  /** Poll interval in ms. Default 1000. Test seam. */
  intervalMs?: number;
  /** Setter for tests; defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  /** Clearer for tests; defaults to clearInterval. */
  clearIntervalImpl?: typeof clearInterval;
}

export interface PollerHandle {
  /** Synchronous teardown. Idempotent. */
  stop(): void;
  /** Force one tick now (test seam). */
  pollOnce(): void;
}

function readLengthSafely(readLength: () => number): number | null {
  try {
    const v = readLength();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  } catch {
    return null;
  }
}

export function startBootstrapProgressPoller(
  opts: PollerOpts,
): PollerHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  const setI = opts.setIntervalImpl ?? setInterval;
  const clearI = opts.clearIntervalImpl ?? clearInterval;

  function tick(): void {
    const len = readLengthSafely(opts.readLength);
    if (len !== null) {
      recordMergedOps(opts.workspaceId, opts.harnessSlug, len);
    }
  }

  // record initial state right away
  tick();
  const timer = setI(tick, intervalMs);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        clearI(timer as never);
      } catch {
        // ignore
      }
    },
    pollOnce(): void {
      tick();
    },
  };
}
