/**
 * Injection-scoped retrieval-reach assessment — P-004 of
 * context-injection-retrieval-reach-and-visibility-2026-08-03.
 *
 * THE DEFECT THIS EXISTS FOR. `embed-coverage.ts` already alarms per SURFACE, and
 * `coverage-gate.ts` already reports a per-SOURCE verdict at query time. Neither
 * answers the question injection actually needs answered: *is the pre-turn context
 * block still reaching the corpus semantically?* The global alarm names one of ten
 * surfaces; a reader cannot tell from it whether injection's reach is affected. And
 * injection has no human in the loop to notice — that asymmetry is the whole reason
 * this item exists. A human sees a bad result list and re-queries; an agent gets one
 * silent block, no signal, and proceeds as if the corpus had nothing to say.
 *
 * NOTHING HERE MEASURES ANYTHING. Per P-004's own instruction ("do not rebuild their
 * metric, consume it if they expose one"), this module owns no floors, no windows, no
 * sample guards and no SQL. It consumes two things it is handed:
 *
 *   • `SurfaceCoverage[]` — the per-surface measurement (`measureCoverage`), and
 *   • `CoverageBreach[]` — the verdicts `detectCoverageBreaches` already reached.
 *
 * INHERITING THE VERDICTS RATHER THAN THE THRESHOLDS IS DELIBERATE. A breach of kind
 * K is reported here only when the upstream detector already raised K on the underlying
 * surface. That is what keeps this from drifting: `total-coverage` carries a
 * drain-aware suppression (it withholds while the backlog is genuinely converging) that
 * cannot be recomputed from a single sample. Re-deriving `observed < FLOOR` here would
 * silently drop that suppression and alarm during every healthy drain — the same class
 * of ever-red alarm `embed-coverage.ts`'s own header warns is worse than no alarm at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LOAD-BEARING FACT: injection's semantic reach is NARROW, and it is narrow by
 * enumeration — the corpus leg reads exactly two registered sources
 * (`CORPUS_SOURCE_NAMES` in corpus-recall-io.ts): `session_turn` and `work_item`.
 *
 *   • `session_turn` has BM25 + a gemma@768 cosine leg, itself a P-034 union over
 *     two surfaces (`session_turns.text_embedding` and `session_turn_chunks.embedding`).
 *   • `work_item` has BM25 + a gemma@768 cosine leg over
 *     `harness_shared.work_items.embedding` (~100% covered), read through the
 *     `engineer_issues` view since migration 776.
 *
 * ⚠ THAT SECOND BULLET IS NEW, AND THIS HEADER SAID THE OPPOSITE UNTIL 2026-08-09.
 * D-078 recorded the reach as ONE SOURCE WIDE, because `work_item` exposed no
 * `embedding()` at all and `work_items.embedding` fed only the work-item semantic
 * DUPE GUARD. P-005 wired the leg; the column, its HNSW index and its backfill had
 * been in place the whole time — what was missing was that the view the source reads
 * did not SELECT the column. Distrust any older note still asserting the one-source
 * framing, and note the shape of the original error: the absence was attributed to
 * the DATA ("no embedding column yet") when it was a property of the PROJECTION.
 *
 * The consequence for alarming is unchanged in kind and better in degree: with two
 * semantic sources, one starving no longer takes injection's whole corpus leg to
 * lexical-only. `no-semantic-path` stays a first-class breach kind rather than an
 * assertion in a comment precisely because which sources carry a semantic path is a
 * thing that MOVES — this file learned that the expensive way.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE RECURRENCE SIGNAL IS READ FROM THE LIVE MEASUREMENT, NOT THE PERSISTED
 * SAMPLES. P-004's text asks for "the 24h-new-row signal that catches recurrence".
 * Upstream live measurement disproved that window as an alarm input: the 24h aggregate
 * spans a receding backlog and reported 67.5% while the write path was at 100%. The
 * detector therefore judges recurrence on a SETTLED 15min–3h window instead, and
 * `settled*` is evaluated instantaneously and is NOT persisted to
 * `embed_coverage_samples` (that table's `recent_*` columns hold the 24h figures).
 * So the recurrence signal exists ONLY inside the alarm pass — which is why this module
 * is wired there, on the live `SurfaceCoverage[]`, and not onto the query-time snapshot
 * that `coverage-gate.ts` reads. Recorded as a deviation from P-004's literal wording.
 *
 * Pure: no I/O, no clock, no module state. Never throws.
 */

import {
  RECENT_COVERAGE_FLOOR,
  SETTLED_WINDOW_HOURS,
  TOTAL_COVERAGE_FLOOR,
  type CoverageBreach,
  type CoverageBreachKind,
  type SurfaceCoverage,
} from '../search/embed-coverage';
import { SEARCH_SOURCE_SURFACES } from '../search/coverage-gate';

