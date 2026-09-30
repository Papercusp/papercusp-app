/**
 * jev-admission.ts — the inferential core of the Jev admission bench
 * (plan jev-decision-model-integration-2026-09-29, P-004; adoption bar D-007).
 *
 * The question the bench answers: the memory PUSH path admits by a cosine floor
 * (0.58, cosine-gated, lexical bar 0.40), and that floor still lets something
 * through for roughly a quarter of the hard-negative queries, because the two
 * classes overlap in embedding space. Does a typed yes/no judge (TypeSafe Jev)
 * over the floor-surviving candidates reject more of those WITHOUT costing the
 * recall the floor keeps?
 *
 * Split from the CLI for the reason `rerank-decision.ts` and
 * `paired-leg-report.ts` were: the CLI half talks to Postgres, the embedder and
 * two vendors, so none of it is unit-testable, and THESE functions are where the
 * run's conclusions are formed. A wrong statistic still looks like a statistic.
 *
 * Arms (all replayed over ONE seeded store, same frozen gold set, same run):
 *   A — the production floor alone. The BASELINE, re-measured in this run
 *       (D-007: the 2026-08-02 numbers in injection.ts are not reused).
 *   B — A's candidates, filtered by Jev P(yes) ≥ t.
 *   C — a LOWER floor (0.52) filtered by Jev: can the judge buy back the recall
 *       the 0.58 floor costs?
 *   D — A's candidates, filtered by a ZeroEntropy rerank score ≥ t: the control
 *       that needs no new vendor (D-093 left the reranker unadopted).
 *
 * Every filter is an ADMISSION filter: it drops candidates and never reorders,
 * so any change in the metrics is attributable to what was dropped.
 *
 * FAIL OPEN (D-002): a query whose filter produced no verdict (Jev inconclusive,
 * a rerank degrade) keeps arm A's admission unchanged — exactly what production
 * would do — and is COUNTED, so an arm that silently lost its judge reads as
 * `void`, never as a clean null (the WI-37670 lesson).
 */
import { createHash } from 'node:crypto';

import { mcnemarExact, pairedBootstrapCI, type McNemarResult, type PairedComparison } from '@papercusp/bench-metrics';
import type { DecisionOutcome, QuestionMap } from '@papercusp/decision-model';

import { admissionPYes, RELEVANCE_CRITERIA, RELEVANCE_INSTRUCTIONS, type AdmissionEncoding } from '../jev-admission-request';
import {
  aggregateByClass,
  latencyStats,
  recallAtKBySet,
  reciprocalRank,
  type CandidateHit,
  type LatencyStats,
  type QueryOutcome,
} from '@papercusp/memory/bench';

// ─── Pre-registered parameters (D-007) ─────────────────────────────────────

/** The P(yes) / rerank-score thresholds swept per filter arm (plan P-004: 0.3..0.8). */
export const ADMISSION_THRESHOLDS: readonly number[] = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

/** Arm C's lowered cosine floor (plan P-004). */
export const ARM_C_FLOOR = 0.52;

/** One-sided exact McNemar alpha for the hard-negative improvement (D-007 (1)). */
export const IMPROVEMENT_ALPHA = 0.05;
/** Paired-bootstrap 95% CI lower bound on ΔR@10 must be ≥ this (D-007 (2)). */
export const R10_NON_INFERIORITY_MARGIN = -0.02;
/** Paired-bootstrap 95% CI lower bound on Δ exact-id MRR must be ≥ this (D-007 (2)). */
export const EXACT_ID_MRR_NON_INFERIORITY_MARGIN = -0.02;
/** Added p95 latency budget for the filter call (D-007 (4)). */
export const ADDED_P95_BUDGET_MS = 400;
/** Timeout-rate budget over live calls (D-007 (4)). */
export const TIMEOUT_RATE_BUDGET = 0.02;

/**
 * Vendor LIST price for Jev input tokens (plan §"What Jev is"; output tokens are
 * free). A vendor number, reported as such — TypeSafe returns no price per call.
 */
