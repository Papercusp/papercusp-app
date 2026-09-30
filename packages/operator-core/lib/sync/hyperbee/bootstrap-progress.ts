/**
 * bootstrap-progress — Phase 5b P-066 data source.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * Tracks per-(workspaceId, harnessSlug) substrate-merge progress so
 * the BootstrapProgressIndicator can show "Syncing N/M" until merge
 * activity goes quiet for an idle threshold (default 30s), at which
 * point the harness counts as caught up.
 *
 * Pure logic + a module-level Map. No PG, no FS. The substrate boot
 * code is expected to call `recordMergedOps` whenever a new op is
 * applied to a harness view; the indicator's polling endpoint reads
 * via `getBootstrapProgress`.
 *
 * Because the substrate hasn't wired its merge events into this yet,
 * the helper exposes `_resetForTests` + `_now` injection so the
 * tracker is fully testable on its own.
 */

export interface BootstrapProgressSnapshot {
  workspaceId: string;
  harnessSlug: string;
  /** Most-recently-recorded view length for this harness. */
  mergedOps: number;
  /** Highest value ever recorded for this harness (for back-fill races). */
  highestSeen: number;
  /** Epoch ms of the last recordMergedOps call. */
  lastChangeMs: number;
  /** True when no progress for `idleMs`. */
  caughtUp: boolean;
}

interface Entry {
  workspaceId: string;
  harnessSlug: string;
  mergedOps: number;
  highestSeen: number;
  lastChangeMs: number;
}

const tracker: Map<string, Entry> = new Map();

const DEFAULT_IDLE_MS = 30_000;

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

let _nowImpl: () => number = () => Date.now();

/** Test seam — override Date.now() inside tests for determinism. */
export function _setNowForTests(impl: () => number): void {
  _nowImpl = impl;
}

export function _resetTrackerForTests(): void {
  tracker.clear();
  _nowImpl = () => Date.now();
}

/**
 * Record a fresh mergedOps count for a (workspace, harness). Idempotent:
 * passing the same count keeps the tracker stable but does NOT bump
 * lastChangeMs (so caught-up detection still fires).
 */
export function recordMergedOps(
  workspaceId: string,
  harnessSlug: string,
  mergedOps: number,
): void {
  const k = key(workspaceId, harnessSlug);
  const now = _nowImpl();
  const prev = tracker.get(k);
  if (!prev) {
    tracker.set(k, {
      workspaceId,
      harnessSlug,
      mergedOps,
      highestSeen: mergedOps,
      lastChangeMs: now,
    });
    return;
  }
  // Only bump lastChangeMs when the count actually grows.
  const grew = mergedOps > prev.mergedOps;
  tracker.set(k, {
    workspaceId,
    harnessSlug,
    mergedOps,
    highestSeen: Math.max(prev.highestSeen, mergedOps),
    lastChangeMs: grew ? now : prev.lastChangeMs,
  });
}

/**
 * Returns null when the harness has no recorded progress (substrate
 * never booted, or boot just started before any ops merged).
 */
export function getBootstrapProgress(
  workspaceId: string,
  harnessSlug: string,
  opts: { idleMs?: number } = {},
): BootstrapProgressSnapshot | null {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const entry = tracker.get(key(workspaceId, harnessSlug));
  if (!entry) return null;
  const now = _nowImpl();
  const caughtUp = now - entry.lastChangeMs >= idleMs;
  return {
    workspaceId: entry.workspaceId,
    harnessSlug: entry.harnessSlug,
    mergedOps: entry.mergedOps,
    highestSeen: entry.highestSeen,
    lastChangeMs: entry.lastChangeMs,
    caughtUp,
  };
}

/** Snapshot of every tracked harness. Used by the admin diagnostic page. */
export function listBootstrapProgress(
  opts: { idleMs?: number } = {},
): BootstrapProgressSnapshot[] {
  const out: BootstrapProgressSnapshot[] = [];
  for (const e of tracker.values()) {
    const snap = getBootstrapProgress(e.workspaceId, e.harnessSlug, opts);
    if (snap) out.push(snap);
  }
  return out;
}
