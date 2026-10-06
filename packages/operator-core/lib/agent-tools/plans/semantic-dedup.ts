/**
 * semantic-dedup — plans:new's `similar_exists` CONFIRMATION check
 * (P-010 shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * The token matcher scores slug+title token overlap only, so topically-adjacent
 * but distinct efforts false-positive (it flagged this very plan's creation). A
 * token-flagged candidate whose stored vector is semantically DISTANT from the
 * proposed plan is dropped from the refusal; a candidate with NO stored vector
 * (or no verdict at all) is KEPT — both failure directions preserve today's
 * token-verdict behavior.
 *
 * ─── THIS IS A THRESHOLD CLASSIFIER, NOT A SEARCH (D-025) ──────────────────
 * It used to sit beside `semanticPlanHits`, plans:search's semantic leg. That
 * leg has MOVED to ./semantic-leg.ts and now runs inside `runHybridSearch`;
 * this one deliberately did NOT move, and P-016 does not cover it:
 *
 *   - a SEARCH ranks a whole corpus and hands a list to fusion, in the
 *     query→doc pairing, where the P-017 floor applies;
 *   - THIS scores a FIXED candidate list and partitions it at a threshold, in
 *     the doc↔doc pairing.
 *
 * `runHybridSearch` cannot express that shape, and gemma is a dual-encoder — so
 * this file's cut and the 0.45 search floor live in different pairings and
 * neither licenses the other. The split keeps that structural rather than a
 * comment someone has to notice.
 *
 * ─── WHY THE CUT IS CORPUS-RELATIVE, NOT AN ABSOLUTE COSINE (WI-2145556) ────
 * It used to be an absolute constant, `DEFAULT_CONFIRM = 0.6`, calibrated live
 * on 2026-07-10 against unrelated controls that then measured 0.46–0.49. By
 * 2026-09-05 that constant was INERT: measured over the live corpus in this
 * module's own units (`1 - (embedding <=> vec::vector)` over
 * `harness_shared.harness_plans`, same scope and `embedding_mode` filter as
 * `querySimilaritiesReal`), NO plan pair scored below 0.6 —
 *
 *   - current corpus, 120 random plans → 7,140 pairs: min 0.650, p05 0.720,
 *     median 0.776, max 1.000 — 100.0% >= 0.6;
 *   - the ORIGINAL calibration cohort (plans created before 2026-07-10), 100
 *     plans → 4,950 pairs: min 0.651, median 0.791 — 100.0% >= 0.6.
 *
 * The second census is the discriminating one: the very plans the constant was
 * calibrated against can no longer be separated by it. So the `dropped` branch
 * was unreachable, the documented safety valve did not function, and EVERY
 * `similar_exists` refusal required `force:true`.
 *
 * An absolute cosine cut on a dual-encoder is only meaningful against ONE fixed
 * embedding procedure, and it goes silently inert when that procedure changes
 * (pooling / normalization / prefix drift compresses the scale upward). So
 * REPLACING 0.6 with another hand-picked number reproduces the same fragility
 * on a timer. The cut is instead taken from the corpus's OWN distribution: a
 * candidate is kept only when it sits in the top `1 - quantile` tail of the
 * proposed plan's similarity distribution against a background sample of the
 * same corpus. That is scale-free, so it survives re-embedding — exactly the
 * drift that broke the constant.
 *
 * This is the same correction `scout/critique-core.ts` already made for the
 * same reason (EI-19899846879024832: unrelated same-domain text sits ~0.62, not
 * ~0, so a lexical-tuned absolute floor is meaningless against raw cosine).
 * That module rescales-and-blends; this one partitions — but the calibration
 * idea, and the refusal to calibrate off too few samples, are shared.
 *
 * FAIL-OPEN: no embedder, migration 553 absent, dims mismatch (harrier@1024),
 * too small or degenerate a background sample, or any throw degrades to
 * token-only. VITEST-inert unless deps are injected (the real resolver
 * lazy-loads an ONNX model — the WI-3792 load-scar class).
 */

