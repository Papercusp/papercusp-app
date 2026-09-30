/**
 * semantic-coverage — the embed-coverage leg for `docs:search` (EI-20031763618968912).
 *
 * WHY THIS EXISTS. `docs:search` is a hybrid whose semantic leg reads
 * `harness_shared.doc_sections`. That corpus is filled in two stages (a sync sweep that
 * DELETE+INSERTs changed sections with `embedding NULL`, then a separate embed backfill),
 * so a section can be present-but-unembedded — lexically findable and semantically
 * invisible. In the hits themselves, a semantic leg that matched nothing because the
 * corpus is under-embedded is INDISTINGUISHABLE from one that matched nothing because no
 * such page exists. `search.ts` already reasons about exactly that distinction
 * (`semanticFoundNothing` is "evidence about the CORPUS"); this module supplies the
 * evidence it was reasoning about.
 *
 * WHY THIS DOOR. WI-9393 / D-018 built the coverage gate and wired every other cosine
 * consumer to it; `docs:search` was the one left blind. `doc_sections` is NOT reachable
 * from `SEARCH_SOURCE_SURFACES` by source name, and that map is asserted exhaustive in
 * both directions against `SEARCH_SOURCES` (coverage-gate.test.ts) — so adding a key
 * there would fail the suite. Per `assessSurfaceCoverage`'s own contract, a consumer
 * whose surfaces are not reachable by source name passes its own surfaces here instead
 * and inherits the identical verdict logic, including the binding D-018 constraint that
 * absence of evidence renders `unknown` and NEVER `healthy`.
 *
 * WHY IT STAYS QUIET. Two guards keep this from forking one honesty signal into two —
 * the exact duplication `assessSurfaceCoverage`'s docstring records having already been
 * made once (memory recall was briefly wired through both doors):
 *
 *  1. A semantic leg that did not RUN is already `legs.degraded` + `legs.warning`'s
 *     story. A dead embedder says nothing about which corpus holds the answer, so
 *     annotating it with corpus coverage would be noise on top of a better signal.
 *  2. A `healthy` verdict is the overwhelmingly common case (doc_sections measured
 *     99.72% on 2026-09-05), and a field that is almost always present and almost
 *     always reassuring is prompt weight every caller pays for nothing.
 *
 * So this reports ONLY the genuinely distinct failure: the semantic leg ran fine and the
 * corpus underneath it is incomplete or unmeasured.
 */

import type { CoverageSnapshot, SourceCoverageAssessment } from '../../search/coverage-gate';

/** The single surface backing `docs:search`'s semantic leg. */
export const DOC_SECTIONS_SURFACE = 'harness_shared.doc_sections.embedding';

/** The label this consumer is reported under in the gate's notes. */
export const DOCS_COVERAGE_LABEL = 'docs:search';

/**
 * What rides on the response. Deliberately three fields: the verdict a caller branches
 * on, the number it derives from, and the gate's own one-line actionable note (reused,
 * not re-worded — the gate owns that wording for every consumer).
 */
export interface DocsCoverageNote {
  /** Never `healthy`/`not-semantic` — those are filtered out before this is built. */
  verdict: 'degraded' | 'unknown';
  /** Best known leg, 0..1. `null` when there is no fresh sample at all. */
  coverage: number | null;
  /** The gate's actionable line. */
  note: string;
}

/**
 * Decide whether the corpus's coverage is worth telling this caller about.
 *
 * Pure and synchronous on purpose: the interesting logic here is the two suppression
 * rules, and they are worth testing without a Postgres handle in the way.
 *
 * @param assessment the gate's verdict, or `null` when it could not be obtained.
 * @param semanticLeg the response's own semantic leg report (`legs.semantic`).
 */
export function docsCoverageNote(
  assessment: SourceCoverageAssessment | null | undefined,
  semanticLeg: { status?: string } | undefined,
): DocsCoverageNote | undefined {
  // Guard 1: the leg has to have actually run. `status` is 'ran' | 'errored' | 'not-run';
  // anything but 'ran' is already reported, better, by `legs`.
  if (semanticLeg?.status !== 'ran') return undefined;
  if (!assessment) return undefined;

  // Guard 2: only the two verdicts that mean "your hits may be missing pages".
  // `not-semantic` cannot occur for a surface we pass explicitly, and `healthy` is the
  // silent common path.
  if (assessment.verdict !== 'degraded' && assessment.verdict !== 'unknown') return undefined;

  return {
    verdict: assessment.verdict,
    coverage: assessment.coverage,
    note: assessment.note,
  };
}

/** Injectable seam so tests never reach for a live org-PG handle. */
export interface DocsCoverageDeps {
  loadSnapshot: () => Promise<CoverageSnapshot>;
  assess: (
    source: string,
    surfaces: readonly string[],
    snapshot: CoverageSnapshot,
  ) => SourceCoverageAssessment;
}

/**
 * Load the coverage snapshot and assess `doc_sections`.
 *
 * FAIL-SOFT BY CONSTRUCTION: every failure path returns `null`, which
 * {@link docsCoverageNote} turns into "say nothing". A coverage probe must never be able
 * to fail a search — the whole point is to make a weak result legible, and a thrown
 * error would instead make a working result disappear.
 */
export async function assessDocsCoverage(
  deps?: DocsCoverageDeps,
): Promise<SourceCoverageAssessment | null> {
  try {
    // Inert under vitest unless a test injects the seam — unrelated tool tests must not
    // pay for a live org-PG read (same reasoning as plans/semantic-dedup.ts).
    if (!deps && process.env.VITEST) return null;

    const resolved =
      deps ??
      (await (async (): Promise<DocsCoverageDeps> => {
        const [{ loadCoverageSnapshotCached, assessSurfaceCoverage }, { getOrgPg }, { activeWorkspaceId }] =
          await Promise.all([
            import('../../search/coverage-gate'),
            import('@papercusp/db-org'),
            import('../../workspace-registry'),
          ]);
        return {
          loadSnapshot: () => loadCoverageSnapshotCached(getOrgPg().sql, activeWorkspaceId()),
          assess: assessSurfaceCoverage,
        };
      })());

    const snapshot = await resolved.loadSnapshot();
    return resolved.assess(DOCS_COVERAGE_LABEL, [DOC_SECTIONS_SURFACE], snapshot);
  } catch {
    return null;
  }
}
