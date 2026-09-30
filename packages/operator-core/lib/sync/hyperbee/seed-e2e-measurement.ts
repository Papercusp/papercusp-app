/**
 * seed-e2e-measurement — the P-010 packaged-install E2E measurement + acceptance
 * (plan hive-seed-bundle-2026-07-04).
 *
 * P-010 ACCEPTANCE: on a fresh packaged install, a SEEDED first boot reaches a
 * USABLE hive (plans + work-items visible, repo usable) transferring only the live
 * DELTA — while the real join STAYS exercised (D-007: the dogfood value is that
 * admission + federation still run; only the full-history transfer moves to the
 * seed). This module turns that acceptance into a structured verdict.
 *
 * SPLIT BY TESTABILITY (the honest boundary — deploys are frozen while
 * green-checkpoint is stalled, so the real two-install measurement cannot run here):
 *   - {@link evaluateSeedE2E} — PURE: given a COLD boot measurement and a SEEDED
 *     boot measurement, decide every acceptance check (usable, join-exercised,
 *     delta-only, faster). Fully unit-tested headless.
 *   - {@link PackagedInstallMeasure} — the HEAVY seam: actually boot a fresh
 *     packaged install (once cold via PAPERCUSP_NO_SEED, once seeded) and measure
 *     wall-time + network bytes + the usable-hive counts. Needs a packaged BUILD +
 *     rig, so the default ({@link unavailablePackagedMeasure}) throws a clear
 *     build-required error; a rig registers a real measure via
 *     {@link runSeedE2EMeasurement}'s `measure` dep. No fabricated numbers.
 *
 * The real measure a rig should provide does, per mode:
 *   cold:   install the packaged app with PAPERCUSP_NO_SEED=1; time first boot to a
 *           usable hive; sum bytes over the join transport (full history).
 *   seeded: install the packaged app normally (seed restores pre-boot); time first
 *           boot to a usable hive; sum bytes over the join transport (delta only).
 *   both:   record joinExercised = did admission + delta replication actually run.
 */

import {
  evaluateColdJoinProbe,
  DEFAULT_COLD_JOIN_THRESHOLDS,
  type ColdJoinObservations,
  type ColdJoinProbeThresholds,
} from './cold-join-executor';

/** One packaged first-boot measurement. */
export interface BootMeasurement extends ColdJoinObservations {
  /** 'cold' = no seed (full history) | 'seeded' = seed restore + live delta. */
  readonly mode: 'cold' | 'seeded';
  /** Wall-clock ms from install start to a usable (or settled) hive. */
  readonly wallMs: number;
  /** Whether the LIVE join path actually ran (admission + delta replication). Must
   *  be true for BOTH modes — a seed that bypassed the real join would defeat the
   *  dogfood (D-007). */
  readonly joinExercised: boolean;
}

export interface SeedE2EThresholds {
  readonly usability: ColdJoinProbeThresholds;
  /** Seeded network transfer must be <= this fraction of the cold transfer for the
   *  "delta-only" claim to hold (e.g. 0.25 = seeded moved <= 1/4 of cold's bytes). */
  readonly maxDeltaFraction: number;
  /** Require the seeded first boot to be strictly faster than cold. */
  readonly requireFaster: boolean;
}

export const DEFAULT_SEED_E2E_THRESHOLDS: SeedE2EThresholds = {
  usability: DEFAULT_COLD_JOIN_THRESHOLDS,
  maxDeltaFraction: 0.25,
  requireFaster: true,
};

export interface SeedE2ECheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SeedE2EVerdict {
  readonly ok: boolean;
  readonly checks: readonly SeedE2ECheck[];
  readonly summary: string;
}

/**
 * PURE acceptance: compare a COLD and a SEEDED packaged first-boot measurement and
 * decide every P-010 check. Overall ok iff every check passes. Each check names its
 * observed values so a failure is self-explaining.
 */
