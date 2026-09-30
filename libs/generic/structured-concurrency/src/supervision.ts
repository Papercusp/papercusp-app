/**
 * supervision — the spawn tree as a SUPERVISION TREE.
 *
 * Failure flows UP. When a supervised child crashes, the supervisor decides what to
 * restart (the OTP restart strategy) — UNLESS it's crash-looping, in which case a
 * restart-INTENSITY governor stops the bleeding and escalates. Tighter than OTP's
 * microsecond defaults because an expensive restart (an LLM agent) costs dollars, not
 * cycles.
 *
 *   • recordRestartIntensity — sliding-window restart counter (> MaxR in MaxT ⇒ stop).
 *   • restartSet — which spawns a strategy restarts (one_for_one | one_for_all | rest_for_one).
 *   • superviseCrash — restart the set, OR (intensity exceeded) tear the subtree down
 *     (via the nursery, freeing its locks/claims) + escalate.
 *
 * The windowing math + the strategy selection are pure (decideIntensity / computeRestartSet);
 * the store owns the atomic row-locked persistence.
 */
import { isActiveStatus, type IntensityResult, type RestartStrategy, type SpawnNode } from './types';
import type { EscalateFn, IntensityDecision, RestartWindowRow, SpawnTreeStore } from './ports';
import type { Nursery, CancelSubtreeResult } from './nursery';

export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_RESTART_WINDOW_SEC = 600; // 10 min — an LLM restart is minutes, not µs

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * The pure sliding-window decision: given the current window row + a clock, return this
 * restart's count, the (possibly reset) window start, and whether the crash-loop bound is
 * breached. A null/lapsed window resets to a fresh count of 1.
 */
export function decideIntensity(row: RestartWindowRow, nowMs: number, maxRestarts: number, windowSec: number): IntensityDecision {
  const winStartMs = row.restartWindowStart ? new Date(row.restartWindowStart).getTime() : null;
  if (winStartMs === null || nowMs - winStartMs > windowSec * 1000) {
    return { count: 1, windowStartMs: nowMs, windowReset: true, intensityExceeded: 1 > maxRestarts };
  }
  const count = Number(row.restartCount) + 1;
  return { count, windowStartMs: winStartMs, windowReset: false, intensityExceeded: count > maxRestarts };
}

export interface RestartSet {
  strategy: RestartStrategy;
  /** spawnIds to restart (the crashed node + siblings per the strategy). */
  toRestart: string[];
  crashed: SpawnNode | null;
}

/**
 * Pure: which spawns a crash restarts, given the crashed node + its ordered siblings
 * (started_at ASC, then spawnId). A root spawn (no parent) behaves one_for_one.
 *  - one_for_one  → just the crashed node.
 *  - one_for_all  → the crashed node + all its ACTIVE siblings (shared invariant).
 *  - rest_for_one → the crashed node + every sibling started AFTER it (ordered dependency).
 */
export function computeRestartSet(crashed: SpawnNode, siblings: readonly SpawnNode[]): RestartSet {
  if (crashed.restartStrategy === 'one_for_one' || !crashed.parentSpawnId) {
    return { strategy: crashed.restartStrategy, toRestart: [crashed.spawnId], crashed };
  }
  if (crashed.restartStrategy === 'one_for_all') {
    const set = siblings.filter((s) => s.spawnId === crashed.spawnId || isActiveStatus(s.status)).map((s) => s.spawnId);
    return { strategy: 'one_for_all', toRestart: uniq([crashed.spawnId, ...set]), crashed };
  }
  // rest_for_one — the crashed node + later-started siblings.
  const idx = siblings.findIndex((s) => s.spawnId === crashed.spawnId);
  const later = (idx >= 0 ? siblings.slice(idx) : [crashed]).filter(
    (s) => s.spawnId === crashed.spawnId || isActiveStatus(s.status),
  );
  return { strategy: 'rest_for_one', toRestart: uniq(later.map((s) => s.spawnId)), crashed };
}

export interface SuperviseResult {
  spawnId: string;
  action: 'restart' | 'escalate' | 'noop';
  intensity: IntensityResult | null;
  strategy: RestartStrategy;
  /** When action='restart': the spawns marked 'restarting' for the orchestrator to re-run. */
  toRestart: string[];
  /** When action='escalate': the escalation id + the subtree teardown result. */
  escalationId?: string;
  cancel?: CancelSubtreeResult;
  reason: string;
}