import { withWorkspace } from '@papercusp/db-org';
import type { EmbedderProfileSpec } from '@papercusp/memory';
import {
  calibrateNearDuplicateCut,
  checkNearDuplicates,
  type NearDuplicateCalibration,
} from '@papercusp/search';
import { resolvePlanScope, type PlanSourceOpts } from './source';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import {
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../../search/prose-vector-dims';
// Embedding-coverage awareness (WI-9393). The SURFACE-level door, deliberately not
// `assessSourceCoverage`: this classifier is not a `SearchSource`, and
// SEARCH_SOURCE_SURFACES is asserted exhaustive in both directions against
// SEARCH_SOURCES (coverage-gate.test.ts), so adding a key there would fail the suite.
import {
  assessSurfaceCoverage,
  type CoverageSnapshot,
  type SourceCoverageAssessment,
} from '../../search/coverage-gate';

/** The label this consumer's coverage verdict is reported under. */
const PLAN_DEDUP_COVERAGE_SOURCE = 'plans:semantic-dedup';
/** The one vector surface `querySimilaritiesReal`'s SQL reads. */
const PLAN_DEDUP_SURFACES = ['harness_shared.harness_plans.embedding'] as const;

/**
 * Quantile of the proposed plan's OWN background similarity distribution used
 * as the keep/drop cut. A token-flagged candidate is KEPT only if it scores at
 * or above this quantile — i.e. it is in the top 5% of everything this corpus
 * looks like to the proposed plan.
 *
 * VALIDATED on the real refusal that exposed WI-2145556 (measured 2026-09-05
 * against the live vectors, background n=256 sampled as below): for
 * `sse-per-client-invalidation-filtering-2026-09-04` the background ran
 * min 0.635 / p50 0.742 / p95 0.778 / max 0.837, and its three genuinely-related
 * neighbours — http2-sse-transport-2026-05-20 (0.837),
 * webkit-sse-connection-pool-2026-05-20 (0.835), sse-typed-events-2026-05-12
 * (0.828) — all sit ABOVE the 0.778 cut, so all three stay flagged, which is
 * the correct verdict for that refusal. A merely-same-domain collision at the
 * corpus median would be dropped. Note what this demonstrates and what it does
 * not: it shows the rule SEPARATES where the absolute 0.6 could not (every one
 * of those numbers is above 0.6), not that 0.95 is optimal.
 *
 * 0.95 is deliberately CONSERVATIVE in the safe direction. This classifier's
 * failure mode is over-blocking (a kept candidate makes the token refusal
 * stick, and `force:true` is available); under-blocking would let a genuine
 * duplicate plan through, which is the EI-134 harm the guard exists for. On a
 * ~1,800-plan corpus the top 5% is ~90 plans, so a real duplicate or
 * continuation is comfortably inside it while a merely-same-domain token
 * collision is not. Override via PAPERCUSP_PLAN_DUPE_QUANTILE.
 */
const DEFAULT_BASELINE_QUANTILE = 0.95;

/**
 * Below this many background samples the distribution is too small to estimate
 * a cut from, so we do NOT calibrate and the token refusal stands unchanged. A
 * "baseline" taken from a handful of points is noise, not a population — the
 * same honest refusal `critique-core`'s MIN_SEMANTIC_SAMPLES_TO_CALIBRATE makes.
 */
const MIN_BACKGROUND_SAMPLES = 32;

/**
 * How many background plans to score the proposed vector against. Sampled
 * deterministically (`ORDER BY md5(plan_slug)`) so the same proposal gets the
 * same verdict twice, and topic-independently so the sample is a background,
 * not a neighbourhood.
 */
const BACKGROUND_SAMPLE_LIMIT = 256;

/**
 * A calibrated cut above this is treated as DEGENERATE and refused. It means
 * the background sample is nearly self-identical (a re-embedding collapse, a
 * corpus of near-duplicates), where dropping everything below it would clear
 * genuine duplicates out of the refusal — the unsafe direction. Refusing to
 * calibrate keeps the token verdict, consistent with every other degraded path
 * in this file.
 */
const MAX_CALIBRATED_CUT = 0.98;

function envNumber(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}

/**
 * The explicit ABSOLUTE-cosine escape hatch (PAPERCUSP_PLAN_DUPE_CONFIRM).
 * `null` — the normal case — means "calibrate against the corpus". Kept as an
 * ops override only; it is deliberately NOT the default any more, because an
 * absolute cut is exactly what went inert (see the header).
 */
export function planDupeAbsoluteOverride(): number | null {
  return envNumber(process.env.PAPERCUSP_PLAN_DUPE_CONFIRM);
}

/** The background quantile actually in force (PAPERCUSP_PLAN_DUPE_QUANTILE). */
export function planDupeBaselineQuantile(): number {
  return envNumber(process.env.PAPERCUSP_PLAN_DUPE_QUANTILE) ?? DEFAULT_BASELINE_QUANTILE;
}

/**
 * How the keep/drop cut for one confirmation was arrived at. Reported on the
 * result so an INERT classifier is visible instead of silently keeping
 * everything: `basis` says which rule produced the cut, and `backgroundSamples`
 * says what it was measured over. The rule itself lives in @papercusp/search
 * (shared-vector-search-libraries-2026-09-29 P-004).
 */
export type ConfirmCalibration = NearDuplicateCalibration;

/** The host's calibration options: this module's constants over the library cut. */
const calibrationOptions = (opts: { absoluteOverride?: number | null; quantile?: number }) => ({
  absoluteOverride: opts.absoluteOverride ?? null,
  quantile: opts.quantile ?? DEFAULT_BASELINE_QUANTILE,
  minSamples: MIN_BACKGROUND_SAMPLES,
  maxCut: MAX_CALIBRATED_CUT,
});

/**
 * Resolve the keep/drop cut. PURE — no DB, no embedder — so the calibration
 * rule is testable against a recorded real distribution without live data.
 *
 * `null` means DO NOT CLASSIFY: the background is too small or degenerate to
 * separate anything, and the caller must keep every candidate.
 */
export function resolveConfirmCalibration(
  background: readonly number[],
  opts: { absoluteOverride?: number | null; quantile?: number } = {},
): ConfirmCalibration | null {
  // A near-self-identical background cannot separate anything; the library
  // refuses above MAX_CALIBRATED_CUT, which is the safe direction (the token
  // refusal stands).
  return calibrateNearDuplicateCut(background, calibrationOptions(opts));
}

/** Injectable seams (tests + any future non-553 store). */
export interface PlanConfirmDeps {
  resolveEmbedder: () => Promise<{
    mode: string;
    dims: number;
    profile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>;
    embed: (t: string) => Promise<number[]>;
  } | null>;
  /** slug → similarity for the given slugs that HAVE a vector in `mode`'s space. */
  querySimilarities: (
    vec: number[],
    mode: string,
    slugs: string[],
    opts: PlanSourceOpts,
    selection: ProseProfileSelection,
  ) => Promise<Map<string, number>>;
  /**
   * The proposed vector's similarity against a BACKGROUND sample of the same
   * corpus, excluding the candidates themselves — the distribution the
   * corpus-relative cut is taken from. Omitted (or throwing) means no
   * calibration is possible, so the token refusal stands unchanged.
   */
  queryBackgroundSimilarities?: (
    vec: number[],
    mode: string,
    excludeSlugs: string[],
    limit: number,
    opts: PlanSourceOpts,
    selection: ProseProfileSelection,
  ) => Promise<number[]>;
  /** Test seam for the WI-9393 coverage assessment; injecting it also opts in
   *  under vitest, where the assessment is otherwise inert. */
  loadCoverage?: () => Promise<CoverageSnapshot>;
}

async function querySimilaritiesReal(
  vec: number[],
  mode: string,
  slugs: string[],
  opts: PlanSourceOpts,
  selection: ProseProfileSelection,
): Promise<Map<string, number>> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ plan_slug: string; similarity: number }>>`
      SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ANY(${slugs})
         AND embedding IS NOT NULL
         AND ${proseProfilePredicateSql(tx, selection, 'embedding_profile', 'embedding_mode')}`;
  });
  return new Map(rows.map((r) => [r.plan_slug, Number(r.similarity)]));
}

