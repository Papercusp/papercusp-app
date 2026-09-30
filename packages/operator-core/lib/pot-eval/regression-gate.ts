/**
 * regression-gate.ts — the continuous regression gate + per-hive staged rollout decision
 * (plan-implementation-framework-2026-06-15 P-009; D-005 default-on + per-hive staged
 * rollout + auto-revert, D-006 the bake-off as a continuous regression detector).
 *
 * Default-on (D-005) means a bet ships live before it is proven, so the bake-off (P-007)
 * is no longer a pre-flip GATE but a continuous REGRESSION DETECTOR feeding a per-hive
 * staged rollout: a bet climbs the ladder (off → canary → … → full) while it keeps
 * beating the baseline, and AUTO-REVERTS to off the moment a bake-off run regresses.
 *
 * This module is the DECIDEABLE CORE — pure, unit-tested: given a bake-off verdict, decide
 * advance / hold / revert. The WIRING is the documented ACTIVATION, not built here:
 *   • a 'revert' decision → the existing queen-autonomy revert-executor
 *     (lib/autonomy/tripwire/revert-executor.ts registerReverter) to flip the bet's flag off;
 *   • the per-hive rollout stage → a per-hive flag override at that stage;
 *   • the A-vs-B trend → a Learning/Benchmark-tab artifact (nuqs + @papercusp/sync, SHA-rerun;
 *     sibling of iq-battery / gym / prompt-ablation).
 */
import type { BakeoffResult, BakeoffVerdict } from './framework-bake-off';

/** The per-hive staged-rollout ladder: a bet climbs one rung per winning bake-off. */
export type RolloutStage = 'off' | 'canary' | 'quarter' | 'half' | 'full';
export const ROLLOUT_LADDER: readonly RolloutStage[] = ['off', 'canary', 'quarter', 'half', 'full'];

export type RolloutAction = 'advance' | 'hold' | 'revert';

export interface RolloutDecision {
  action: RolloutAction;
  from: RolloutStage;
  to: RolloutStage;
  reason: string;
}

/** The un-gameable gate, one line: a regressed bake-off verdict means revert. */
export function shouldRevert(result: BakeoffResult): boolean {
  return result.delta.verdict === 'regressed';
}

/**
 * Decide the next per-hive rollout stage from a bake-off verdict. A regression reverts
 * straight to `off` from ANY rung (the un-gameable floor — never keep a regressing bet
 * live); an improvement advances ONE rung; neutral / inconclusive / already-full holds.
 * Pure.
 */
export function decideRollout(current: RolloutStage, verdict: BakeoffVerdict): RolloutDecision {
  const i = ROLLOUT_LADDER.indexOf(current);
  if (verdict === 'regressed') {
    return { action: 'revert', from: current, to: 'off', reason: 'bake-off regressed vs baseline — auto-revert to off' };
  }
  if (verdict === 'improved' && i >= 0 && i < ROLLOUT_LADDER.length - 1) {
    return {
      action: 'advance',
      from: current,
      to: ROLLOUT_LADDER[i + 1],
      reason: `bake-off improved — advance the staged rollout to ${ROLLOUT_LADDER[i + 1]}`,
    };
  }
  return { action: 'hold', from: current, to: current, reason: `verdict '${verdict}' — hold at ${current}` };
}
