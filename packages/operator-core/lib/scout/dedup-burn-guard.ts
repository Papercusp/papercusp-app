/**
 * dedup-burn-guard.ts — the consecutive-cycle dedup-burn guard
 * (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-007 / WI-39479).
 *
 * THE INCIDENT (2026-08-06/07): the Scout ran cycle after cycle into a
 * saturated corpus — 428 ideas generated, ~all pruned by the novelty critics,
 * 0 routed — burning the full ideation budget each fire while the ledger
 * quietly recorded ran-tick after ran-tick. Nothing reacted, because nothing
 * READ the burn: the dedup ratio was persisted per tick (tick-ledger
 * ideasDeduped) but no consumer looked across ticks.
 *
 * THE GUARD: before a fresh ideation cycle, read the recent ran-ticks and
 * assess the streak of saturated cycles (dedup ratio ≥ threshold). When the
 * streak reaches the trigger, the cycle still runs — but differently:
 *   1. WIDEN THE NOVELTY BAND — lower `buckets.noveltyFloor` a step per
 *      saturated cycle past the trigger (clamped), so borderline-novel ideas
 *      survive instead of being burned again;
 *   2. REFRESH THE DIGEST — stamp {@link CorpusDigest.dedupSaturation} so
 *      renderDigest (lenses.ts) drops the standing patterns from the ideator
 *      prompt (fresh-signal-only when fresh signal exists) and leads with a
 *      saturation banner, steering generation AWAY from the saturated corpus
 *      instead of into it.
 *
 * Split by house convention: pure math here ({@link assessDedupBurn},
 * {@link widenNoveltyBand}), the thin PG edge in {@link readDedupBurnVerdict}
 * (fail-open by contract — a ledger outage yields an unsaturated verdict,
 * never a failed cycle).
 */

import type { ScoutTickRecord } from './tick-ledger';
import type { ScoutConfig } from './config';

/** The per-tick fields the guard assesses (a {@link ScoutTickRecord} satisfies it). */
export type DedupBurnTick = Pick<
  ScoutTickRecord,
  'status' | 'ideasGenerated' | 'ideasRouted' | 'ideasDeduped'
>;

export interface DedupBurnOptions {
  /** ideasDeduped / ideasGenerated at/above which a ran-cycle counts as saturated (default 0.8). */
  dedupRatioThreshold?: number;
  /** Consecutive saturated ran-cycles that trigger the guard (default 2). */
  consecutiveCycles?: number;
  /** Ran-cycles generating fewer ideas than this neither count toward nor break
   *  the streak — a 1-idea cycle's ratio is noise, not evidence (default 4). */
  minIdeasPerCycle?: number;
  /** How much `noveltyFloor` drops per widening step (default 0.06). */
  noveltyFloorStep?: number;
  /** The widened floor never goes below this (default 0.16 — still strictly
   *  above 0, so an exact-duplicate can never survive on widening alone). */
  minNoveltyFloor?: number;
  /** Cap on widening steps however long the streak runs (default 3). */
  maxWideningSteps?: number;
}

export const DEFAULT_DEDUP_BURN_OPTIONS: Required<DedupBurnOptions> = {
  dedupRatioThreshold: 0.8,
  consecutiveCycles: 2,
  minIdeasPerCycle: 4,
  noveltyFloorStep: 0.06,
  minNoveltyFloor: 0.16,
  maxWideningSteps: 3,
};

export interface DedupBurnVerdict {
  /** The trigger fired: widen the band + refresh the digest this cycle. */
  saturated: boolean;
  /** Saturated ran-cycles counted back from the newest qualifying one. */
  consecutiveSaturated: number;
  /** The newest qualifying ran-cycle's dedup ratio (0 when none qualified). */
  lastRatio: number;
  /** Widening steps to apply — 0 unless saturated; grows one per saturated
   *  cycle past the trigger, capped at `maxWideningSteps`. */
  wideningSteps: number;
  /** One line for the tick detail / logs. */
  reason: string;
}

const UNSATURATED: DedupBurnVerdict = {
  saturated: false,
  consecutiveSaturated: 0,
  lastRatio: 0,
  wideningSteps: 0,
  reason: 'no saturated ran-cycles in the window',
};