/**
 * The sources the injection corpus leg reads.
 *
 * ⚠ This is a PINNED COPY of `CORPUS_SOURCE_NAMES` (corpus-recall-io.ts), not an
 * import, and the copy is deliberate: importing it would drag the whole live retrieval
 * stack (`@papercusp/search`, `SEARCH_SOURCES`, the query embedder, a PG handle) into
 * the DBOS alarm process to read a two-element string array. `injection-coverage.test.ts`
 * asserts the two lists are equal, so a divergence fails the suite instead of silently
 * alarming on the wrong corpus — the same loud-on-omission discipline
 * `coverage-gate.test.ts` applies to `SEARCH_SOURCE_SURFACES`.
 */
export const INJECTION_SOURCE_NAMES = ['session_turn', 'work_item'] as const;

/**
 * Breach kinds. The first two are RE-FRAMED upstream verdicts (same floors, same
 * guards, same suppression — see the header); the third is structural and is this
 * module's own.
 */
export type InjectionReachBreachKind =
  /** Every semantic leg of a source is below the corpus-coverage floor. */
  | 'injection-total-coverage'
  /** Every semantic leg is failing to index NEW writes — the recurrence catcher. */
  | 'injection-recent-coverage'
  /** No source injection reads has any embedding leg: semantic reach is GONE. */
  | 'no-semantic-path';

export interface InjectionReachBreach {
  kind: InjectionReachBreachKind;
  /** The injection source this is about; null for the corpus-wide structural breach. */
  source: string | null;
  /** The underlying surfaces that carried the upstream verdict. */
  surfaces: string[];
  /** Best-leg observed value, 0..1. Null for the structural breach. */
  observed: number | null;
  floor: number | null;
  detail: string;
}

export type InjectionSourceVerdict =
  /** Every known semantic leg is at or above floor. */
  | 'healthy'
  /** Every known semantic leg is breached — this source's semantic reach is impaired. */
  | 'degraded'
  /** No fresh measurement for any leg. NOT a synonym for healthy. */
  | 'unknown'
  /** BM25-only by construction; embedding coverage does not apply. */
  | 'not-semantic'
  /** Injection reads this source but nothing maps it to a coverage surface. */
  | 'unmapped';

export interface InjectionSourceReach {
  source: string;
  verdict: InjectionSourceVerdict;
  /** Best known leg's eligible coverage, 0..1; null when unknown/not-semantic. */
  coverage: number | null;
  /** Best known leg's settled-window coverage — the recurrence signal. */
  settledCoverage: number | null;
  /** The coverage surfaces backing this source (empty ⇒ BM25-only). */
  surfaces: string[];
  /** Legs with no measurement in this pass. Non-empty ⇒ `coverage` is a partial view. */
  unknownSurfaces: string[];
}

