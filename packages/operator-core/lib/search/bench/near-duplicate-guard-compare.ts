/**
 * near-duplicate-guard-compare — the R-8 comparison of
 * shared-vector-search-libraries-2026-09-29 P-004 (WI-10004273).
 *
 * Question: should the work-item duplicate guard (work_items/semantic-dupe-guard.ts,
 * fixed cosine thresholds + a pg_trgm title co-signal) adopt the library's
 * corpus-calibrated near-duplicate check (@papercusp/search near-duplicate.ts,
 * the cut plans:new uses)? Answered on real filings: for each approach, how many
 * judged duplicates it misses and how many judged non-duplicates it would merge.
 *
 * This module is the pure half. Both approaches are run through their REAL code,
 * not a re-implementation:
 *  - the current guard via `findSemanticDupes` with injected seams (the stored
 *    historical top-k stands in for the live query), so its thresholds, the
 *    co-signal and any env override apply exactly as in production;
 *  - the library via `checkNearDuplicates`, with the guard's top-k as the
 *    candidate list and a background sample of the same historical pool.
 * The one hypothetical variant (`hybrid`) is labelled as such: it is what
 * adoption WITH the title co-signal would look like, and no production code
 * implements it.
 *
 * The CLI (near-duplicate-guard-compare-cli.ts) reconstructs each filing's pool
 * in SQL and hands this module one {@link FilingObservation} per labelled pair.
 */
import { EMBEDDER_DIM_SPECS, type EmbedderProfileSpec } from '@papercusp/memory';
import { findSemanticDupes, type SemanticDupeCandidate } from '../../agent-tools/work_items/semantic-dupe-guard';
import {
  checkNearDuplicates,
  DEFAULT_NEAR_DUPLICATE_QUANTILE,
} from '../../../../../libs/generic/search/src/near-duplicate';

/** The guard ranks the new filing against this many nearest open items (TOP_K * 2 in the guard). */
export const GUARD_CANDIDATE_LIMIT = 6;

/**
 * The guard's co-signal title floor (CO_SIGNAL_MIN_TITLE in semantic-dupe-guard.ts).
 * Used ONLY by the hypothetical `hybrid` variant; the `current` approach reads the
 * guard's own constant by running the guard. A test pins this against the guard source.
 */
export const HYBRID_TITLE_FLOOR = 0.45;

/**
 * How a labelled pair was judged. `duplicate` / `distinct` / `related` /
 * `remedy-keep` come from the admission promoter's adjudication ledger
 * (r-finding-merge / distinct / r-related / r-remedy-keep). `closed-as-duplicate`
 * is a dropped item whose close names its survivor but which that ledger never
 * judged. `unlabelled` is a random filing with no partner: it measures how often
 * an approach fires at all.
 */
export type PairLabel = 'duplicate' | 'closed-as-duplicate' | 'distinct' | 'related' | 'remedy-keep' | 'unlabelled';

export const DUPLICATE_LABELS: readonly PairLabel[] = ['duplicate', 'closed-as-duplicate'];
export const NON_DUPLICATE_LABELS: readonly PairLabel[] = ['distinct', 'related', 'remedy-keep'];

export interface PoolNeighbour {
  id: string;
  title?: string;
  /** Cosine similarity to the filing (1 - pgvector `<=>`). */
  cosine: number;
  /** pg_trgm similarity(neighbour title, filing title). */
  titleSimilarity: number;
}

export interface FilingObservation {
  /** The later-filed item of the pair: the create the guard would have screened. */
  filingId: string;
  /** The earlier item, open when the filing was created. Null for `unlabelled`. */
  partnerId: string | null;
  label: PairLabel;
  /** Open items (same workspace, harness, embedding mode) when the filing was created. */
  poolSize: number;
  /** The filing's nearest pool items by cosine, best first (at most GUARD_CANDIDATE_LIMIT). */
  top: PoolNeighbour[];
  /** Cosines to a deterministic sample of pool items outside `top`. */
  background: number[];
  /** The partner's standing in the pool; null when the partner is not in it. */
  partner: { cosine: number; titleSimilarity: number; rank: number } | null;
}

export type ApproachName = 'current' | 'library' | 'hybrid';

