/**
 * labelled-relevance.ts — P-038's labelled pass: LLM-judged relevance labels
 * for REAL mid/long queries against the LIVE hybrid stack
 * (plan semantic-search-fingerprint-coverage-2026-08-03, D-078/D-079 / WI-37638).
 *
 * This is the thing D-076's derived-gold bench structurally could not deliver.
 * D-078 established WHY it was needed rather than merely nice: D-076's gold
 * labels a document relevant when it CITES the referenced item — a CITATION
 * edge, which coincides with the TOPICAL edge only ~46% of the time. D-076's
 * A/B delta still stands (both arms share the gold), but its ABSOLUTE recall
 * and nDCG figures mean "retrieval of CITING documents" and must never be
 * quoted as relevance figures. These ones are relevance figures.
 *
 * Pure and dependency-injected: retrieval and judging both arrive as functions,
 * so every rule here — the grade mapping, the degrade refusal, the aggregation
 * — is unit-tested offline at $0. That is D-079 Q1's split: gate-test the
 * arithmetic, run the LLM deliberately.
 *
 * ⛔ Not a gate. ~1,500 judge calls at k=10 ≈ $12-15 per run, with a measured
 * self-consistency flip rate of 0-12.5%. And D-074 still binds: no `minNdcgAtK`
 * floor may be set off ONE run — thresholds must be sampled across DAYS.
 */
import {
  evaluateRelevance,
  type RelevanceEvalCoverage,
  type RelevanceEvalResult,
} from '@papercusp/search-core';

import {
  JUDGE_AGREEMENT_MODEL,
  JUDGE_AGREEMENT_RUBRIC_VERSION,
  RELEVANCE_PASS_BAR,
  type JudgeVerdict,
} from './judge-agreement';

/** Bump when the mapping, the k, or anything else about this pass changes. */
export const LABELLED_PASS_VERSION = 'search-relevance-labelled.v1';

/** Default cutoff. Matches the eval harness's nDCG@10. */
export const DEFAULT_K = 10;

/** Documents are truncated to a bounded judging prompt, as the pilot does. */
export const DOC_CHARS = 1200;

// =============================================================================
// The 0..5 judge score → 0..3 metric grade mapping
// =============================================================================

/**
 * Map a judge score (0..5, the content-versioned search rubric) onto the metric contract's
 * 0..3 grade scale.
 *
 * The bands are chosen so the two thresholds that already exist LINE UP rather
 * than being independently invented:
 *
 * | judge | grade | why this boundary |
 * |---|---|---|
 * | 0-1 | 0 | grade <= `accessoryThreshold` (1) ⇒ counted as pollution |
 * | 2   | 1 | below the bar, but not a wasted result |
 * | 3   | 2 | judge score === `RELEVANCE_PASS_BAR` ⇔ grade === `precisionThreshold` (2) |
 * | 4-5 | 3 | fully relevant |
 *
 * The load-bearing property is the third row: "the judge called it relevant"
 * (score >= 3) and "precision@k counts it" (grade >= 2) must be the SAME
 * predicate, or the pass reports a precision that disagrees with its own
 * labels. A linear rescale (`score * 3/5`) breaks exactly that — it puts the
 * pass bar at grade 1.8, below the precision threshold, so a document the judge
 * called relevant would not count as a precision hit.
 */
export function judgeScoreToGrade(score: number): number {
  if (!Number.isFinite(score)) throw new Error(`judge score must be finite, got ${score}`);
  const s = Math.max(0, Math.min(5, score));
  if (s < 2) return 0;
  if (s < RELEVANCE_PASS_BAR) return 1;
  if (s < 4) return 2;
  return 3;
}

// =============================================================================
// Shapes
// =============================================================================