export interface SuperviseOptions {
  workspaceId: string;
  spawnId: string;
  reason?: string;
  maxRestarts?: number;
  windowSec?: number;
}

export interface SupervisorDeps {
  store: SpawnTreeStore;
  /** Used on the escalate path to tear the doomed subtree down (release its locks/claims). */
  nursery: Nursery;
  /** The human-escalation effect fired when the crash-loop bound is breached. */
  escalate: EscalateFn;
}

export interface Supervisor {
  recordRestartIntensity(opts: { workspaceId: string; spawnId: string; maxRestarts?: number; windowSec?: number }): Promise<IntensityResult | null>;
  restartSet(opts: { workspaceId: string; crashedSpawnId: string }): Promise<RestartSet>;
  superviseCrash(opts: SuperviseOptions): Promise<SuperviseResult>;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { store, nursery } = deps;

  async function recordRestartIntensity(opts: { workspaceId: string; spawnId: string; maxRestarts?: number; windowSec?: number }): Promise<IntensityResult | null> {
    const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const windowSec = opts.windowSec ?? DEFAULT_RESTART_WINDOW_SEC;
    return store.recordRestartIntensity(
      { workspaceId: opts.workspaceId, spawnId: opts.spawnId, maxRestarts, windowSec },
      (row, nowMs) => decideIntensity(row, nowMs, maxRestarts, windowSec),
    );
  }

  async function restartSet(opts: { workspaceId: string; crashedSpawnId: string }): Promise<RestartSet> {
    const crashed = await store.getSpawn(opts.workspaceId, opts.crashedSpawnId);
    if (!crashed) return { strategy: 'one_for_one', toRestart: [], crashed: null };
    if (crashed.restartStrategy === 'one_for_one' || !crashed.parentSpawnId) {
      return computeRestartSet(crashed, []);
    }
    const siblings = await store.directChildren(opts.workspaceId, crashed.parentSpawnId);
    return computeRestartSet(crashed, siblings);
  }

  async function superviseCrash(opts: SuperviseOptions): Promise<SuperviseResult> {
    const intensity = await recordRestartIntensity({
      workspaceId: opts.workspaceId,
      spawnId: opts.spawnId,
      maxRestarts: opts.maxRestarts,
      windowSec: opts.windowSec,
    });
    if (!intensity) {
      return { spawnId: opts.spawnId, action: 'noop', intensity: null, strategy: 'one_for_one', toRestart: [], reason: 'spawn not found' };
    }

    if (intensity.intensityExceeded) {
      const reason = `restart intensity exceeded — ${intensity.count} restarts in ${intensity.windowSec}s (> ${intensity.maxRestarts})`;
      // Stop the bleeding: tear down the whole subtree (frees its locks/claims NOW).
      const cancel = await nursery.cancelSubtree({ workspaceId: opts.workspaceId, rootSpawnId: opts.spawnId, reason });
      // The root of a crash-loop FAILED (distinct from a clean cancel).
      await store.markFailed(opts.workspaceId, opts.spawnId, reason);
      const esc = await deps.escalate({
        severity: 'blocker',
        summary: `Crash-loop: spawn ${opts.spawnId} ${reason}`,
        body: `Supervised restart of ${opts.spawnId} (${opts.reason ?? 'crash'}) breached the intensity bound. The subtree was torn down and its locks/claims released. A human must decide whether to retry, re-scope, or abandon this work.`,
      });
      return { spawnId: opts.spawnId, action: 'escalate', intensity, strategy: 'one_for_one', toRestart: [], escalationId: esc.msg_id, cancel, reason };
    }

    // Within budget — restart per strategy.
    const rs = await restartSet({ workspaceId: opts.workspaceId, crashedSpawnId: opts.spawnId });
    if (rs.toRestart.length > 0) {
      await store.markRestarting(opts.workspaceId, rs.toRestart);
    }
    return {
      spawnId: opts.spawnId,
      action: 'restart',
      intensity,
      strategy: rs.strategy,
      toRestart: rs.toRestart,
      reason: `restart (${rs.strategy}); attempt ${intensity.count}/${intensity.maxRestarts} in window`,
    };
  }

  return { recordRestartIntensity, restartSet, superviseCrash };
}
