/**
 * Overlap clusters — domain-free near-duplicate detection over embedded units.
 *
 * Two different sources that say the same thing are a maintenance hazard: they
 * drift apart, and then a reader obeys whichever one they happened to open.
 * This module finds those pairs and groups them into clusters. It knows nothing
 * about what the units ARE — documents, prompts, recipes, rules — so the
 * neighbour source is injected at the `configureOverlapScan()` seam.
 *
 * ## Why a neighbour PROVIDER rather than a matrix
 *
 * The obvious implementation compares every unit with every other one. That is
 * O(n²) pair evaluations, each over a full embedding: a 6,500-unit corpus of
 * 384-dimensional vectors is ~21M pairs and ~8 billion multiply-adds, which is
 * not something to do in a scheduled sweep. Every real host that stores
 * embeddings already has an approximate-nearest-neighbour index that answers
 * "the k units most like this one" in log time. So the scan asks the HOST for
 * candidate neighbours and owns only the parts that are genuinely generic:
 * thresholding, cross-source filtering, symmetric de-duplication, clustering,
 * and the census. `bruteForceNeighbours()` is provided for small corpora and
 * tests, and it is the only path that needs `vector` populated.
 *
 * ## The load-bearing property: an empty result is not evidence
 *
 * A scan like this fails in one specific, expensive direction. If the threshold
 * is too high, or the vectors were never populated, or every unit landed in one
 * group, or the neighbour provider silently returns nothing, the scan reports
 * ZERO overlapping pairs — which is exactly what a genuinely clean corpus
 * reports. The failure is indistinguishable from success, permanently and
 * silently, and it is worse than an error because it is reassuring.
 *
 * So this module never returns a bare list. Every report carries a `census`
 * (how many units were comparable, how many candidate pairs were seen, how many
 * survived each filter) and an `inconclusive` verdict which is non-null
 * whenever the run did not actually measure a population capable of producing a
 * finding. **A caller may treat `pairs: []` as "no overlap" only when
 * `inconclusive === null`.** `describeOverlapReport()` renders that rule as a
 * sentence so a report cannot be quoted without its denominator.
 */

/** A unit of text that has been embedded and can be compared with others. */
export interface OverlapUnit {
  /** Stable identity, unique within one scan. Duplicate ids are skipped and censused. */
  id: string;
  /**
   * The SOURCE this unit came from — a file path, a document slug, a table
   * owner. Pairs drawn from the SAME group are excluded by default, because
   * the question is "do two DIFFERENT sources say the same thing"; a document
   * resembling itself is expected, not a finding.
   */
  group: string;
  /** The embedding. Required only by `bruteForceNeighbours`; an ANN-backed provider ignores it. */
  vector?: readonly number[];
}

/** One candidate neighbour, as returned by the host's index. */
export interface NeighbourHit {
  id: string;
  /** Similarity in [-1, 1]; cosine for embeddings. Higher is more alike. */
  similarity: number;
}

/**
 * Supplies candidate neighbours for a unit. May return fewer than requested,
 * may include the unit itself (filtered out), and need not be symmetric — the
 * scan de-duplicates pairs and keeps the highest similarity seen for each.
 */
export type NeighbourProvider = (
  unit: OverlapUnit,
  limit: number,
) => Promise<readonly NeighbourHit[]> | readonly NeighbourHit[];

export interface OverlapScanConfig {
  /**
   * Minimum similarity for a pair to count as overlapping. REQUIRED — there is
   * no defensible default, because the right value is a property of the corpus
   * and the embedding model, not of this algorithm. Calibrate it against the
   * real corpus; a value carried over from fixtures will be wrong.
   */
  threshold: number;
  /** Candidate neighbours to request per unit. Default 10. */
  neighbourLimit: number;
  /**
   * Exclude pairs whose units share a group. Default true. Set false only when
   * within-source repetition is itself the finding.
   */
  crossGroupOnly: boolean;
  /** Hard cap on reported pairs, so a degenerate corpus cannot exhaust memory. Default 5000. */
  maxPairs: number;
  /**
   * Minimum `census.coverage` for the run to count as evidence about the whole
   * corpus. Default 1.0 — deliberately the STRICT value, so a caller that
   * forgets to set it gets an inconclusive verdict rather than a silently
   * permissive one. Relax it only with a reason: a shortfall can only cause
   * false NEGATIVES, so the pairs a partial run DID find remain valid; what it
   * cannot support is the claim that the corpus is clean.
   */
  minCoverage: number;
  /** Where candidate neighbours come from. */
  neighbours: NeighbourProvider;
}