export interface InjectionReachReport {
  perSource: InjectionSourceReach[];
  breaches: InjectionReachBreach[];
  /**
   * How many of injection's sources have a semantic path AT ALL. Reported on every
   * pass, healthy or not, because the number itself is the finding: it is 1.
   */
  semanticSourceCount: number;
  /** True when any source injection reads is degraded, unknown or unmapped. */
  degraded: boolean;
  /** One line for a human/agent, or null when semantic reach is intact. */
  warning: string | null;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/** Best (max) of the measured legs — a row is findable if EITHER leg carries its
 *  vector, so the union is at least the max. Mirrors `assessSourceCoverage`. */
function bestOf(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * Assess injection's retrieval reach from one alarm pass.
 *
 * @param surfaces the pass's per-surface measurement
 * @param breaches the verdicts the upstream detector already reached for that pass
 * @param sourceNames injection's sources (defaults to `INJECTION_SOURCE_NAMES`)
 */
export function assessInjectionReach(
  surfaces: readonly SurfaceCoverage[],
  breaches: readonly CoverageBreach[],
  sourceNames: readonly string[] = INJECTION_SOURCE_NAMES,
): InjectionReachReport {
  const bySurface = new Map(surfaces.map((s) => [s.surface, s]));

  /** Surfaces carrying an upstream breach of a given kind. */
  const breachedSurfaces = (kind: CoverageBreachKind): Set<string> =>
    new Set(breaches.filter((b) => b.kind === kind).map((b) => b.surface));
  const totalBreached = breachedSurfaces('total-coverage');
  const recentBreached = breachedSurfaces('recent-coverage');

  const perSource: InjectionSourceReach[] = [];
  const out: InjectionReachBreach[] = [];

  for (const source of sourceNames) {
    const legs = SEARCH_SOURCE_SURFACES[source];

    if (legs === undefined) {
      perSource.push({
        source,
        verdict: 'unmapped',
        coverage: null,
        settledCoverage: null,
        surfaces: [],
        unknownSurfaces: [],
      });
      continue;
    }

    if (legs.length === 0) {
      perSource.push({
        source,
        verdict: 'not-semantic',
        coverage: null,
        settledCoverage: null,
        surfaces: [],
        unknownSurfaces: [],
      });
      continue;
    }

    const measured = legs.map((s) => bySurface.get(s)).filter((s): s is SurfaceCoverage => !!s);
    const unknownSurfaces = legs.filter((s) => !bySurface.has(s));

    if (measured.length === 0) {
      perSource.push({
        source,
        verdict: 'unknown',
        coverage: null,
        settledCoverage: null,
        surfaces: [...legs],
        unknownSurfaces,
      });
      continue;
    }

    const coverage = bestOf(measured.map((m) => m.eligibleCoverage));
    const settledCoverage = bestOf(measured.map((m) => m.settledCoverage));

    // A union source is impaired only when EVERY measured leg is breached: with the
    // parent leg at 100% every turn is still findable, so one lagging chunk table is
    // not a reach failure. Requiring all legs is what keeps this from crying wolf on
    // the normal case where chunks trail the parent.
    const allTotalBreached = measured.every((m) => totalBreached.has(m.surface));
    const allRecentBreached = measured.every((m) => recentBreached.has(m.surface));

    if (allTotalBreached) {
      out.push({
        kind: 'injection-total-coverage',
        source,
        surfaces: measured.map((m) => m.surface),
        observed: coverage,
        floor: TOTAL_COVERAGE_FLOOR,
        detail:
          `injection's '${source}' leg is drawing on a PARTIAL index — best leg ${pct(coverage)} ` +
          `(floor ${pct(TOTAL_COVERAGE_FLOOR)}), and the backlog is not shrinking. ` +
          `The pre-turn context block may silently omit a better match.`,
      });
    }

    if (allRecentBreached) {
      out.push({
        kind: 'injection-recent-coverage',
        source,
        surfaces: measured.map((m) => m.surface),
        observed: settledCoverage,
        floor: RECENT_COVERAGE_FLOOR,
        detail:
          `injection's '${source}' leg is NOT indexing new writes — best leg ${pct(settledCoverage)} ` +
          `over the settled ${SETTLED_WINDOW_HOURS}h window (floor ${pct(RECENT_COVERAGE_FLOOR)}). ` +
          `Recent work is being made unfindable AS IT IS WRITTEN; this is the recurrence signal.`,
      });
    }

    perSource.push({
      source,
      verdict: allTotalBreached || allRecentBreached ? 'degraded' : 'healthy',
      coverage,
      settledCoverage,
      surfaces: [...legs],
      unknownSurfaces,
    });
  }

  const semanticSourceCount = perSource.filter(
    (s) => s.verdict !== 'not-semantic' && s.verdict !== 'unmapped',
  ).length;

  // Structural: injection reads sources, but none of them can be reached semantically.
  // Since P-005 BOTH corpus sources carry an embedding leg, so firing this now takes
  // losing two legs rather than one — it is the ratchet that makes that loud instead
  // of silent, and it is derived from the registry rather than from a source name, so
  // it keeps working as the registry moves.
  if (sourceNames.length > 0 && semanticSourceCount === 0) {
    out.push({
      kind: 'no-semantic-path',
      source: null,
      surfaces: [],
      observed: null,
      floor: null,
      detail:
        `NO source the injection corpus leg reads (${sourceNames.join(', ')}) has an embedding ` +
        `leg — the pre-turn context block is lexical-only and cannot retrieve by meaning at all.`,
    });
  }

  const degradedSources = perSource.filter((s) => s.verdict === 'degraded').map((s) => s.source);
  const unknownSources = perSource
    .filter((s) => s.verdict === 'unknown' || s.verdict === 'unmapped')
    .map((s) => s.source);

  const bits: string[] = [];
  if (out.some((b) => b.kind === 'no-semantic-path')) {
    bits.push('injection has NO semantic retrieval path at all');
  }
  if (degradedSources.length > 0) {
    bits.push(
      `injection's semantic reach is DEGRADED for: ${degradedSources.join(', ')} — ` +
        `the context block may omit a better match that simply is not indexed`,
    );
  }
  if (unknownSources.length > 0) {
    bits.push(
      `embedding coverage is UNKNOWN (no measurement this pass) for: ${unknownSources.join(', ')} — ` +
        `unknown is not health`,
    );
  }
  if (semanticSourceCount === 1 && degradedSources.length === 0 && unknownSources.length === 0) {
    // Not a breach — standing context, so a reader of a healthy pass still knows how
    // narrow the healthy case is.
    bits.push(
      `note: injection's semantic reach rests on a single source ` +
        `(${perSource.find((s) => s.verdict === 'healthy')?.source ?? 'unknown'}); ` +
        `the others are BM25-only by construction`,
    );
  }

  return {
    perSource,
    breaches: out,
    semanticSourceCount,
    degraded: degradedSources.length > 0 || unknownSources.length > 0,
    warning: bits.length > 0 ? bits.join('; ') : null,
  };
}

/** Render an injection-reach toast. Shape mirrors `formatCoverageToast`. */
export function formatInjectionReachToast(report: InjectionReachReport): {
  level: string;
  message: string;
  description: string;
} {
  const structural = report.breaches.some((b) => b.kind === 'no-semantic-path');
  return {
    level: structural ? 'error' : 'warning',
    message: structural
      ? 'Context injection has no semantic retrieval path'
      : `Context injection retrieval reach degraded (${report.breaches.length} signal(s))`,
    description: report.breaches.map((b) => b.detail).join(' '),
  };
}