export const JEV_LIST_USD_PER_MILLION_INPUT = 0.042;

/** D-007 criteria this bench cannot measure; P-005 owns them. */
export const PENDING_P005 = [
  'adversarial self-promoting memory admit rate (D-007 (3))',
  'candidate-order flip rate (D-007 (4))',
] as const;

// ─── The Jev request ───────────────────────────────────────────────────────

// The admission question itself lives in ../jev-admission-request so production
// (jev-memory-gate.ts) asks exactly what this bench measured. Re-exported here
// because the bench CLIs and tests import the whole evaluation surface from one module.
export {
  admissionQuestionId,
  alternateEncoding,
  buildAdmissionRequest,
  parseAdmissionEncoding,
  type AdmissionEncoding,
  type AdmissionRequest,
} from '../jev-admission-request';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The cache rubric version. It embeds a hash of the question template, so a
 * reworded question can never be served a grade the old wording produced, and
 * the floor, because a grade is given in the context of its co-candidates.
 */
export function admissionRubricVersion(encoding: AdmissionEncoding, floor: number): string {
  const template = sha256(JSON.stringify({ RELEVANCE_INSTRUCTIONS, RELEVANCE_CRITERIA, encoding })).slice(0, 8);
  return `jev-memory-admission-v1:${encoding}:${template}:floor=${floor.toFixed(2)}`;
}

// ─── Per-query scores from a filter ────────────────────────────────────────

/** One filter's verdict on one query's candidates. */
export interface QueryScores {
  /** Index-aligned with the candidates; null when the filter gave no verdict (fail open). */
  readonly scores: readonly number[] | null;
  /** Why `scores` is null — an inconclusive reason or a rerank degrade reason. */
  readonly failure?: string;
  /** Wall-clock ms of a LIVE call; null when served from cache. */
  readonly latencyMs: number | null;
  readonly cached: boolean;
  readonly inputTokens: number | null;
  readonly costUsd: number | null;
}

/** Map a decision outcome onto candidate-aligned P(yes) scores. */
export function scoresFromDecision(outcome: DecisionOutcome<QuestionMap>, questionIds: readonly string[]): QueryScores {
  const p = admissionPYes(outcome, questionIds);
  if (outcome.kind === 'inconclusive' || 'failure' in p) {
    const failure = outcome.kind === 'inconclusive' ? outcome.reason : 'failure' in p ? p.failure : 'malformed-response';
    return { scores: null, failure, latencyMs: outcome.latencyMs, cached: false, inputTokens: null, costUsd: null };
  }
  const inputTokens = outcome.usage.inputTokens;
  return {
    scores: p.scores,
    latencyMs: outcome.latencyMs,
    cached: false,
    inputTokens,
    costUsd: inputTokens === null ? null : (inputTokens * JEV_LIST_USD_PER_MILLION_INPUT) / 1_000_000,
  };
}

// ─── Admission ─────────────────────────────────────────────────────────────

/** Rebuild an outcome as if only `admitted` had come back from search. */
export function withCandidates(outcome: QueryOutcome, admitted: readonly CandidateHit[]): QueryOutcome {
  const rankedKeys: string[] = [];
  const seen = new Set<string>();
  for (const c of admitted) {
    if (c.key === null || seen.has(c.key)) continue;
    seen.add(c.key);
    rankedKeys.push(c.key);
  }
  const top = admitted[0];
  return {
    queryId: outcome.queryId,
    class: outcome.class,
    expected: outcome.expected,
    rankedKeys,
    rawHits: admitted.length,
    ...(typeof top?.score === 'number' ? { topScore: top.score } : {}),
    ...(top ? { topText: top.text } : {}),
    candidates: [...admitted],
    ms: outcome.ms,
  };
}

/**
 * Admit the candidates whose score clears `threshold`, keeping retrieval order.
 * `scores === null` is FAIL OPEN: today's admission is returned unchanged.
 */
