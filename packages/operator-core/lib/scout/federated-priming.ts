/**
 * federated-priming.ts — shared control knobs + crowding math for federated
 * Scout↔gym learning (federated-scout-gym-learning-2026-07-02 P-016 / D-004 / D-005).
 *
 * P-016 is the independent preparatory slice for the later F2/F3 lanes:
 *   - depth-aware crowding = count HOW MANY elites clear a fitness bar in one
 *     niche, not just whether the niche is occupied at all;
 *   - the v1→v2 niche-key mapping seam is exercised NOW, so future embedding
 *     niches can coexist without bifurcating the archive/metric readers;
 *   - a migration-rate-0 CONTROL profile is first-class, giving P-011 a clean
 *     falsifiability baseline ("more peers" must beat "same code, no foreign elites").
 *
 * Pure — no PG, no network. Callers provide the read-time union of local
 * `gym_qd_archive` elites and foreign `gym_qd_foreign_elites` rows; this module
 * groups them after canonical key-mapping and reports the crowding depth.
 */
import { mapV1KeyForward } from '../gym/niche-descriptor';

export interface FederatedPrimingConfig {
  /** Nearby foreign elites surfaced per cycle (default small, owner-ratified). */
  foreignElites: number;
  /** Crowded niches surfaced per cycle. */
  crowded: number;
  /** Empty niches surfaced per cycle. */
  empty: number;
}

export const DEFAULT_FEDERATED_PRIMING: Readonly<FederatedPrimingConfig> = Object.freeze({
  foreignElites: 3,
  crowded: 5,
  empty: 5,
});

/** P-016 falsifiability baseline: identical code-path, zero foreign migration. */
export const CONTROL_HIVE_FEDERATED_PRIMING: Readonly<FederatedPrimingConfig> = Object.freeze({
  foreignElites: 0,
  crowded: 0,
  empty: 0,
});

function asNonNegativeInt(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.max(0, Math.floor(n));
}

/** Merge + clamp a partial override. Undefined fields keep the default. */
export function resolveFederatedPrimingConfig(
  override?: Partial<FederatedPrimingConfig> | null,
): FederatedPrimingConfig {
  if (!override) return { ...DEFAULT_FEDERATED_PRIMING };
  return {
    foreignElites: asNonNegativeInt(override.foreignElites) ?? DEFAULT_FEDERATED_PRIMING.foreignElites,
    crowded: asNonNegativeInt(override.crowded) ?? DEFAULT_FEDERATED_PRIMING.crowded,
    empty: asNonNegativeInt(override.empty) ?? DEFAULT_FEDERATED_PRIMING.empty,
  };
}

/** True iff this profile is the no-migration control arm. */
export function isControlHivePriming(cfg: FederatedPrimingConfig): boolean {
  return cfg.foreignElites === 0 && cfg.crowded === 0 && cfg.empty === 0;
}

/** One local or foreign elite participating in the read-time crowding view. */
export interface FederatedEliteView {
  nicheKey: string;
  fitness: number;
  /** Null/undefined = local archive row; non-null = one foreign source partition. */
  sourceHive?: string | null;
  noveltyGift?: boolean;
}

export interface DepthAwareCrowdingOptions {
  /**
   * Minimum fitness that counts toward "crowding depth". Below-bar rows still
   * count toward occupancy / source coverage, but they do NOT deepen a niche.
   */
  fitnessBar: number;
  /** Reserved mapping seam for the future v2 embedding buckets. */
  mapKey?: (key: string) => string;
}

export interface NicheCrowdingStat {
  /** Canonical mapped key (today: v1 identity; later: v1→v2 forward map). */
  nicheKey: string;
  /** The raw contributing keys that collapsed into this canonical bucket. */
  rawKeys: string[];
  /** Total local+foreign elite rows contributing to this niche. */
  totalElites: number;
  /** Depth-aware crowding: only rows whose fitness >= fitnessBar. */
  elitesAboveBar: number;
  /** Distinct sources contributing at all (`local` + source_hive partitions). */
  contributingSources: number;
  /** Distinct sources whose elite cleared the fitness bar. */
  sourcesAboveBar: number;
  /** Best fitness observed in the canonical niche. */
  bestFitness: number | null;
  /** Novelty-gift rows currently contributing (useful for later metric consumers). */
  noveltyGiftCount: number;
}

function sourcePartition(sourceHive?: string | null): string {
  return sourceHive && sourceHive.trim().length > 0 ? sourceHive.trim() : '__local__';
}

/**
 * Depth-aware crowding over a read-time union of local and foreign elites.
 * Sorted most-crowded first so digest/metric consumers can slice from the head.
 */
export function computeDepthAwareCrowding(
  elites: readonly FederatedEliteView[],
  opts: DepthAwareCrowdingOptions,
): NicheCrowdingStat[] {
  const mapKey = opts.mapKey ?? mapV1KeyForward;
  const byKey = new Map<
    string,
    {
      rawKeys: Set<string>;
      totalElites: number;
      elitesAboveBar: number;
      sources: Set<string>;
      sourcesAboveBar: Set<string>;
      bestFitness: number | null;
      noveltyGiftCount: number;
    }
  >();

  for (const elite of elites) {
    const canonicalKey = mapKey(elite.nicheKey);
    let bucket = byKey.get(canonicalKey);
    if (!bucket) {
      bucket = {
        rawKeys: new Set<string>(),
        totalElites: 0,
        elitesAboveBar: 0,
        sources: new Set<string>(),
        sourcesAboveBar: new Set<string>(),
        bestFitness: null,
        noveltyGiftCount: 0,
      };
      byKey.set(canonicalKey, bucket);
    }
    const src = sourcePartition(elite.sourceHive);
    bucket.rawKeys.add(elite.nicheKey);
    bucket.totalElites += 1;
    bucket.sources.add(src);
    if (bucket.bestFitness == null || elite.fitness > bucket.bestFitness) {
      bucket.bestFitness = elite.fitness;
    }
    if (elite.noveltyGift === true) bucket.noveltyGiftCount += 1;
    if (elite.fitness >= opts.fitnessBar) {
      bucket.elitesAboveBar += 1;
      bucket.sourcesAboveBar.add(src);
    }
  }

  return [...byKey.entries()]
    .map(([nicheKey, bucket]) => ({
      nicheKey,
      rawKeys: [...bucket.rawKeys].sort(),
      totalElites: bucket.totalElites,
      elitesAboveBar: bucket.elitesAboveBar,
      contributingSources: bucket.sources.size,
      sourcesAboveBar: bucket.sourcesAboveBar.size,
      bestFitness: bucket.bestFitness,
      noveltyGiftCount: bucket.noveltyGiftCount,
    }))
    .sort(
      (a, b) =>
        b.elitesAboveBar - a.elitesAboveBar ||
        b.sourcesAboveBar - a.sourcesAboveBar ||
        b.totalElites - a.totalElites ||
        (b.bestFitness ?? -Infinity) - (a.bestFitness ?? -Infinity) ||
        a.nicheKey.localeCompare(b.nicheKey),
    );
}