/**
 * The background distribution the cut is calibrated against: the proposed
 * vector scored over a topic-independent sample of the SAME corpus, in the SAME
 * pairing and scope as `querySimilaritiesReal`, with the token-flagged
 * candidates excluded so the sample is a background rather than the very
 * neighbourhood being judged.
 *
 * The sample is taken by `md5(plan_slug)` inside a subquery: deterministic (the
 * same proposal gets the same verdict twice), independent of topic, insertion
 * order and slug alphabet, and it bounds the cosine work to LIMIT rows instead
 * of the whole corpus.
 */
async function queryBackgroundSimilaritiesReal(
  vec: number[],
  mode: string,
  excludeSlugs: string[],
  limit: number,
  opts: PlanSourceOpts,
  selection: ProseProfileSelection,
): Promise<number[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ similarity: number }>>`
      SELECT 1 - (s.embedding <=> ${vecLit}::vector) AS similarity
        FROM (
          SELECT embedding
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND embedding IS NOT NULL
             AND ${proseProfilePredicateSql(tx, selection, 'embedding_profile', 'embedding_mode')}
             AND NOT (plan_slug = ANY(${excludeSlugs}))
           ORDER BY md5(plan_slug)
           LIMIT ${limit}
        ) s`;
  });
  return rows.map((r) => Number(r.similarity));
}