export function applyAdmission(outcome: QueryOutcome, scores: readonly number[] | null, threshold: number): QueryOutcome {
  const candidates = outcome.candidates;
  if (!candidates) {
    throw new Error(`applyAdmission: query ${outcome.queryId} was replayed without captureCandidates`);
  }
  if (scores === null) return outcome;
  if (scores.length !== candidates.length) {
    throw new Error(
      `applyAdmission: query ${outcome.queryId} has ${candidates.length} candidates but ${scores.length} scores`,
    );
  }
  return withCandidates(
    outcome,
    candidates.filter((_, i) => scores[i] >= threshold),
  );
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export interface ArmPoint {
  readonly arm: string;
  readonly floor: number;
  /** null for the unfiltered baseline. */
  readonly threshold: number | null;
  readonly hardNegN: number;
  /** Hard-negative queries that admitted ANYTHING (the FP@5 numerator). */
  readonly hardNegAdmitted: number;
  readonly fpAt5: number;
  readonly r10: number;
  readonly mrr: number;
  readonly exactIdMrr: number | null;
  /** Positives that came back with nothing. */
  readonly positivesEmptied: number;
}

export function summarizeArm(arm: string, floor: number, threshold: number | null, outcomes: readonly QueryOutcome[]): ArmPoint {
  const { byClass, overall } = aggregateByClass(outcomes);
  const negatives = outcomes.filter((o) => o.expected.length === 0);
  return {
    arm,
    floor,
    threshold,
    hardNegN: negatives.length,
    hardNegAdmitted: negatives.filter((o) => o.rawHits > 0).length,
    fpAt5: byClass['hard-negative']?.fpAt5 ?? 0,
    r10: overall.r10,
    mrr: overall.mrr,
    exactIdMrr: byClass['exact-identifier']?.mrr ?? null,
    positivesEmptied: outcomes.filter((o) => o.expected.length > 0 && o.rawHits === 0).length,
  };
}

/** P(X ≥ k) for X ~ Binomial(n, 0.5) — the one-sided exact McNemar tail. */
export function binomialUpperTailHalf(k: number, n: number): number {
  if (n <= 0 || k <= 0) return 1;
  if (k > n) return 0;
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    if (i >= k) tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, tail);
}

export interface ArmComparison {
  /** Success = the hard-negative query admitted NOTHING. a = baseline, b = candidate. */
  readonly hardNeg: {
    readonly mcnemar: McNemarResult;
    /** One-sided exact p for "the candidate rejects more" (D-007 (1)). */
    readonly pOneSided: number;
    /** Paired difference in reject rate, with its MDE — what a null could have seen. */
    readonly rejectRate: PairedComparison;
  };
  /** Per-positive recall@10, candidate − baseline. */
  readonly r10: PairedComparison;
  /** Per exact-identifier query reciprocal rank, candidate − baseline; null when the set has none. */
  readonly exactIdMrr: PairedComparison | null;
}

function alignByQuery(baseline: readonly QueryOutcome[], candidate: readonly QueryOutcome[]): Array<[QueryOutcome, QueryOutcome]> {
  const byId = new Map(candidate.map((o) => [o.queryId, o]));
  if (byId.size !== baseline.length || candidate.length !== baseline.length) {
    throw new Error(`compareToBaseline: arms cover different query sets (${baseline.length} vs ${candidate.length})`);
  }
  return baseline.map((a) => {
    const b = byId.get(a.queryId);
    if (!b) throw new Error(`compareToBaseline: query ${a.queryId} missing from the candidate arm`);
    return [a, b];
  });
}