/** One hit as the live engine ranked it. */
export interface RankedHit {
  /** Stable id — the engine's `source_id`. */
  docId: string;
  /** The text actually shown to the judge (already truncated). */
  docText: string;
  /** 1-based position in the returned page. */
  rank: number;
  /** Which registered SearchSource produced it, when the engine says. */
  source?: string;
  /**
   * The fused RRF score (`SearchHit.score`). Captured for completeness, NOT as a
   * floor candidate: D-084 established it is rank-derived and "in nobody's
   * units", so a threshold on it is a rank cutoff `limit` already performs for
   * free. Useful only to show a floor curve plotted against it restates rank.
   */
  score?: number;
  /**
   * PRE-FUSION per-ranker native scores (`{ lexical: 0.07, embeddings: 0.61 }`).
   * Real magnitudes, but per-ranker and ABSENT for rankers that did not return
   * this hit — never assume a key is present.
   */
  rankerScores?: Record<string, number>;
  /**
   * The Stage B cross-encoder score — the one true query↔document relevance
   * magnitude in the stack, and therefore the only quantity a relevance floor
   * can be expressed in (D-084/D-085).
   *
   * ⚠ ABSENT, never 0, for a candidate the cross-encoder did not score —
   * including EVERY candidate of a call that degraded to retrieval order, and
   * every candidate of a `--no-rerank` arm where the stage never ran. Absence
   * means UNKNOWN: a `>= x` floor must DROP such a row, not keep it as a scored
   * zero. Collapsing absence into 0 makes a dead engine read as a corpus full of
   * garbage and calibrates the floor HIGH — the failure this invariant exists to
   * prevent.
   */
  rerankScore?: number;
}

/** A hit plus the judge's label for it. */
export interface LabelledHit extends RankedHit {
  relevance: number;
  grade: number;
  judgeCostUsd: number;
  judgeNotes?: string;
}

/** What retrieval returned for one query, plus its own honesty report. */
export interface RetrievalResult {
  hits: RankedHit[];
  /**
   * The WHOLE fused candidate pool in final order — every over-fetched
   * candidate, not just the `k` that make the page. Present only under
   * `--pool-all`; absent means "top-k only, as every prior run measured".
   *
   * ⚠ INVARIANT, enforced in `runLabelledPass` before a single judge call is
   * paid for: `hits` must be the PREFIX of this list. The pool arm exists to be
   * compared against runs that judged only the page, so if widening the rerank
   * slice perturbed the top-k the two are not measuring the same ranking and
   * every number is uncomparable. That is a code defect, not a data condition,
   * so it aborts the run rather than excluding the query.
   *
   * Carries the top-k rows too (not just the tail) ON PURPOSE: a tail-only field
   * is a biased sample of exactly the low-ranked candidates, and a floor curve
   * computed from it alone would look catastrophic for reasons that are an
   * artefact of the slice. This way `poolHits` is self-contained and correct
   * read on its own — which is how an analyst will read it.
   */
  poolHits?: RankedHit[];
  /**
   * TRUE when a ranker leg did not run — the engine silently falls back to
   * lexical-only when the query embedder is unavailable. A degraded run
   * measured a DIFFERENT SYSTEM, so it is excluded from every aggregate rather
   * than averaged in.
   */
  degraded: boolean;
  degradeWarning?: string | null;
  /** Whether Stage B cross-encoder reranking actually ran (it is fail-safe). */
  rerankApplied: boolean;
  latencyMs?: number;
}

/** One query, fully labelled and scored. */
export interface QueryOutcome {
  /** The telemetry stratum this query was drawn from. */
  tool: string;
  query: string;
  terms: number;
  /**
   * The TOP-K page, labelled. EVERY aggregate in this pass is computed over this
   * field and only this field — see the denominator warning on `rollUp`.
   */
  hits: LabelledHit[];
  /**
   * The whole fused candidate pool, labelled — present only under `--pool-all`.
   *
   * ⚠ NOT AN AGGREGATE INPUT, and never concatenate it with `hits`: its first
   * `k` entries ARE `hits` (the same judged objects, one judge call each), so
   * appending would double-count the page. It exists for the D-084 floor study,
   * which needs labels for the candidates a floor would CUT — the ones that
   * never reach the page and are therefore invisible to every top-k metric.
   */
  poolHits?: LabelledHit[];
  /** `null` for an EXCLUDED query — see `excludedReason`. */
  ndcgAtK: number | null;
  precisionAtK: number | null;
  accessoryAtK: number | null;
  coverage: RelevanceEvalCoverage;
  degraded: boolean;
  rerankApplied: boolean;
  judgeCostUsd: number;
  latencyMs?: number;
  /**
   * Why this query contributes to NO aggregate. `null` ⇒ it counts.
   *
   * Stated per query rather than dropped silently: a pass that measured 150
   * queries and scored 131 must say so on the number, or the excluded 19 read
   * as if they had been measured and agreed.
   */
  excludedReason: string | null;
}