/**
 * Assess the dedup-burn streak over recent ticks (NEWEST FIRST — the order
 * `readScoutTicks` returns). Streak semantics:
 *   - only `ran` ticks with ideasGenerated ≥ minIdeasPerCycle carry evidence;
 *   - a qualifying tick with ratio ≥ threshold EXTENDS the streak;
 *   - a qualifying tick below the threshold BREAKS it (the corpus admitted
 *     novel ideas — not saturated);
 *   - `gated` / `error` ticks and sub-minimum ran-ticks are SKIPPED (they say
 *     nothing about saturation either way).
 */
export function assessDedupBurn(
  ticksNewestFirst: readonly DedupBurnTick[],
  opts: DedupBurnOptions = {},
): DedupBurnVerdict {
  const o = { ...DEFAULT_DEDUP_BURN_OPTIONS, ...definedOnly(opts) };
  let streak = 0;
  let lastRatio = 0;
  for (const tick of ticksNewestFirst) {
    if (tick.status !== 'ran') continue;
    const generated = tick.ideasGenerated ?? 0;
    if (generated < o.minIdeasPerCycle) continue;
    const ratio = (tick.ideasDeduped ?? 0) / generated;
    if (ratio < o.dedupRatioThreshold) break;
    if (streak === 0) lastRatio = ratio;
    streak += 1;
  }
  if (streak < o.consecutiveCycles) {
    return streak === 0
      ? UNSATURATED
      : {
          ...UNSATURATED,
          consecutiveSaturated: streak,
          lastRatio: round2(lastRatio),
          reason: `${streak} saturated cycle(s) < trigger ${o.consecutiveCycles}`,
        };
  }
  const wideningSteps = Math.min(streak - o.consecutiveCycles + 1, o.maxWideningSteps);
  return {
    saturated: true,
    consecutiveSaturated: streak,
    lastRatio: round2(lastRatio),
    wideningSteps,
    reason:
      `${streak} consecutive ran-cycles at dedup ratio ≥ ${o.dedupRatioThreshold} ` +
      `(latest ${round2(lastRatio)}) — widening the novelty band ${wideningSteps} step(s) ` +
      `and refreshing the digest to fresh-signal-only`,
  };
}

/**
 * The widened novelty floor for a saturated cycle: `floor − steps·step`,
 * clamped to `minNoveltyFloor`. Pure; 0 steps returns the floor unchanged.
 */
export function widenNoveltyBand(
  baseNoveltyFloor: number,
  wideningSteps: number,
  opts: DedupBurnOptions = {},
): number {
  const o = { ...DEFAULT_DEDUP_BURN_OPTIONS, ...definedOnly(opts) };
  if (wideningSteps <= 0) return baseNoveltyFloor;
  return round2(Math.max(o.minNoveltyFloor, baseNoveltyFloor - wideningSteps * o.noveltyFloorStep));
}

/**
 * A saturated cycle's effective ScoutConfig: the same config with
 * `buckets.noveltyFloor` widened per the verdict. Unsaturated verdicts return
 * the input unchanged (same reference — callers can `!==` to detect a widen).
 */
export function applyDedupBurnToConfig(config: ScoutConfig, verdict: DedupBurnVerdict): ScoutConfig {
  if (!verdict.saturated || verdict.wideningSteps <= 0) return config;
  const widened = widenNoveltyBand(config.buckets.noveltyFloor, verdict.wideningSteps);
  if (widened === config.buckets.noveltyFloor) return config;
  return { ...config, buckets: { ...config.buckets, noveltyFloor: widened } };
}

/** How many ledger rows the verdict read scans — enough ran-ticks to cover the
 *  longest meaningful streak with gated/error rows interleaved. */
const LEDGER_SCAN_LIMIT = 40;

/**
 * The production read: recent ticks from the ledger → {@link assessDedupBurn}.
 * FAIL-OPEN by contract: any read failure returns the unsaturated verdict — the
 * guard must never break or gate a cycle, only re-shape one.
 */
export async function readDedupBurnVerdict(scope: {
  workspaceId?: string;
  installSlug?: string;
  opts?: DedupBurnOptions;
}): Promise<DedupBurnVerdict> {
  try {
    const { readScoutTicks } = await import('./tick-ledger');
    const ticks = await readScoutTicks({
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      ...(scope.installSlug ? { installSlug: scope.installSlug } : {}),
      limit: LEDGER_SCAN_LIMIT,
    });
    return assessDedupBurn(ticks, scope.opts);
  } catch (err) {
    console.warn(
      '[scout/dedup-burn-guard] ledger read failed (fail-open, cycle unaffected):',
      err instanceof Error ? err.message : err,
    );
    return UNSATURATED;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `{ ...defaults, ...opts }` poisons defaults with explicit-undefined keys; strip them. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