export interface ApproachVerdict {
  /** Ids the approach would refuse the create over (treat as a merge). */
  flagged: string[];
  /** True when the approach returned no verdict (guard fail-open / library uncalibrated). */
  noVerdict: boolean;
  /** The cut the library calibrated, when it did. */
  cut?: number;
}

const GEMMA = EMBEDDER_DIM_SPECS.gemma;

/**
 * The current guard, run as production runs it. The embedder seam returns a
 * zero vector of the stored width (the guard uses the vector only to query, and
 * the query seam here returns the historical top-k instead). Coverage is stubbed
 * empty so no database is touched.
 */
export async function classifyWithCurrentGuard(
  obs: FilingObservation,
  filingTitle: string,
  harness: string,
  mode = 'gemma',
  profile: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'> = GEMMA,
): Promise<ApproachVerdict> {
  const candidates: SemanticDupeCandidate[] = obs.top.map((n) => ({
    id: n.id,
    title: n.title ?? '',
    state: 'open',
    harness,
    similarity: n.cosine,
    titleSimilarity: n.titleSimilarity,
  }));
  const result = await findSemanticDupes(
    { title: filingTitle, harness },
    {
      resolveEmbedder: async () => ({
        mode,
        dims: profile.targetDims,
        profile,
        embed: async () => new Array<number>(profile.targetDims).fill(0),
      }),
      queryCandidates: async () => candidates,
      loadCoverage: async () => new Map(),
    },
  );
  if (!result) return { flagged: [], noVerdict: true };
  return { flagged: result.hard.map((c) => c.id), noVerdict: false };
}

/**
 * The library check as the guard would adopt it: the guard's top-k is the
 * candidate list, the background is the filing's cosine to pool items outside
 * that list, and every candidate at or above the calibrated cut is flagged.
 * An uncalibrated outcome is treated as "no verdict, proceed", the guard's own
 * fail-open rule.
 */
export async function classifyWithLibrary(
  obs: FilingObservation,
  quantile: number = DEFAULT_NEAR_DUPLICATE_QUANTILE,
): Promise<ApproachVerdict> {
  const byId = new Map(obs.top.map((n) => [n.id, n.cosine] as const));
  const outcome = await checkNearDuplicates({
    candidates: obs.top,
    keyOf: (n) => n.id,
    similarities: async () => byId,
    sampleBackground: async (_exclude, limit) => obs.background.slice(0, limit),
    quantile,
    similarityDecimals: null,
  });
  if (!outcome.verdict) return { flagged: [], noVerdict: true };
  return {
    flagged: outcome.kept.filter((k) => 'similarity' in k).map((k) => k.id),
    noVerdict: false,
    cut: outcome.calibration.cut,
  };
}

/**
 * HYPOTHETICAL — no production code implements this. The guard's co-signal
 * with the library's calibrated cut in place of the fixed 0.86 cosine floor:
 * flag when cosine >= hard, or when cosine >= cut AND the title is similar.
 */
export function classifyWithHybrid(
  obs: FilingObservation,
  library: ApproachVerdict,
  hard: number,
  titleFloor: number = HYBRID_TITLE_FLOOR,
): ApproachVerdict {
  const cut = library.cut;
  const flagged = obs.top
    .filter((n) => n.cosine >= hard || (cut !== undefined && n.cosine >= cut && n.titleSimilarity >= titleFloor))
    .map((n) => n.id);
  return { flagged, noVerdict: false, ...(cut !== undefined ? { cut } : {}) };
}

export interface StratumCounts {
  label: PairLabel;
  pairs: number;
  filings: number;
  /** Duplicate strata: pairs whose partner the approach flagged. */
  caught?: number;
  /** Duplicate strata: pairs whose partner the approach did NOT flag. */
  missed?: number;
  /** Of `missed`, how many had the partner outside the guard's top-k (neither approach can see it). */
  missedOutsideTopK?: number;
  /** Non-duplicate strata: pairs whose partner the approach flagged (a false merge). */
  falseMerges?: number;
  /** Filings where the approach flagged anything at all. */
  filingsFlagged: number;
  noVerdict: number;
}

export interface ApproachSummary {
  approach: ApproachName;
  strata: StratumCounts[];
  /** Headline: duplicate strata combined. */
  missedDuplicates: number;
  duplicatePairs: number;
  /** Headline: non-duplicate strata combined. */
  falseMerges: number;
  nonDuplicatePairs: number;
}