/** Per-stratum roll-up. Never pooled across `degraded` runs. */
export interface ToolAggregate {
  tool: string;
  /** Queries that CONTRIBUTED (excluded ones are not counted here). */
  n: number;
  excluded: number;
  meanNdcgAtK: number;
  meanPrecisionAtK: number;
  meanAccessoryAtK: number;
  /** Fraction of judged hits at grade 0 — the pollution rate, hit-weighted. */
  pollutionRate: number;
  /**
   * Counted queries whose judged grade vector holds ≤1 DISTINCT grade — so every
   * permutation of the ranking scores identically and nDCG@k carries NO ordering
   * information about them.
   *
   * This is the honesty field for `meanNdcgAtK`. The ideal ranking is derived from
   * the SAME k documents that were returned, so nDCG here measures ordering WITHIN
   * the returned set and has no recall leg: a query whose returned hits the judge
   * graded uniformly relevant scores 1.0 however the engine ordered them. Pooling
   * those into a mean produces a high, confident-looking number that no amount of
   * bad ranking could have lowered. Reported as a count so `meanNdcgAtK` can never
   * be quoted as a search-quality score without the share it was computed over.
   */
  ndcgUninformative: number;
}

export interface LabelledPassReport {
  version: string;
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  rubricVersion: string;
  passBar: number;
  k: number;
  sampleSeed: string;
  outcomes: QueryOutcome[];
  byTool: ToolAggregate[];
  overall: ToolAggregate;
  judgeCostUsd: number;
  judgedHits: number;
  /** Limits that must travel WITH the numbers, never as a footnote elsewhere. */
  caveats: string[];
}

// =============================================================================
// Scoring
// =============================================================================

/** Score one labelled ranking. The judgement is already made; this is metrics. */
export function scoreQuery(hits: readonly LabelledHit[], k: number = DEFAULT_K): RelevanceEvalResult {
  return evaluateRelevance<LabelledHit>({
    ranked: hits,
    grade: (h) => h.grade,
    k,
    // No `groundTruth`: this pass has no externally-known relevant set — it is
    // PRODUCING the labels. `recallAtK` therefore reports null, which is the
    // honest answer; a 0 would read as "found none of them" from a run that had
    // nothing to find.
  });
}