export function compareToBaseline(
  baseline: readonly QueryOutcome[],
  candidate: readonly QueryOutcome[],
  opts: { seed?: number; iterations?: number } = {},
): ArmComparison {
  const pairs = alignByQuery(baseline, candidate);
  const boot = { seed: opts.seed ?? 12345, iterations: opts.iterations ?? 10_000 };

  const negatives = pairs.filter(([a]) => a.expected.length === 0);
  const rejectA = negatives.map(([a]) => a.rawHits === 0);
  const rejectB = negatives.map(([, b]) => b.rawHits === 0);
  const mcnemar = mcnemarExact(rejectA, rejectB);

  const positives = pairs.filter(([a]) => a.expected.length > 0);
  const r10A = positives.map(([a]) => recallAtKBySet(a.expected, a.rankedKeys, 10) ?? 0);
  const r10B = positives.map(([, b]) => recallAtKBySet(b.expected, b.rankedKeys, 10) ?? 0);

  const exact = pairs.filter(([a]) => a.class === 'exact-identifier' && a.expected.length > 0);

  return {
    hardNeg: {
      mcnemar,
      pOneSided: binomialUpperTailHalf(mcnemar.onlyB, mcnemar.onlyA + mcnemar.onlyB),
      rejectRate: pairedBootstrapCI(rejectA.map(Number), rejectB.map(Number), boot),
    },
    r10: pairedBootstrapCI(r10A, r10B, boot),
    exactIdMrr:
      exact.length === 0
        ? null
        : pairedBootstrapCI(
            exact.map(([a]) => reciprocalRank(a.expected, a.rankedKeys)),
            exact.map(([, b]) => reciprocalRank(b.expected, b.rankedKeys)),
            boot,
          ),
  };
}

// ─── Operational ───────────────────────────────────────────────────────────

export interface OperationalStats {
  /** Queries that needed a verdict (≥1 candidate). */
  readonly queries: number;
  readonly live: number;
  readonly cached: number;
  /** Queries that got no verdict and failed open, by reason. */
  readonly failures: Readonly<Record<string, number>>;
  readonly failOpen: number;
  /** Timeouts over LIVE calls; null when nothing was called live. */
  readonly timeoutRate: number | null;
  /** Filter-call latency over LIVE calls; null when nothing was called live. */
  readonly latency: LatencyStats | null;
  /** Mean input tokens per LIVE call that reported usage. */
  readonly inputTokensPerCall: number | null;
  /** Mean USD per judged query (live at list price, cached at the stored cost). */
  readonly usdPerQuery: number | null;
}

export function operationalStats(perQuery: readonly (QueryScores | undefined)[]): OperationalStats {
  const judged = perQuery.filter((q): q is QueryScores => q !== undefined);
  const live = judged.filter((q) => !q.cached);
  const failures: Record<string, number> = {};
  for (const q of judged) {
    if (q.scores === null) failures[q.failure ?? 'unknown'] = (failures[q.failure ?? 'unknown'] ?? 0) + 1;
  }
  const latencies = live.map((q) => q.latencyMs).filter((ms): ms is number => typeof ms === 'number');
  const tokens = live.map((q) => q.inputTokens).filter((t): t is number => typeof t === 'number');
  const costs = judged.map((q) => q.costUsd).filter((c): c is number => typeof c === 'number');
  return {
    queries: judged.length,
    live: live.length,
    cached: judged.length - live.length,
    failures,
    failOpen: judged.filter((q) => q.scores === null).length,
    timeoutRate: live.length === 0 ? null : live.filter((q) => q.failure === 'timeout').length / live.length,
    latency: latencies.length === 0 ? null : latencyStats(latencies),
    inputTokensPerCall: tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0) / tokens.length,
    usdPerQuery: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) / judged.length,
  };
}

// ─── The verdict (D-007) ───────────────────────────────────────────────────

export type ArmStatus = 'meets-measured-bar' | 'fails' | 'inconclusive' | 'void';

export interface ThresholdResult {
  readonly threshold: number;
  readonly point: ArmPoint;
  readonly comparison: ArmComparison;
  /** Bonferroni-adjusted one-sided p (× thresholds swept) — the threshold is picked on this same gold set. */
  readonly pAdjusted: number;
  readonly r10NonInferior: boolean;
  readonly exactIdNonInferior: boolean;
}