export interface ScoredObservation {
  obs: FilingObservation;
  verdicts: Record<ApproachName, ApproachVerdict>;
}

/** Count misses and false merges per approach and label. Pure. */
export function summarizeComparison(scored: readonly ScoredObservation[]): ApproachSummary[] {
  const approaches: ApproachName[] = ['current', 'library', 'hybrid'];
  const labels: PairLabel[] = [...DUPLICATE_LABELS, ...NON_DUPLICATE_LABELS, 'unlabelled'];
  return approaches.map((approach) => {
    const strata: StratumCounts[] = [];
    for (const label of labels) {
      const rows = scored.filter((s) => s.obs.label === label);
      if (rows.length === 0) continue;
      const flaggedFilings = new Set<string>();
      let noVerdict = 0;
      let partnerFlagged = 0;
      let missedOutsideTopK = 0;
      for (const { obs, verdicts } of rows) {
        const v = verdicts[approach];
        if (v.noVerdict) noVerdict += 1;
        if (v.flagged.length > 0) flaggedFilings.add(obs.filingId);
        const hit = obs.partnerId !== null && v.flagged.includes(obs.partnerId);
        if (hit) partnerFlagged += 1;
        else if (obs.partnerId !== null && (obs.partner === null || obs.partner.rank > GUARD_CANDIDATE_LIMIT)) {
          missedOutsideTopK += 1;
        }
      }
      const base: StratumCounts = {
        label,
        pairs: rows.length,
        filings: new Set(rows.map((r) => r.obs.filingId)).size,
        filingsFlagged: flaggedFilings.size,
        noVerdict,
      };
      if (DUPLICATE_LABELS.includes(label)) {
        strata.push({ ...base, caught: partnerFlagged, missed: rows.length - partnerFlagged, missedOutsideTopK });
      } else if (NON_DUPLICATE_LABELS.includes(label)) {
        strata.push({ ...base, falseMerges: partnerFlagged });
      } else {
        strata.push(base);
      }
    }
    const dup = strata.filter((s) => DUPLICATE_LABELS.includes(s.label));
    const non = strata.filter((s) => NON_DUPLICATE_LABELS.includes(s.label));
    return {
      approach,
      strata,
      missedDuplicates: dup.reduce((n, s) => n + (s.missed ?? 0), 0),
      duplicatePairs: dup.reduce((n, s) => n + s.pairs, 0),
      falseMerges: non.reduce((n, s) => n + (s.falseMerges ?? 0), 0),
      nonDuplicatePairs: non.reduce((n, s) => n + s.pairs, 0),
    };
  });
}

/** How far the two arms of a paired candidate-pool comparison actually diverged. */
export interface PairedArmDivergence {
  filingsCompared: number;
  /** Filings whose two arms saw a different number of pool items. */
  poolsDiffer: number;
  /** Filings whose two arms ranked a different top-k (ids or order). */
  topKDiffers: number;
  /**
   * True when every filing saw the SAME pool in both arms: the comparison
   * compared nothing, and any delta it reports (always zero) is meaningless.
   */
  vacuous: boolean;
}

/**
 * Measure whether a paired before/after pool comparison compared anything.
 * WI-10005217: a filter applied to the shared pool CTE made the "previous" arm
 * identical to the "current" one, and the run reported a delta of 0/0 that
 * looked like "no regression". An A/B whose arms never differ is a broken
 * instrument, so callers refuse a vacuous result instead of publishing it. Pure.
 */
export function pairedArmDivergence(
  pairs: ReadonlyArray<{ current: FilingObservation; previous: FilingObservation }>,
): PairedArmDivergence {
  let poolsDiffer = 0;
  let topKDiffers = 0;
  for (const { current, previous } of pairs) {
    if (current.poolSize !== previous.poolSize) poolsDiffer += 1;
    const a = current.top.map((n) => n.id).join('\u0000');
    const b = previous.top.map((n) => n.id).join('\u0000');
    if (a !== b) topKDiffers += 1;
  }
  return {
    filingsCompared: pairs.length,
    poolsDiffer,
    topKDiffers,
    vacuous: pairs.length > 0 && poolsDiffer === 0 && topKDiffers === 0,
  };
}