function meanOf(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * ⚠⚠ THE DENOMINATOR TRAP (D-084, and the reason `poolHits` is a SEPARATE field).
 *
 * `pollutionRate` and `ndcgUninformative` below are computed over ALL of
 * `o.hits` — not over a top-k slice of it. So widening `QueryOutcome.hits` from
 * the page to the whole fused candidate pool (24 at k=10) would silently change
 * the denominator of every number in this pass while the before/after tables
 * still looked directly comparable: pollution would jump because the pool's tail
 * is exactly where the irrelevant candidates live, and it would read as a
 * quality regression rather than as a different measurement.
 *
 * That is why pool-wide labels land in `o.poolHits` and NOTHING here reads them.
 * Every figure already recorded in D-083 was computed over the page; keep it
 * that way. If you ever want a pool-wide aggregate, add a NEW named field
 * (`poolPollutionRate`, …) so the two can never be mistaken for one another —
 * never widen these.
 */
function rollUp(tool: string, outcomes: readonly QueryOutcome[]): ToolAggregate {
  const counted = outcomes.filter((o) => o.excludedReason === null);
  const grades = counted.flatMap((o) => o.hits.map((h) => h.grade));
  return {
    tool,
    n: counted.length,
    excluded: outcomes.length - counted.length,
    meanNdcgAtK: meanOf(counted.map((o) => o.ndcgAtK ?? 0)),
    meanPrecisionAtK: meanOf(counted.map((o) => o.precisionAtK ?? 0)),
    meanAccessoryAtK: meanOf(counted.map((o) => o.accessoryAtK ?? 0)),
    pollutionRate: grades.length === 0 ? 0 : grades.filter((g) => g === 0).length / grades.length,
    // ≤1 distinct grade ⇒ every permutation scores the same ⇒ nDCG said nothing
    // about ordering. Counted, not filtered out: the query WAS measured, and its
    // precision/pollution readings remain informative even though its nDCG is not.
    ndcgUninformative: counted.filter((o) => new Set(o.hits.map((h) => h.grade)).size <= 1).length,
  };
}

/** Roll up per stratum. Strata are reported separately, never silently pooled. */
export function aggregateByTool(outcomes: readonly QueryOutcome[]): ToolAggregate[] {
  const tools = [...new Set(outcomes.map((o) => o.tool))].sort();
  return tools.map((t) => rollUp(t, outcomes.filter((o) => o.tool === t)));
}

// =============================================================================
// The run
// =============================================================================

export interface RunLabelledPassOptions {
  queries: readonly { tool: string; query: string; terms: number }[];
  retrieve: (query: string) => Promise<RetrievalResult>;
  /** Judge ONE (query, document) pair. Inject `judgeRelevance` bound to an llm. */
  judge: (input: { pairId: string; query: string; docId: string; docText: string }) => Promise<JudgeVerdict>;
  k?: number;
  sampleSeed: string;
  judgeModel?: string;
  /**
   * How many of ONE query's k hits to judge at a time. Default 4.
   *
   * Bounded WITHIN a query, never across queries: the per-query row is the unit
   * that gets persisted, so parallelising across queries would trade the
   * partial-run guarantee below for the same speedup. At k=10 and ~4s a call,
   * 150 queries is ~100 minutes serial and ~25 at 4-way.
   */
  judgeConcurrency?: number;
  log?: (msg: string) => void;
  /** Called after each query so a long run can persist incrementally. */
  onQueryDone?: (outcome: QueryOutcome, index: number) => void;
}

/**
 * Map `fn` over `items` with at most `limit` in flight, preserving INPUT ORDER
 * in the result.
 *
 * Order matters here and would be silently lost by the obvious
 * `Promise.all(chunk)`-per-batch shape drifting: these are RANKED hits, and
 * every metric downstream reads the array positionally. A shuffled result would
 * still produce a plausible nDCG — of a ranking the engine never returned.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Run the labelled pass.
 *
 * Sequential on purpose: the judge is a paid, rate-limited call, and a partial
 * run whose per-query rows were already handed to `onQueryDone` is worth far
 * more than a faster one that dies holding everything in memory. The pilot lost
 * exactly this — a run that printed aggregates only could not answer the one
 * question that decided the verdict without paying for the whole run again.
 */
export async function runLabelledPass(opts: RunLabelledPassOptions): Promise<LabelledPassReport> {
  const k = opts.k ?? DEFAULT_K;
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const outcomes: QueryOutcome[] = [];
  let judgeCostUsd = 0;
  let judgedHits = 0;

  for (const [i, q] of opts.queries.entries()) {
    const retrieval = await opts.retrieve(q.query);

    // A degraded engine is neither a pass nor a fail: it measured a different
    // system. Judge nothing for it — that would also be paying for a label of a
    // ranking we have already decided not to score.
    if (retrieval.degraded) {
      const outcome: QueryOutcome = {
        tool: q.tool,
        query: q.query,
        terms: q.terms,
        hits: [],
        ndcgAtK: null,
        precisionAtK: null,
        accessoryAtK: null,
        coverage: 'empty-ranking',
        degraded: true,
        rerankApplied: retrieval.rerankApplied,
        judgeCostUsd: 0,
        // Pool mode was ON for this query — say so with an empty list rather
        // than by omitting the field, so a consumer scanning the rows can tell
        // "pooled, nothing to judge" from "this run never pooled at all".
        ...(retrieval.poolHits ? { poolHits: [] } : {}),
        ...(retrieval.latencyMs !== undefined ? { latencyMs: retrieval.latencyMs } : {}),
        excludedReason: `engine DEGRADED (${retrieval.degradeWarning ?? 'a ranker leg did not run'})`,
      };
      outcomes.push(outcome);
      opts.onQueryDone?.(outcome, i);
      log(`[${i + 1}/${opts.queries.length}] ${q.tool} SKIPPED (degraded): ${q.query.slice(0, 60)}`);
      continue;
    }

    // POOL MODE: judge every candidate in the fused pool, then take the top-k
    // PREFIX as the page. Judged once, not twice — `hits` and `poolHits` share
    // the same LabelledHit objects, so the page costs nothing extra and can
    // never carry a different label from its own pool row.
    const page = retrieval.hits.slice(0, k);
    const pool = retrieval.poolHits;
    if (pool) {
      // Checked BEFORE any judge call, because it is free here and $3.5/arm
      // later. A broken prefix means widening the rerank slice perturbed the
      // top-k, so this run cannot be compared with the top-k runs it exists to
      // extend — and since that is a code defect it would break identically on
      // every query. Abort loudly rather than spend the run to find out.
      if (pool.length < page.length) {
        throw new Error(
          `pool-all invariant: poolHits (${pool.length}) is SHORTER than the page (${page.length}) for ${JSON.stringify(q.query.slice(0, 80))}`,
        );
      }
      const drift = page.findIndex((h, i) => pool[i]?.docId !== h.docId);
      if (drift >= 0) {
        throw new Error(
          `pool-all invariant: hits must be the PREFIX of poolHits, but rank ${drift + 1} differs ` +
            `(page=${page[drift]?.docId} pool=${pool[drift]?.docId}) for ${JSON.stringify(q.query.slice(0, 80))}. ` +
            `Widening the rerank slice perturbed the top-k, so this arm is NOT comparable with a top-k run.`,
        );
      }
    }

    const judged = await mapWithConcurrency(
      pool ?? page,
      opts.judgeConcurrency ?? 4,
      async (hit): Promise<LabelledHit> => {
        const verdict = await opts.judge({
          pairId: `${LABELLED_PASS_VERSION}:${q.tool}:${hit.docId}:${hit.rank}`,
          query: q.query,
          docId: hit.docId,
          docText: hit.docText,
        });
        judgeCostUsd += verdict.judgeCostUsd;
        judgedHits++;
        return {
          ...hit,
          relevance: verdict.relevance,
          grade: judgeScoreToGrade(verdict.relevance),
          judgeCostUsd: verdict.judgeCostUsd,
          ...(verdict.judgeNotes ? { judgeNotes: verdict.judgeNotes } : {}),
        };
      },
    );

    // The page is the prefix (asserted above), so this slice re-uses the very
    // objects `poolHits` holds — never a second judgement of the same pair.
    const labelled = pool ? judged.slice(0, k) : judged;

    const scored = scoreQuery(labelled, k);
    // An EMPTY ranking scores ndcg → 0, indistinguishable from "retrieval
    // worked and everything it found was irrelevant". Those are opposite
    // verdicts, so it is excluded and named rather than averaged in as a zero.
    const excludedReason =
      scored.coverage === 'empty-ranking' ? 'retrieval returned no hits — nothing to score' : null;

    const outcome: QueryOutcome = {
      tool: q.tool,
      query: q.query,
      terms: q.terms,
      hits: labelled,
      ...(pool ? { poolHits: judged } : {}),
      ndcgAtK: excludedReason ? null : scored.ndcgAtK,
      precisionAtK: excludedReason ? null : scored.precisionAtK,
      accessoryAtK: excludedReason ? null : scored.accessoryAtK,
      coverage: scored.coverage,
      degraded: false,
      rerankApplied: retrieval.rerankApplied,
      // Over everything JUDGED, not just the page — in pool mode the page is
      // ~40% of what this query actually cost, and a per-query cost that
      // under-reports by 2.4x makes the run's own spend unauditable from its rows.
      judgeCostUsd: judged.reduce((a, h) => a + h.judgeCostUsd, 0),
      ...(retrieval.latencyMs !== undefined ? { latencyMs: retrieval.latencyMs } : {}),
      excludedReason,
    };
    outcomes.push(outcome);
    opts.onQueryDone?.(outcome, i);
    log(
      `[${i + 1}/${opts.queries.length}] ${q.tool} nDCG@${k}=${(outcome.ndcgAtK ?? 0).toFixed(3)} ` +
        `hits=${labelled.length}${pool ? `/pool=${judged.length}` : ''} ` +
        `$${judgeCostUsd.toFixed(3)} :: ${q.query.slice(0, 60)}`,
    );
  }

  const excludedDegraded = outcomes.filter((o) => o.degraded).length;
  const excludedEmpty = outcomes.filter((o) => !o.degraded && o.excludedReason !== null).length;
  const noRerank = outcomes.filter((o) => !o.degraded && !o.rerankApplied).length;
  const pooled = outcomes.filter((o) => o.poolHits !== undefined);
  const pooledCandidates = pooled.reduce((a, o) => a + (o.poolHits?.length ?? 0), 0);
  const pooledScored = pooled.reduce((a, o) => a + (o.poolHits?.filter((h) => h.rerankScore !== undefined).length ?? 0), 0);
  // Computed BEFORE the caveats: one of them quotes its ndcgUninformative share,
  // so the prose and the reported aggregate cannot disagree.
  const overallRoll = rollUp('ALL', outcomes);

  const caveats = [
    `NOT A FLOOR. D-074 binds: no minNdcgAtK may be set off one run — sample across DAYS.`,
    `Labels are LLM judgements on ${JUDGE_AGREEMENT_RUBRIC_VERSION}, measured self-consistency ` +
      `flip rate 0-12.5% (D-078). Treat a per-query score as noisy; the stratum means are the number.`,
    `Grades are the 0..5 judge score banded to 0..3 (judgeScoreToGrade): the pass bar (${RELEVANCE_PASS_BAR}) ` +
      `and precision@k's threshold are the SAME predicate by construction.`,
    `recall@k is NOT reported: this pass has no externally-known relevant set — it is producing the labels.`,
    `nDCG@k IS NOT A SEARCH-QUALITY SCORE. Its ideal ranking is derived from the SAME k documents ` +
      `that were returned, so it measures ordering WITHIN the returned set and has no recall leg — a ` +
      `query whose returned hits are all graded relevant scores 1.0 no matter how the engine ordered ` +
      `them. ${overallRoll.ndcgUninformative}/${overallRoll.n} scored queries had a uniform grade vector ` +
      `(ndcgUninformative), i.e. nDCG carried no ordering information about them at all. Read ` +
      `precision@k and pollutionRate for whether the results are GOOD; read nDCG only for whether the ` +
      `good ones were ordered first.`,
    `${excludedDegraded} of ${outcomes.length} queries excluded as DEGRADED (a ranker leg did not run); ` +
      `${excludedEmpty} excluded for an empty ranking. Excluded queries are in outcomes[] and count toward NO mean.`,
    noRerank > 0
      ? `⚠ ${noRerank} scored queries ran WITHOUT Stage B reranking (fail-safe passthrough) — that is a ` +
        `different pipeline from the one an interactive caller gets.`
      : `Stage B cross-encoder reranking ran on every scored query.`,
    `Strata are reported separately. D-079: a memory:search / recipes:search run is a SECONDARY stratum ` +
      `and must never be pooled into the headline number.`,
  ];

  if (pooled.length > 0) {
    caveats.push(
      `POOL MODE (--pool-all) was on for ${pooled.length}/${outcomes.length} queries: ${pooledCandidates} whole-pool ` +
        `candidates were labelled into outcomes[].poolHits. EVERY AGGREGATE ABOVE IS STILL TOP-${k} ONLY — it is ` +
        `computed over outcomes[].hits and nothing here reads poolHits, so these numbers remain directly ` +
        `comparable with every prior top-k run (D-083). Do not concatenate hits with poolHits: the first ${k} ` +
        `poolHits entries ARE hits, judged once.`,
      `Floor study (D-084/D-085): ${pooledScored}/${pooledCandidates} pooled candidates carry a rerankScore. ` +
        `A candidate WITHOUT one was never judged by the cross-encoder (a degraded stage, or a --no-rerank arm ` +
        `where it never ran) — that is UNKNOWN, not zero, so a >= x floor must DROP those rows. Counting them ` +
        `as scored zeros reads a dead engine as a garbage corpus and calibrates the floor HIGH.`,
    );
  }

  return {
    version: LABELLED_PASS_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel: opts.judgeModel ?? JUDGE_AGREEMENT_MODEL,
    rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
    passBar: RELEVANCE_PASS_BAR,
    k,
    sampleSeed: opts.sampleSeed,
    outcomes,
    byTool: aggregateByTool(outcomes),
    overall: overallRoll,
    judgeCostUsd,
    judgedHits,
    caveats,
  };
}

// =============================================================================
// Reporting
// =============================================================================

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatLabelledReport(report: LabelledPassReport): string {
  const lines: string[] = [];
  lines.push(
    `=== P-038 labelled relevance pass (${report.version}) ===`,
    `judge=${report.judgeModel} rubric=${report.rubricVersion} bar=${report.passBar} ` +
      `k=${report.k} seed=${report.sampleSeed}`,
    `queries=${report.outcomes.length} judged hits=${report.judgedHits} cost=$${report.judgeCostUsd.toFixed(2)}`,
    ``,
    // `uninf` sits immediately right of nDCG@k on purpose: it is the share of that
    // very column computed over uniform grade vectors, where nDCG cannot fall.
    `stratum                n  excl   nDCG@k   uninf     P@k   acc@k  pollution`,
  );
  for (const a of [...report.byTool, report.overall]) {
    lines.push(
      `${a.tool.padEnd(20)}${String(a.n).padStart(4)}${String(a.excluded).padStart(6)}` +
        `${a.meanNdcgAtK.toFixed(3).padStart(9)}${`${a.ndcgUninformative}/${a.n}`.padStart(8)}` +
        `${a.meanPrecisionAtK.toFixed(3).padStart(8)}` +
        `${a.meanAccessoryAtK.toFixed(3).padStart(8)}${pct(a.pollutionRate).padStart(11)}`,
    );
  }
  lines.push(``, `caveats (these travel WITH the numbers):`);
  for (const c of report.caveats) lines.push(`  - ${c}`);
  return lines.join('\n');
}