export interface ArmVerdict {
  readonly arm: string;
  readonly label: string;
  readonly floor: number;
  readonly status: ArmStatus;
  readonly selectedThreshold: number | null;
  readonly reasons: readonly string[];
  readonly thresholds: readonly ThresholdResult[];
  readonly operational: OperationalStats;
  readonly pendingP005: readonly string[];
}

export interface FilterArmInput {
  readonly arm: string;
  readonly label: string;
  readonly floor: number;
  /** The replay at this arm's floor, with candidates captured. */
  readonly outcomes: readonly QueryOutcome[];
  /** Index-aligned with `outcomes`; undefined for a query with no candidates (nothing to judge). */
  readonly scores: readonly (QueryScores | undefined)[];
  readonly thresholds?: readonly number[];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}pp`;
}

/**
 * Evaluate one filter arm against the baseline, and apply the PRE-REGISTERED
 * selection rule: among thresholds that are non-inferior on both R@10 and
 * exact-id MRR, take the one that admits the fewest hard negatives (ties → the
 * lower threshold, which keeps more recall). Because that threshold is chosen
 * on the same gold set it is then tested on, its p-value is Bonferroni-adjusted
 * over every threshold swept.
 */
export function evaluateFilterArm(
  baseline: readonly QueryOutcome[],
  input: FilterArmInput,
  opts: { seed?: number; iterations?: number } = {},
): ArmVerdict {
  const thresholds = input.thresholds ?? ADMISSION_THRESHOLDS;
  if (input.scores.length !== input.outcomes.length) {
    throw new Error(`evaluateFilterArm(${input.arm}): scores and outcomes are not index-aligned`);
  }
  const operational = operationalStats(input.scores);
  const results: ThresholdResult[] = thresholds.map((threshold) => {
    const filtered = input.outcomes.map((o, i) => applyAdmission(o, input.scores[i]?.scores ?? null, threshold));
    const comparison = compareToBaseline(baseline, filtered, opts);
    return {
      threshold,
      point: summarizeArm(input.arm, input.floor, threshold, filtered),
      comparison,
      pAdjusted: Math.min(1, comparison.hardNeg.pOneSided * thresholds.length),
      r10NonInferior: comparison.r10.delta.lower >= R10_NON_INFERIORITY_MARGIN,
      exactIdNonInferior:
        comparison.exactIdMrr === null || comparison.exactIdMrr.delta.lower >= EXACT_ID_MRR_NON_INFERIORITY_MARGIN,
    };
  });

  const base = { arm: input.arm, label: input.label, floor: input.floor, thresholds: results, operational, pendingP005: [...PENDING_P005] };

  if (operational.queries === 0) {
    return {
      ...base,
      status: 'void',
      selectedThreshold: null,
      reasons: [
        'no query had a candidate to judge — the replay admitted nothing, so the filter was never exercised ' +
          '(an instrument failure, not a measurement)',
      ],
    };
  }
  if (operational.failOpen === operational.queries) {
    return {
      ...base,
      status: 'void',
      selectedThreshold: null,
      reasons: [
        `every judged query failed open (${JSON.stringify(operational.failures)}) — the filter never ran, so this arm measured nothing`,
      ],
    };
  }

  const fewestAdmits = (rs: readonly ThresholdResult[]): ThresholdResult | undefined =>
    rs.reduce<ThresholdResult | undefined>(
      (best, r) => (best === undefined || r.point.hardNegAdmitted < best.point.hardNegAdmitted ? r : best),
      undefined,
    );
  const eligible = results.filter((r) => r.r10NonInferior && r.exactIdNonInferior);
  const selected = fewestAdmits(eligible) ?? fewestAdmits(results);
  if (!selected) {
    return { ...base, status: 'void', selectedThreshold: null, reasons: ['no thresholds were swept'] };
  }

  const reasons: string[] = [];
  const c = selected.comparison;
  if (eligible.length === 0) reasons.push('no swept threshold was non-inferior on both R@10 and exact-id MRR');

  const regression =
    c.r10.delta.upper < 0 || (c.exactIdMrr !== null && c.exactIdMrr.delta.upper < 0);
  const improvement = selected.pAdjusted < IMPROVEMENT_ALPHA && c.hardNeg.mcnemar.onlyB > c.hardNeg.mcnemar.onlyA;

  const latencyP95 = operational.latency?.p95 ?? null;
  const operationalFailures: string[] = [];
  if (latencyP95 !== null && latencyP95 > ADDED_P95_BUDGET_MS) {
    operationalFailures.push(`added p95 latency ${latencyP95.toFixed(0)} ms > ${ADDED_P95_BUDGET_MS} ms`);
  }
  if (operational.timeoutRate !== null && operational.timeoutRate > TIMEOUT_RATE_BUDGET) {
    operationalFailures.push(
      `timeout rate ${(operational.timeoutRate * 100).toFixed(1)}% > ${(TIMEOUT_RATE_BUDGET * 100).toFixed(0)}%`,
    );
  }

  const nullNote =
    `hard-negative reject rate Δ ${pct(c.hardNeg.rejectRate.delta.point)} ` +
    `[${pct(c.hardNeg.rejectRate.delta.lower)}, ${pct(c.hardNeg.rejectRate.delta.upper)}], ` +
    `this design could detect ±${pct(c.hardNeg.rejectRate.mde80)} (MDE80, n=${c.hardNeg.rejectRate.n})`;

  let status: ArmStatus;
  if (operationalFailures.length > 0) {
    status = 'fails';
    reasons.push(...operationalFailures);
  } else if (regression) {
    status = 'fails';
    reasons.push(
      `regression detected at t=${selected.threshold}: ΔR@10 ${pct(c.r10.delta.point)} ` +
        `[${pct(c.r10.delta.lower)}, ${pct(c.r10.delta.upper)}]` +
        (c.exactIdMrr ? `, Δexact-id MRR ${c.exactIdMrr.delta.point.toFixed(3)} [${c.exactIdMrr.delta.lower.toFixed(3)}, ${c.exactIdMrr.delta.upper.toFixed(3)}]` : ''),
    );
  } else if (!(selected.r10NonInferior && selected.exactIdNonInferior)) {
    status = 'inconclusive';
    reasons.push(
      `non-inferiority not established at t=${selected.threshold} (CI lower bounds below the margins), ` +
        `but no regression is detectable either; ${nullNote}`,
    );
  } else if (latencyP95 === null) {
    status = 'inconclusive';
    reasons.push('filter-call latency not measured (every grade was served from cache) — re-run with --fresh');
  } else if (improvement) {
    status = 'meets-measured-bar';
    reasons.push(
      `t=${selected.threshold}: hard-negative admits ${selected.point.hardNegAdmitted}/${selected.point.hardNegN}, ` +
        `McNemar onlyA=${c.hardNeg.mcnemar.onlyA} onlyB=${c.hardNeg.mcnemar.onlyB}, ` +
        `one-sided p=${c.hardNeg.pOneSided.toPrecision(3)} (Bonferroni×${thresholds.length} ${selected.pAdjusted.toPrecision(3)})`,
    );
  } else {
    status = 'inconclusive';
    reasons.push(
      `no significant hard-negative improvement at t=${selected.threshold} ` +
        `(one-sided p=${c.hardNeg.pOneSided.toPrecision(3)}, Bonferroni-adjusted ${selected.pAdjusted.toPrecision(3)}); ${nullNote}`,
    );
  }
  if (operational.failOpen > 0) {
    reasons.push(`${operational.failOpen}/${operational.queries} judged queries failed open (${JSON.stringify(operational.failures)})`);
  }
  return { ...base, status, selectedThreshold: selected.threshold, reasons };
}

// ─── Grade cache (harness_shared.search_judge_grades) ──────────────────────

export interface GradeCacheSql {
  unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
}

export interface GradeCacheScope {
  readonly workspaceId: string;
  /** e.g. `typesafe/jev-1.13.0` or `zeroentropy/zerank-2`. */
  readonly judgeModel: string;
  readonly rubricVersion: string;
}

/** The cache's doc id: the corpus key (stable across re-seeds), else the ephemeral backend id. */
export function gradeDocId(c: Pick<CandidateHit, 'id' | 'key'>): string {
  return c.key ?? `id:${c.id}`;
}

interface CachedGradeRow {
  doc_id: string;
  doc_text_hash: string;
  relevance: number | string;
  judge_cost_usd: number | string;
}

const num = (v: number | string): number => (typeof v === 'number' ? v : Number.parseFloat(v));

/**
 * All-or-nothing read: the grades were given in the context of their
 * co-candidates, so a partially cached query is re-judged whole rather than
 * stitched from two different requests. Returns null on any miss.
 */
export async function readCachedScores(
  sql: GradeCacheSql,
  scope: GradeCacheScope,
  query: string,
  candidates: readonly CandidateHit[],
): Promise<QueryScores | null> {
  const rows = await sql.unsafe<CachedGradeRow>(
    `SELECT doc_id, doc_text_hash, relevance, judge_cost_usd
       FROM harness_shared.search_judge_grades
      WHERE workspace_id = $1 AND judge_model = $2 AND rubric_version = $3
        AND query_hash = $4 AND doc_id = ANY($5::text[])`,
    [scope.workspaceId, scope.judgeModel, scope.rubricVersion, sha256(query), candidates.map(gradeDocId)],
  );
  const byKey = new Map(rows.map((r) => [`${r.doc_id}\u0000${r.doc_text_hash}`, r]));
  const scores: number[] = [];
  let cost = 0;
  for (const c of candidates) {
    const row = byKey.get(`${gradeDocId(c)}\u0000${sha256(c.text)}`);
    if (!row) return null;
    scores.push(num(row.relevance));
    cost += num(row.judge_cost_usd);
  }
  return { scores, latencyMs: null, cached: true, inputTokens: null, costUsd: cost };
}

/** Persist a query's live grades. The call's cost is split evenly across its candidates. */
export async function writeCachedScores(
  sql: GradeCacheSql,
  scope: GradeCacheScope,
  query: string,
  candidates: readonly CandidateHit[],
  result: QueryScores,
  meta: { pairId: string; runId: string },
): Promise<number> {
  if (result.scores === null || result.cached) return 0;
  const share = (result.costUsd ?? 0) / candidates.length;
  const queryHash = sha256(query);
  let written = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const score = result.scores[i];
    await sql.unsafe(
      `INSERT INTO harness_shared.search_judge_grades
         (workspace_id, judge_model, rubric_version, query_hash, doc_id, doc_text_hash,
          relevance, judged_relevant, judge_notes, judge_cost_usd, query_text, pair_id, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING`,
      [
        scope.workspaceId,
        scope.judgeModel,
        scope.rubricVersion,
        queryHash,
        gradeDocId(c),
        sha256(c.text),
        score,
        score >= 0.5,
        share,
        query,
        meta.pairId,
        meta.runId,
      ],
    );
    written += 1;
  }
  return written;
}

// ─── Report ────────────────────────────────────────────────────────────────

export interface AdmissionReport {
  readonly generatedAt: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly baseline: ArmPoint;
  readonly arms: readonly ArmVerdict[];
}

function fmtCi(c: PairedComparison, asPp: boolean): string {
  const f = (x: number) => (asPp ? pct(x) : x.toFixed(3));
  return `${f(c.delta.point)} [${f(c.delta.lower)}, ${f(c.delta.upper)}]`;
}

export function renderAdmissionMarkdown(report: AdmissionReport): string {
  const L: string[] = [];
  const b = report.baseline;
  L.push(`# Jev admission bench — ${report.generatedAt}`);
  L.push('');
  L.push('Plan `jev-decision-model-integration-2026-09-29` P-004; adoption bar D-007 (relative to arm A, measured in this run).');
  L.push('');
  L.push('## Parameters');
  L.push('');
  for (const [k, v] of Object.entries(report.params)) L.push(`- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  L.push('');
  L.push('## Arm A — baseline (production floor, no filter)');
  L.push('');
  L.push('| floor | hard-neg admitted | FP@5 | R@10 | MRR | exact-id MRR | positives emptied |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  L.push(
    `| ${b.floor.toFixed(2)} | ${b.hardNegAdmitted}/${b.hardNegN} | ${(b.fpAt5 * 100).toFixed(0)}% | ${(b.r10 * 100).toFixed(1)}% | ` +
      `${b.mrr.toFixed(3)} | ${b.exactIdMrr?.toFixed(3) ?? '—'} | ${b.positivesEmptied} |`,
  );
  L.push('');
  for (const arm of report.arms) {
    L.push(`## Arm ${arm.arm} — ${arm.label}`);
    L.push('');
    L.push(`**Verdict: ${arm.status.toUpperCase()}**${arm.selectedThreshold !== null ? ` (selected t=${arm.selectedThreshold})` : ''}`);
    L.push('');
    for (const r of arm.reasons) L.push(`- ${r}`);
    L.push(`- pending P-005: ${arm.pendingP005.join('; ')}`);
    L.push('');
    L.push('| t | hard-neg admitted | McNemar onlyA/onlyB | p (1-sided) | p (Bonf.) | ΔR@10 [95% CI] | Δexact-id MRR [95% CI] | R@10 | exact-id MRR | emptied | non-inf. |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of arm.thresholds) {
      const c = r.comparison;
      const mark = r.threshold === arm.selectedThreshold ? ' ⭐' : '';
      L.push(
        `| ${r.threshold.toFixed(2)}${mark} | ${r.point.hardNegAdmitted}/${r.point.hardNegN} | ` +
          `${c.hardNeg.mcnemar.onlyA}/${c.hardNeg.mcnemar.onlyB} | ${c.hardNeg.pOneSided.toPrecision(3)} | ${r.pAdjusted.toPrecision(3)} | ` +
          `${fmtCi(c.r10, true)} | ${c.exactIdMrr ? fmtCi(c.exactIdMrr, false) : '—'} | ` +
          `${(r.point.r10 * 100).toFixed(1)}% | ${r.point.exactIdMrr?.toFixed(3) ?? '—'} | ${r.point.positivesEmptied} | ` +
          `${r.r10NonInferior && r.exactIdNonInferior ? 'yes' : 'no'} |`,
      );
    }
    const o = arm.operational;
    L.push('');
    L.push(
      `Operational: ${o.queries} judged queries (${o.live} live, ${o.cached} cached); fail-open ${o.failOpen} ${JSON.stringify(o.failures)}; ` +
        `timeout rate ${o.timeoutRate === null ? 'n/a' : `${(o.timeoutRate * 100).toFixed(1)}%`}; ` +
        `latency ${o.latency ? `p50 ${o.latency.p50.toFixed(0)} ms, p95 ${o.latency.p95.toFixed(0)} ms, max ${o.latency.max.toFixed(0)} ms` : 'n/a'}; ` +
        `input tokens/call ${o.inputTokensPerCall?.toFixed(0) ?? 'n/a'}; USD/query ${o.usdPerQuery?.toExponential(2) ?? 'n/a'}.`,
    );
    L.push('');
  }
  L.push('## How to read this');
  L.push('');
  L.push(
    '- Every filter DROPS candidates and never reorders, so a metric change is attributable to what was dropped.',
  );
  L.push(
    '- The selected threshold is chosen on this same gold set (fewest hard-negative admits among non-inferior thresholds), ' +
      'so its p-value is Bonferroni-adjusted over every threshold swept. Treat it as a candidate for P-005 to confirm, not a tuned constant.',
  );
  L.push(
    '- A null carries its MDE80: the smallest change in hard-negative reject rate this sample would detect 80% of the time. ' +
      '"No improvement detected" means "none larger than that", never "no effect".',
  );
  L.push('- A query whose filter gave no verdict fails open to arm A, as production would. An arm where every query failed open is VOID.');
  return L.join('\n');
}