/**
 * Per-run measurements the caller knows and the scan cannot observe. Kept out
 * of the config on purpose: config is policy, this is evidence about one run.
 */
export interface OverlapScanInput {
  /**
   * How many units the caller knows the corpus holds but could not supply.
   * Supply this whenever your unit query filters on a condition that can be
   * temporarily false (a vector still being written, a row mid-migration) —
   * otherwise the shortfall is invisible to every consumer of the census.
   */
  unitsUnavailable?: number;
  /** Why they were unavailable, quoted verbatim into the inconclusive verdict. */
  unitsUnavailableReason?: string;
}

export interface OverlapPair {
  /** Ids, always ordered `a < b` so a pair has one canonical form. */
  a: string;
  b: string;
  groupA: string;
  groupB: string;
  similarity: number;
}

export interface OverlapCluster {
  /** Sorted unit ids in this cluster (always ≥ 2). */
  ids: string[];
  /** Sorted distinct groups the cluster spans. */
  groups: string[];
  size: number;
  minSimilarity: number;
  maxSimilarity: number;
}

/**
 * What the scan actually looked at. This is the denominator: it exists so a
 * zero finding can be told apart from a zero measurement.
 */
export interface OverlapCensus {
  unitsIn: number;
  /** Units that survived validation and were actually queried. */
  unitsComparable: number;
  /**
   * Units the caller KNOWS exist in the corpus but could not supply — e.g. a
   * row whose vector has not been written yet. Zero when the caller says
   * nothing, which is why `unitsIn` alone is NOT a corpus denominator: a host
   * that filters unusable rows out of its own query reports a numerator and a
   * denominator drawn from the same filtered population, so the ratio is
   * structurally 1.0 and can never reveal the shortfall.
   */
  unitsUnavailable: number;
  /** `unitsIn + unitsUnavailable` — the population the corpus actually holds. */
  unitsKnown: number;
  /**
   * `unitsComparable / unitsKnown`. The one ratio in this census whose
   * numerator and denominator come from DIFFERENT sources, so it can fall
   * below 1. Anything less than 1 means findings may be missing.
   */
  coverage: number;
  skipped: {
    duplicateId: number;
    blankId: number;
    /** Only counts for the brute-force provider: no vector, or an empty one. */
    noVector: number;
  };
  /** Distinct groups among comparable units. 1 means cross-group scanning cannot find anything. */
  groupsSeen: number;
  neighbourLookups: number;
  /** Candidate hits returned by the provider, before any filter. */
  candidateHitsSeen: number;
  /** Distinct candidate pairs after self/duplicate removal. */
  candidatePairs: number;
  /** Pairs remaining after the cross-group rule. */
  pairsCrossGroup: number;
  /** Pairs at or above the threshold — the reported findings. */
  pairsAboveThreshold: number;
  /** Pairs the maxPairs cap discarded. Non-zero means the report is partial. */
  pairsDropped: number;
  /** Comparisons refused because the two vectors had different lengths. A corpus bug, not dissimilarity. */
  dimensionMismatches: number;
}

export interface OverlapScanReport {
  threshold: number;
  pairs: OverlapPair[];
  clusters: OverlapCluster[];
  census: OverlapCensus;
  /**
   * `null` when the run measured a population that COULD have produced a
   * finding — only then does an empty `pairs` mean "no overlap". Otherwise a
   * sentence naming why this result is not evidence about the corpus.
   */
  inconclusive: string | null;
}