export function evaluateSeedE2E(
  cold: BootMeasurement,
  seeded: BootMeasurement,
  thresholds: SeedE2EThresholds = DEFAULT_SEED_E2E_THRESHOLDS,
): SeedE2EVerdict {
  const checks: SeedE2ECheck[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 0. Modes must be what they claim (guard against a swapped/mislabeled measure).
  push(
    'modes-correct',
    cold.mode === 'cold' && seeded.mode === 'seeded',
    `cold.mode=${cold.mode}, seeded.mode=${seeded.mode}`,
  );

  // 1. The COLD path itself must reach a usable hive — the baseline the seed must match.
  const coldProbe = evaluateColdJoinProbe(cold, { thresholds: thresholds.usability });
  push('cold-usable', coldProbe.ok, coldProbe.detail ?? '');

  // 2. The SEEDED install must reach a usable hive (the core acceptance).
  const seededProbe = evaluateColdJoinProbe(seeded, { thresholds: thresholds.usability });
  push('seeded-usable', seededProbe.ok, seededProbe.detail ?? '');

  // 3. The real join must STILL be exercised on BOTH (D-007 — the seed is a byte
  //    pre-position, not a join bypass).
  push(
    'join-exercised-both',
    cold.joinExercised && seeded.joinExercised,
    `cold.joinExercised=${cold.joinExercised}, seeded.joinExercised=${seeded.joinExercised}`,
  );

  // 4. DELTA-ONLY: seeded transferred at most maxDeltaFraction of cold's bytes.
  if (typeof cold.bytesTransferred !== 'number' || typeof seeded.bytesTransferred !== 'number') {
    push('delta-only', false, 'network bytes not measured for one or both modes');
  } else {
    const cap = cold.bytesTransferred * thresholds.maxDeltaFraction;
    const frac = cold.bytesTransferred > 0 ? seeded.bytesTransferred / cold.bytesTransferred : 0;
    push(
      'delta-only',
      seeded.bytesTransferred <= cap,
      `seeded=${seeded.bytesTransferred}B vs cold=${cold.bytesTransferred}B (${(frac * 100).toFixed(1)}% ` +
        `<= ${(thresholds.maxDeltaFraction * 100).toFixed(0)}% cap)`,
    );
  }

  // 5. FASTER first boot (optional — the wall-time win the seed buys).
  if (thresholds.requireFaster) {
    push(
      'seeded-faster',
      seeded.wallMs < cold.wallMs,
      `seeded=${seeded.wallMs}ms vs cold=${cold.wallMs}ms`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  const summary =
    failed.length === 0
      ? `PASS — seeded install reaches a usable hive with delta-only transfer, real join exercised (${checks.length} checks)`
      : `FAIL — ${failed.map((c) => c.name).join(', ')} (${failed.length}/${checks.length} checks failed)`;
  return { ok: failed.length === 0, checks, summary };
}

/** The HEAVY seam: boot + measure a fresh packaged install in the given mode. */
export type PackagedInstallMeasure = (mode: 'cold' | 'seeded') => Promise<BootMeasurement>;

export const PACKAGED_MEASURE_BUILD_REQUIRED =
  'seed E2E measurement: no packaged-install measure is registered. Measuring cold-vs-seeded ' +
  'first boot needs a fresh PACKAGED BUILD + rig (install the app twice and measure wall-time + ' +
  'network bytes) — not available in this process. A rig injects `measure` into ' +
  'runSeedE2EMeasurement(...) (plan hive-seed-bundle-2026-07-04 P-010). Deploys are currently ' +
  'frozen (green-checkpoint stalled on quartermaster), so this executes only from a rig with a build.';

/** Default measure: refuse honestly — never fabricates numbers. */
export const unavailablePackagedMeasure: PackagedInstallMeasure = async () => {
  throw new Error(PACKAGED_MEASURE_BUILD_REQUIRED);
};

export interface RunSeedE2EOpts {
  /** The packaged-install measure seam (default: build-required thrower). */
  measure?: PackagedInstallMeasure;
  thresholds?: SeedE2EThresholds;
}

/**
 * Run the full P-010 measurement: measure a COLD boot, measure a SEEDED boot, and
 * evaluate the acceptance verdict. The `measure` seam is build-dependent — the
 * default throws {@link PACKAGED_MEASURE_BUILD_REQUIRED} so this is honest about
 * needing a packaged build; a rig injects a real measure.
 */
export async function runSeedE2EMeasurement(opts: RunSeedE2EOpts = {}): Promise<SeedE2EVerdict> {
  const measure = opts.measure ?? unavailablePackagedMeasure;
  const cold = await measure('cold');
  const seeded = await measure('seeded');
  return evaluateSeedE2E(cold, seeded, opts.thresholds ?? DEFAULT_SEED_E2E_THRESHOLDS);
}
