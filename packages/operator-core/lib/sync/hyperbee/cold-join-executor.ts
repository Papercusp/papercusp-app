/**
 * cold-join-executor — the HEAVY executor for the D-007 cold-join canary
 * (plan hive-seed-bundle-2026-07-04 P-010 live-wire 3).
 *
 * P-008 built the canary SHELL (cold-join-canary.ts): the schedule, the
 * debounce clock, pass/fail recording, and the alerting — all AROUND an injected
 * `ColdJoinExecutor` seam. This module implements that seam: it runs a REAL cold
 * join (seed restore forcibly DISABLED, the `--no-seed` / PAPERCUSP_NO_SEED path)
 * and probes the resulting install for a USABLE hive (plans + work-items visible,
 * repo usable), collapsing the observation into a {@link ColdJoinProbeResult}.
 *
 * SPLIT BY TESTABILITY (the honest-headless boundary):
 *   - {@link evaluateColdJoinProbe} — PURE decision: given observed counts, is the
 *     hive usable? Fully unit-tested headless, no DB / no join.
 *   - {@link buildDefaultColdJoinExecutor} — the orchestration (time the run, call
 *     the heavy spawn, evaluate). Tested headless with a FAKE spawn seam.
 *   - {@link ColdJoinSpawnObserve} — the HEAVY seam: actually boot a fresh cold
 *     operator, join the canonical hive with NO seed, and read plans/work-items/
 *     repo. This genuinely needs a packaged / rig environment (a second operator
 *     instance + real network to the canonical hive owner + a multi-GB clone), so
 *     it is NOT implemented in-process here: the default ({@link unavailableColdJoinSpawn})
 *     throws a clear rig-required error, and a rig REGISTERS its real implementation
 *     via {@link setColdJoinSpawnObserve}. This keeps the canary honest — an enabled
 *     canary with no real spawn ALERTS (via the watchdog ledger) rather than faking a
 *     pass.
 *
 * The real spawn a rig should register does, in order:
 *   1. mkdtemp a throwaway operator data dir (fresh identity, no prior hive).
 *   2. Boot an operator with PAPERCUSP_NO_SEED=1 so `resolveSeedDir()` reports
 *      `disabled` and `bootstrapPapercuspHive` takes the COLD join path
 *      (invite→announce→admission→epoch keys→swarm FULL-history replication).
 *   3. Wait for join to reach 'joined' and the swarm delta to settle.
 *   4. Read the projected PG: COUNT(plans), COUNT(work_items), and whether the
 *      cloned superproject repo is usable (HEAD resolves, submodules initialized).
 *   5. Tear down the throwaway operator.
 *   6. Return the observations (+ bytesTransferred if the transport exposes it).
 */

import type { ColdJoinExecutor, ColdJoinProbeResult } from './cold-join-canary';

/** What a forced cold join observed about the resulting install. */
export interface ColdJoinObservations {
  /** Number of plans visible after the cold join (the projected PG count). */
  readonly plansVisible: number;
  /** Number of work-items visible after the cold join. */
  readonly workItemsVisible: number;
  /** Whether the cloned repo is usable (HEAD resolves + submodules initialized). */
  readonly repoUsable: boolean;
  /** Optional: bytes the cold join transferred (for the E2E delta comparison). */
  readonly bytesTransferred?: number;
}

/** Acceptance thresholds for "a usable hive" (D-007 / P-010 ACCEPTANCE). */
export interface ColdJoinProbeThresholds {
  readonly minPlans: number;
  readonly minWorkItems: number;
}

/** The canonical dogfood hive always has >= 1 plan and >= 1 work-item; a cold join
 *  that reaches neither did not actually federate the shared state. */
export const DEFAULT_COLD_JOIN_THRESHOLDS: ColdJoinProbeThresholds = {
  minPlans: 1,
  minWorkItems: 1,
};

/**
 * PURE decision: is the observed post-cold-join install a USABLE hive? A hive is
 * usable iff plans AND work-items are visible above the thresholds AND the repo is
 * usable. Returns a {@link ColdJoinProbeResult} whose `detail` always names the
 * observed counts (so a PASS is auditable and a FAIL names exactly what was missing).
 */