// CONFIRM pairing: the proposed plan will itself be STORED, so doc↔doc cosine
// (the backfill sweep's document-side resolver) — same choice P-008's
// work-item dupe guard made, and the pairing the cut is calibrated in.
// (plans:search's QUERY-side pairing lives in ./semantic-leg.ts — D-025.)
const confirmDeps: PlanConfirmDeps = {
  resolveEmbedder: async () => {
    const r = await (await import('../../search/embed-backfill')).resolveBackfillEmbedder();
    return r.mode === 'disabled' || !('embed' in r) ? null : r;
  },
  querySimilarities: querySimilaritiesReal,
  queryBackgroundSimilarities: queryBackgroundSimilaritiesReal,
};

export interface ConfirmResult<T> {
  /** false = no cosine verdict was possible — `kept` is `candidates` unchanged. */
  verdict: boolean;
  kept: Array<T & { similarity?: number }>;
  dropped: Array<T & { similarity: number }>;
  /**
   * How the keep/drop cut was arrived at, when one was. Absent exactly when
   * `verdict` is false. Reported so that a classifier which has gone inert —
   * the WI-2145556 failure, where the cut sat below the entire corpus and
   * nothing could ever be dropped — is VISIBLE at the call site instead of
   * looking like an ordinary "everything really is similar" verdict.
   */
  calibration?: ConfirmCalibration;
  /**
   * WI-9393 / D-018: whether `harness_shared.harness_plans.embedding` — the column
   * this classifier's SQL reads — is actually populated.
   *
   * NOTE THE DEGRADATION DIRECTION, which is the OPPOSITE of the dupe-guard's and
   * work-item search's. A candidate with no stored vector is KEPT (see the header),
   * so low coverage here never lets a duplicate plan through; it makes the refusal
   * STICK when cosine could have cleared it. The failure is over-blocking — an agent
   * told "a similar plan exists" for a plan that is genuinely distinct — so the
   * verdict's value is explaining WHY a refusal could not be lifted.
   *
   * Absent when no assessment was attempted; an `unknown` verdict is the distinct
   * statement "we looked and the sampler knows nothing".
   */
  coverage?: SourceCoverageAssessment;
}

/**
 * Cosine-confirm token-flagged similar_exists candidates against the proposed
 * plan. The proposed text mirrors the stored embed shape
 * (title + first 2k of body). Candidates WITHOUT a stored vector in the
 * active space are kept (no per-candidate verdict); any global failure — an
 * uncalibratable background included — keeps ALL candidates (verdict:false).
 * The token refusal never weakens on embedder or corpus health.
 */