const DEFAULTS = {
  neighbourLimit: 10,
  crossGroupOnly: true,
  maxPairs: 5000,
  minCoverage: 1,
} as const;

/**
 * Resolve a scan configuration. `threshold` and `neighbours` are required and
 * have no defaults — a silently-defaulted threshold is the single most likely
 * cause of a confidently empty report.
 */
export function configureOverlapScan(
  overrides: Partial<OverlapScanConfig> & Pick<OverlapScanConfig, 'threshold' | 'neighbours'>,
): OverlapScanConfig {
  const { threshold, neighbours } = overrides;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new TypeError('configureOverlapScan: `threshold` must be a finite number (no default — calibrate it against the real corpus)');
  }
  if (typeof neighbours !== 'function') {
    throw new TypeError('configureOverlapScan: `neighbours` provider is required (use bruteForceNeighbours(units) for small corpora)');
  }
  const neighbourLimit = overrides.neighbourLimit ?? DEFAULTS.neighbourLimit;
  const maxPairs = overrides.maxPairs ?? DEFAULTS.maxPairs;
  if (!Number.isInteger(neighbourLimit) || neighbourLimit < 1) {
    throw new TypeError('configureOverlapScan: `neighbourLimit` must be a positive integer');
  }
  if (!Number.isInteger(maxPairs) || maxPairs < 1) {
    throw new TypeError('configureOverlapScan: `maxPairs` must be a positive integer');
  }
  const minCoverage = overrides.minCoverage ?? DEFAULTS.minCoverage;
  if (typeof minCoverage !== 'number' || !(minCoverage >= 0 && minCoverage <= 1)) {
    throw new TypeError('configureOverlapScan: `minCoverage` must be a number in [0, 1]');
  }
  return {
    threshold,
    neighbours,
    neighbourLimit,
    maxPairs,
    minCoverage,
    crossGroupOnly: overrides.crossGroupOnly ?? DEFAULTS.crossGroupOnly,
  };
}

/**
 * Cosine similarity. Returns 0 for an empty vector or a zero-norm vector.
 *
 * Mismatched lengths return `null`, NOT 0 — a dimension mismatch means the two
 * embeddings came from different models or a half-finished backfill, which is a
 * corpus fault. Reporting it as "similarity 0" would launder a broken corpus
 * into a clean-looking scan, which is the exact failure this module exists to
 * make impossible.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) return null;
  if (a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * An in-memory neighbour provider for small corpora and tests. O(n²) by
 * construction — do not point it at a production corpus; that is what the
 * injected ANN-backed provider is for.
 *
 * `onDimensionMismatch` lets the scan census mismatches the provider swallows.
 */