export function evaluateColdJoinProbe(
  obs: ColdJoinObservations,
  opts: { elapsedMs?: number; thresholds?: ColdJoinProbeThresholds } = {},
): ColdJoinProbeResult {
  const t = opts.thresholds ?? DEFAULT_COLD_JOIN_THRESHOLDS;
  const failures: string[] = [];
  if (obs.plansVisible < t.minPlans) failures.push(`plans ${obs.plansVisible} < ${t.minPlans}`);
  if (obs.workItemsVisible < t.minWorkItems) failures.push(`work-items ${obs.workItemsVisible} < ${t.minWorkItems}`);
  if (!obs.repoUsable) failures.push('repo not usable');

  const parts = [
    `plans=${obs.plansVisible}`,
    `workItems=${obs.workItemsVisible}`,
    `repo=${obs.repoUsable ? 'usable' : 'UNUSABLE'}`,
  ];
  if (typeof opts.elapsedMs === 'number') parts.push(`${Math.round(opts.elapsedMs)}ms`);
  if (typeof obs.bytesTransferred === 'number') parts.push(`${obs.bytesTransferred}B`);
  const summary = parts.join(', ');

  return failures.length === 0
    ? { ok: true, detail: `usable hive (${summary})` }
    : { ok: false, detail: `NOT a usable hive — ${failures.join('; ')} (${summary})` };
}

/**
 * The HEAVY seam: force a cold join (no seed) and observe the result. Throwing
 * means the join itself could not be attempted / completed (rig unreachable, boot
 * crash) — the canary maps that to an 'error' outcome. Returning a non-usable
 * observation means the join RAN but produced no usable hive — the canary maps
 * that to a 'failed' outcome (the meaningful cold-path-regression signal).
 */
export type ColdJoinSpawnObserve = () => Promise<ColdJoinObservations>;

export const COLD_JOIN_RIG_REQUIRED =
  'cold-join canary: no real cold-join spawn is registered in this process. A forced ' +
  'cold join (fresh operator, PAPERCUSP_NO_SEED, multi-GB clone + full-history ' +
  'federation) needs a packaged / rig environment — a rig must register its real ' +
  'implementation via setColdJoinSpawnObserve(...) (plan hive-seed-bundle-2026-07-04 P-010).';

/** Default spawn: refuse honestly. Never fabricates a pass — an enabled canary with
 *  no real spawn surfaces as an alert, not a green. */
export const unavailableColdJoinSpawn: ColdJoinSpawnObserve = async () => {
  throw new Error(COLD_JOIN_RIG_REQUIRED);
};

let registeredSpawnObserve: ColdJoinSpawnObserve | null = null;

/**
 * A rig / packaged environment registers its REAL forced-cold-join+observe here at
 * boot; the canary's default executor picks it up at call time. Pass null to clear
 * (tests). Absent ⇒ {@link resolveColdJoinSpawnObserve} yields {@link unavailableColdJoinSpawn}.
 */
export function setColdJoinSpawnObserve(fn: ColdJoinSpawnObserve | null): void {
  registeredSpawnObserve = fn;
}

/** Resolve the active spawn seam: the registered rig impl, or the rig-required thrower. */
export function resolveColdJoinSpawnObserve(): ColdJoinSpawnObserve {
  return registeredSpawnObserve ?? unavailableColdJoinSpawn;
}

export interface BuildColdJoinExecutorDeps {
  /** The heavy spawn+observe seam (default: the resolved rig registration). */
  spawnObserve?: ColdJoinSpawnObserve;
  /** Injectable clock for timing (default: Date.now). */
  now?: () => number;
  /** Usability thresholds (default: {@link DEFAULT_COLD_JOIN_THRESHOLDS}). */
  thresholds?: ColdJoinProbeThresholds;
}

/**
 * Compose a {@link ColdJoinExecutor} from the spawn seam + the pure evaluator: time
 * the cold join, observe, and decide. A spawn throw propagates (⇒ canary 'error');
 * a non-usable observation returns ok:false (⇒ canary 'failed').
 */
export function buildDefaultColdJoinExecutor(deps: BuildColdJoinExecutorDeps = {}): ColdJoinExecutor {
  const now = deps.now ?? (() => Date.now());
  const spawnObserve = deps.spawnObserve ?? (() => resolveColdJoinSpawnObserve()());
  return async () => {
    const t0 = now();
    const obs = await spawnObserve();
    const elapsedMs = now() - t0;
    return evaluateColdJoinProbe(obs, { elapsedMs, thresholds: deps.thresholds });
  };
}

/**
 * The canary's DEFAULT executor for routines-workflow. Resolves the registered rig
 * spawn (or the rig-required thrower) at EACH call, so a rig that registers after
 * boot still works, and a non-rig host that has (deliberately) enabled the canary
 * surfaces an honest 'error' alert instead of a fake pass. The canary is
 * default-DISABLED (interval <= 0), so this is a complete no-op unless opted in.
 */
export const defaultColdJoinExecutor: ColdJoinExecutor = () => buildDefaultColdJoinExecutor()();