export async function confirmSimilarPlans<T extends { slug: string }>(
  proposed: { title: string; body?: string | null },
  candidates: T[],
  opts: PlanSourceOpts = {},
  deps?: PlanConfirmDeps,
): Promise<ConfirmResult<T>> {
  const result = await confirmSimilarPlansCore(proposed, candidates, opts, deps);
  // An empty candidate list asked no question, so there is nothing to explain.
  if (candidates.length === 0) return result;
  // DELIBERATELY outside the classifier and in its own try/catch: coverage is a
  // diagnostic ABOUT the verdict and must never be able to cost us one. Note it is
  // attached to the fail-open `verdict:false` results TOO — those are exactly the
  // cases where the caller most needs to know whether the corpus was the problem.
  try {
    const snapshot = await loadPlanDedupCoverage(deps?.loadCoverage);
    // `null` = do not assess at all (no key); an EMPTY map is the different statement
    // "we looked and know nothing", which the shared logic renders as `unknown`.
    if (snapshot === null) return result;
    return {
      ...result,
      coverage: assessSurfaceCoverage(PLAN_DEDUP_COVERAGE_SOURCE, PLAN_DEDUP_SURFACES, snapshot),
    };
  } catch {
    return result;
  }
}

/** The snapshot for {@link PLAN_DEDUP_SURFACES}. A failed READ yields an EMPTY map,
 *  which `assessSurfaceCoverage` already renders as `unknown` — never as healthy, and
 *  never as a hand-written verdict object that could drift from the shared logic. */
async function loadPlanDedupCoverage(
  seam?: () => Promise<CoverageSnapshot>,
): Promise<CoverageSnapshot | null> {
  if (seam) {
    try {
      return await seam();
    } catch {
      return new Map();
    }
  }
  // Inert under vitest unless a test injects the seam — same reasoning as the ONNX
  // guard below: unrelated tool tests must not pay for a live org-PG read.
  if (process.env.VITEST) return null;
  try {
    const [{ loadCoverageSnapshotCached }, { getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('../../search/coverage-gate'),
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    return await loadCoverageSnapshotCached(getOrgPg().sql, activeWorkspaceId());
  } catch {
    return new Map();
  }
}

async function confirmSimilarPlansCore<T extends { slug: string }>(
  proposed: { title: string; body?: string | null },
  candidates: T[],
  opts: PlanSourceOpts = {},
  deps?: PlanConfirmDeps,
): Promise<ConfirmResult<T>> {
  const noVerdict: ConfirmResult<T> = { verdict: false, kept: candidates, dropped: [] };
  if (candidates.length === 0) return { verdict: false, kept: [], dropped: [] };
  if (process.env.VITEST && !deps) return noVerdict;
  try {
    const d = deps ?? confirmDeps;
    const resolved = await d.resolveEmbedder();
    if (!resolved || !fitsProseColumns(resolved.dims)) return noVerdict;
    const selection = resolved.profile
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    if (!selection) return noVerdict;
    const vec = await resolved.embed(`${proposed.title}\n${(proposed.body ?? '').slice(0, 2000)}`);
    if (!fitsProseColumns(vec.length)) return noVerdict;
    // The cut (library: checkNearDuplicates). An absolute override skips the
    // background read entirely; the normal path calibrates against the corpus
    // and DECLINES TO CLASSIFY when the background is too small or degenerate —
    // the token refusal then stands rather than being partitioned by a number
    // that means nothing.
    const queryBackground = d.queryBackgroundSimilarities;
    const outcome = await checkNearDuplicates({
      candidates,
      keyOf: (c) => c.slug,
      similarities: (slugs) => d.querySimilarities(vec, resolved.mode, [...slugs], opts, selection),
      sampleBackground: queryBackground
        ? (slugs, limit) => queryBackground(vec, resolved.mode, [...slugs], limit, opts, selection)
        : undefined,
      backgroundLimit: BACKGROUND_SAMPLE_LIMIT,
      similarityDecimals: 3,
      ...calibrationOptions({
        absoluteOverride: planDupeAbsoluteOverride(),
        quantile: planDupeBaselineQuantile(),
      }),
    });
    if (!outcome.verdict) return noVerdict;
    return {
      verdict: true,
      kept: outcome.kept as Array<T & { similarity?: number }>,
      dropped: outcome.dropped,
      calibration: outcome.calibration,
    };
  } catch {
    return noVerdict;
  }
}