export function bruteForceNeighbours(
  units: readonly OverlapUnit[],
  onDimensionMismatch?: () => void,
): NeighbourProvider {
  return (unit, limit) => {
    const self = unit.vector;
    if (!self || self.length === 0) return [];
    const hits: NeighbourHit[] = [];
    for (const other of units) {
      if (other.id === unit.id) continue;
      if (!other.vector || other.vector.length === 0) continue;
      const sim = cosineSimilarity(self, other.vector);
      if (sim === null) {
        onDimensionMismatch?.();
        continue;
      }
      hits.push({ id: other.id, similarity: sim });
    }
    hits.sort((x, y) => y.similarity - x.similarity || x.id.localeCompare(y.id));
    return hits.slice(0, limit);
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

/**
 * Scan a set of units for overlapping pairs and group them into clusters.
 *
 * Deterministic: pairs are sorted by descending similarity then by id, and
 * clusters by their first id, so two runs over the same input are byte-identical.
 */
export async function scanOverlap(
  units: readonly OverlapUnit[],
  config: OverlapScanConfig,
  input: OverlapScanInput = {},
): Promise<OverlapScanReport> {
  const unitsUnavailable = Math.max(0, Math.trunc(input.unitsUnavailable ?? 0));
  const census: OverlapCensus = {
    unitsIn: units.length,
    unitsComparable: 0,
    unitsUnavailable,
    unitsKnown: units.length + unitsUnavailable,
    coverage: 0,
    skipped: { duplicateId: 0, blankId: 0, noVector: 0 },
    groupsSeen: 0,
    neighbourLookups: 0,
    candidateHitsSeen: 0,
    candidatePairs: 0,
    pairsCrossGroup: 0,
    pairsAboveThreshold: 0,
    pairsDropped: 0,
    dimensionMismatches: 0,
  };

  const byId = new Map<string, OverlapUnit>();
  for (const unit of units) {
    if (!unit.id) {
      census.skipped.blankId++;
      continue;
    }
    if (byId.has(unit.id)) {
      census.skipped.duplicateId++;
      continue;
    }
    byId.set(unit.id, unit);
  }
  const comparable = [...byId.values()];
  census.unitsComparable = comparable.length;
  census.coverage = census.unitsKnown === 0 ? 1 : comparable.length / census.unitsKnown;
  census.groupsSeen = new Set(comparable.map((u) => u.group)).size;

  const best = new Map<string, OverlapPair>();
  for (const unit of comparable) {
    census.neighbourLookups++;
    const hits = await config.neighbours(unit, config.neighbourLimit);
    for (const hit of hits) {
      census.candidateHitsSeen++;
      if (!hit || hit.id === unit.id) continue;
      const other = byId.get(hit.id);
      // A neighbour the caller did not include in `units` cannot be judged
      // (no group, no identity) — skip rather than invent one.
      if (!other) continue;
      if (!Number.isFinite(hit.similarity)) continue;

      const key = pairKey(unit.id, other.id);
      const existing = best.get(key);
      if (!existing) census.candidatePairs++;
      if (existing && existing.similarity >= hit.similarity) continue;

      const [a, b] = unit.id < other.id ? [unit, other] : [other, unit];
      best.set(key, {
        a: a.id,
        b: b.id,
        groupA: a.group,
        groupB: b.group,
        similarity: hit.similarity,
      });
    }
  }

  let kept: OverlapPair[] = [];
  for (const pair of best.values()) {
    if (config.crossGroupOnly && pair.groupA === pair.groupB) continue;
    census.pairsCrossGroup++;
    if (pair.similarity < config.threshold) continue;
    kept.push(pair);
  }
  census.pairsAboveThreshold = kept.length;

  kept.sort((x, y) => y.similarity - x.similarity || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  if (kept.length > config.maxPairs) {
    census.pairsDropped = kept.length - config.maxPairs;
    kept = kept.slice(0, config.maxPairs);
  }

  return {
    threshold: config.threshold,
    pairs: kept,
    clusters: clusterPairs(kept),
    census,
    inconclusive: judgeInconclusive(census, config, input),
  };
}

/** Union-find over the reported pairs. Only clusters of ≥ 2 units are returned. */
export function clusterPairs(pairs: readonly OverlapPair[]): OverlapCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    if (root !== x) {
      root = find(root);
      parent.set(x, root);
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const p of pairs) {
    if (!parent.has(p.a)) parent.set(p.a, p.a);
    if (!parent.has(p.b)) parent.set(p.b, p.b);
    union(p.a, p.b);
  }

  const members = new Map<string, Set<string>>();
  const sims = new Map<string, number[]>();
  const groups = new Map<string, Set<string>>();
  for (const p of pairs) {
    const root = find(p.a);
    if (!members.has(root)) {
      members.set(root, new Set());
      sims.set(root, []);
      groups.set(root, new Set());
    }
    members.get(root)!.add(p.a);
    members.get(root)!.add(p.b);
    sims.get(root)!.push(p.similarity);
    groups.get(root)!.add(p.groupA);
    groups.get(root)!.add(p.groupB);
  }

  const clusters: OverlapCluster[] = [];
  for (const [root, ids] of members) {
    const sorted = [...ids].sort();
    const s = sims.get(root)!;
    clusters.push({
      ids: sorted,
      groups: [...groups.get(root)!].sort(),
      size: sorted.length,
      minSimilarity: Math.min(...s),
      maxSimilarity: Math.max(...s),
    });
  }
  clusters.sort((x, y) => y.size - x.size || x.ids[0]!.localeCompare(y.ids[0]!));
  return clusters;
}

/**
 * Decide whether this run is capable of having produced a finding. Non-null
 * means the caller must NOT read an empty `pairs` as a clean corpus.
 *
 * Every branch here is a way a scan can return zero while measuring nothing.
 */
export function judgeInconclusive(
  census: OverlapCensus,
  config: OverlapScanConfig,
  input: OverlapScanInput = {},
): string | null {
  if (census.unitsComparable < 2) {
    return `only ${census.unitsComparable} comparable unit(s) of ${census.unitsIn} supplied — a pair needs two, so this run could not have found anything`;
  }
  if (config.crossGroupOnly && census.groupsSeen < 2) {
    return `all ${census.unitsComparable} comparable units are in a single group, and crossGroupOnly is on — every possible pair was excluded by construction`;
  }
  if (census.candidateHitsSeen === 0) {
    return `the neighbour provider returned no candidates at all across ${census.neighbourLookups} lookup(s) — the index is empty, unpopulated, or misconfigured; this is not evidence about the corpus`;
  }
  if (census.candidatePairs === 0) {
    return `no candidate hit resolved to a supplied unit across ${census.neighbourLookups} lookup(s) — the provider is returning ids that are not in the scanned set`;
  }
  if (config.crossGroupOnly && census.pairsCrossGroup === 0) {
    return `all ${census.candidatePairs} candidate pair(s) were within a single source — nothing survived the cross-group rule, so the threshold was never exercised`;
  }
  if (census.dimensionMismatches > 0 && census.pairsAboveThreshold === 0) {
    return `${census.dimensionMismatches} comparison(s) were refused for mismatched vector dimensions and nothing cleared the threshold — the corpus embeddings are inconsistent, so a zero result reflects the vectors, not the text`;
  }
  if (census.coverage < config.minCoverage) {
    const pct = (census.coverage * 100).toFixed(1);
    const why = input.unitsUnavailableReason ? ` (${input.unitsUnavailableReason})` : '';
    return (
      `only ${census.unitsComparable} of ${census.unitsKnown} known unit(s) were comparable — ${pct}% coverage, ` +
      `below the ${(config.minCoverage * 100).toFixed(1)}% required${why}. ` +
      `The ${census.unitsKnown - census.unitsComparable} missing unit(s) were never compared, so this run cannot ` +
      `support the claim that the corpus is clean; the pairs it DID find remain valid`
    );
  }
  return null;
}

/**
 * One sentence stating what the scan measured, so a result cannot be quoted
 * without its denominator. Renders the inconclusive verdict when there is one.
 */
export function describeOverlapReport(report: OverlapScanReport): string {
  const c = report.census;
  // The denominator is unitsKnown, never unitsComparable: quoting the survivor
  // count as the population is how a partial scan reads as a complete one.
  const shortfall =
    c.unitsUnavailable > 0
      ? ` (${c.unitsUnavailable} known unit(s) could not be supplied — ${(c.coverage * 100).toFixed(1)}% coverage)`
      : '';
  const base =
    `${c.unitsComparable} of ${c.unitsKnown} known unit(s) comparable${shortfall} across ${c.groupsSeen} source(s); ` +
    `${c.candidatePairs} candidate pair(s), ${c.pairsCrossGroup} cross-source, ` +
    `${c.pairsAboveThreshold} at or above threshold ${report.threshold}`;
  if (report.inconclusive) return `INCONCLUSIVE — ${report.inconclusive}. Measured: ${base}.`;
  if (report.pairs.length === 0) return `No overlap found. Measured: ${base}.`;
  const partial = c.pairsDropped > 0 ? ` (${c.pairsDropped} further pair(s) dropped by the maxPairs cap — this report is partial)` : '';
  return `${report.pairs.length} overlapping pair(s) in ${report.clusters.length} cluster(s). Measured: ${base}${partial}.`;
}
