/**
 * P-003 (context-injection-retrieval-reach-and-visibility-2026-08-03) —
 * COVERAGE-GATED DEGRADATION for the injection corpus leg.
 *
 * `lib/search/coverage-gate.ts` already turns the persisted embedding-coverage
 * samples into a per-source verdict, and `search:semantic` already reports it.
 * Injection did not read it at all: the pointer section rendered identically
 * whether the vector index was fully built, half built, or wiped.
 *
 * Injection needs this MORE than interactive search, for one asymmetry: a human
 * who sees a bad result list re-queries. An agent gets one silent block prepended
 * to its prompt, with no signal that the index behind it was near-empty and no
 * way to ask again. So the same evidence that only *annotates* a search response
 * has to be able to *suppress* an injected block.
 *
 * This module owns the DECISION only. It measures nothing, reads nothing, and
 * holds no second notion of coverage — it consumes `assessSearchCoverage`'s
 * report plus the facts the leg already computes, and returns a verdict. That
 * keeps it pure, so the interesting cases are unit-testable without a live PG.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ EVERY THRESHOLD HERE IS A ROW COUNT OR A ROW RATIO — NEVER A SCORE.
 *
 * This is a hard design constraint, not a stylistic preference.
 * `harness_shared.memory_recall_stats.top_score` mixes two incompatible score
 * scales in ONE column (see its `score_scale` companion). A gate written the
 * obvious way — one constant compared against a top score — is therefore wrong
 * BY CONSTRUCTION here: it would degrade the surfaces whose scale happens to run
 * low and pass the ones whose scale runs high, while looking entirely plausible
 * in review. Coverage ratios (embedded/eligible) and row counts are scale-free
 * and comparable across surfaces, so the gate is built from those alone.
 *
 * If you are adding a condition to this file and reaching for a score, stop.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Three rules carried over from the search-side gate, all load-bearing:
 *
 *  1. ABSENCE OF EVIDENCE IS NOT HEALTH. `unknown` (no fresh sample) degrades.
 *     Defaulting it to healthy is the silent-confidence bug being removed.
 *  2. `not-semantic` IS NOT A DEGRADATION. A source with no embedding leg has no
 *     embedding coverage to be short of, so its absence from the semantic side
 *     is a fact about the source, not a fault to alarm on.
 *
 *     ⚠ WHICH SOURCES THOSE ARE IS NOT KNOWLEDGE THIS FILE HOLDS — and that is
 *     the whole point. D-078 recorded that `work_item` was BM25-only and that
 *     `session_turn` therefore carried injection's ENTIRE semantic reach. P-005
 *     changed it: `work_item` now has an `embedding()` leg reading
 *     `harness_shared.work_items.embedding` (~100% covered) through the
 *     `engineer_issues` view, so injection's reach is two sources wide and this
 *     gate now assesses both. Nothing in this file needed editing for that,
 *     because it filters on the `not-semantic` VERDICT rather than naming
 *     sources: the mapping lives in `coverage-gate.ts`, exhaustiveness-tested
 *     against the registry. A version of this rule that had hardcoded
 *     "`session_turn` is the only source that gates here" would have gone
 *     silently wrong the day P-005 landed — it would have kept a now-semantic
 *     source out of the gate while reading exactly as authoritative.
 *  3. DEGRADED MARKS, IT DOES NOT DROP. A partially-covered corpus is still
 *     substantially useful, and silently removing it trades one dishonesty for
 *     another (search-side D-010). Suppression is reserved for the one state
 *     where there is nothing honest left to say — see `sit-out` below.
 */

import type { SearchLegs } from '@papercusp/search';
import type { SearchCoverageReport, SourceCoverageAssessment } from '../search/coverage-gate';

/**
 * The sources the gate assesses — a PINNED COPY of `corpus-recall-io`'s
 * `CORPUS_SOURCE_NAMES`, not an import of it.
 *
 * Importing the real one would be the obvious move and is wrong here: both
 * injection suites mock `./corpus-recall-io` down to `recallCorpusContext`
 * alone, so the imported constant would be `undefined` at test time and the
 * gate would fall into its own catch — permanently unevaluated, while every
 * test still passed. A fail-open path that can never be exercised is worse than
 * no path at all, because nothing distinguishes it from a working one.
 *
 * `corpus-coverage-gate.test.ts` asserts this equals the real list, so drift
 * fails a test rather than silently mis-scoping the verdict.
 */
export const CORPUS_GATE_SOURCES = ['session_turn', 'work_item'] as const;

export type CorpusGateVerdict =
  /** Semantic ran and every semantic source is at or above the coverage floor. */
  | 'ok'
  /** The section renders, carrying an explicit note of what was not at full strength. */
  | 'degraded'
  /** The section is suppressed: nothing it could say would be earned. */
  | 'sit-out';

export interface CorpusGateInput {
  /** Assessment of the sources the corpus leg actually read. */
  coverage: SearchCoverageReport;
  /**
   * P-001. FALSE ⇒ no query vector was produced, so the leg ran BM25-only.
   * Deliberately NOT the whole answer to "did semantic happen" — `legs` is
   * (see the note on `SearchResult.legs`) — but it is the one fact that is
   * always available, including when the leg never reached fusion.
   */
  embedderAvailable: boolean;
  /** P-020 per-leg execution report, when the leg reached fusion. */
  legs: SearchLegs | null;
  /**
   * The leg's own over-fetch depth — how many candidates it asked the engine
   * for. This is what makes the near-empty test a DERIVATION rather than a
   * guessed constant: see {@link isVectorIndexWithoutSelectivity}.
   */
  retrievalDepth: number;
}

export interface CorpusGateDecision {
  verdict: CorpusGateVerdict;
  /** Machine-readable reason codes, most severe first. Stable enough to alarm on. */
  reasons: string[];
  /** The line the section carries when it renders degraded; null otherwise. */
  notice: string | null;
}

/**
 * Rows a fresh coverage sample attributes to a source's best-covered leg.
 *
 * The MAX across legs, not the sum, and not any single leg (D-078): P-034's
 * union means a row is findable if EITHER the parent vector or a chunk vector
 * carries it, so the leg holding the most vectors is the one that decides
 * whether the index has anything to rank. Gating on one leg would sit the
 * section out because a chunk table lagged, while every turn remained findable
 * through its parent vector.
 * Stale readings are excluded — a stale sample is evidence of nothing, and
 * counting it would let a number from hours ago vouch for the index now.
 */
function bestEmbeddedRows(assessment: SourceCoverageAssessment): number | null {
  const fresh = assessment.surfaces.filter((s) => !s.stale);
  if (fresh.length === 0) return null;
  return fresh.reduce((max, s) => Math.max(max, s.embeddedRows), 0);
}

/**
 * Does this source's vector index have any SELECTIVITY left?
 *
 * The question P-003 actually asks is not "is coverage low" but "are these
 * nearest neighbours *nearest*, or are they merely *all there is*". Those come
 * apart at a precise, derivable point: when the index holds fewer vectors than
 * the leg over-fetches, the cosine leg returns essentially every embedded row
 * no matter what was asked. Ranking still produces an order, and the block
 * still looks exactly like a result — but the query had no influence on which
 * rows appeared, only on how they were sorted.
 *
 * So the floor is the leg's own retrieval depth. That is a property of the
 * caller, not a number chosen from prose, which is what keeps this honest:
 * it moves automatically if the leg's over-fetch changes, and it cannot be
 * quietly mis-calibrated the way an invented constant can.
 *
 * `null` rows (no fresh sample) return FALSE — unknown coverage degrades, but
 * it must never be strong enough to SUPPRESS. Suppressing on an absence of
 * evidence would be the same defect as trusting one.
 */
function isVectorIndexWithoutSelectivity(
  assessment: SourceCoverageAssessment,
  retrievalDepth: number,
): boolean {
  if (assessment.verdict !== 'degraded') return false;
  const rows = bestEmbeddedRows(assessment);
  return rows !== null && rows < retrievalDepth;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/**
 * Decide what the pointer section is entitled to claim.
 *
 * Pure: no I/O, no clock, no module state. Everything it needs is in `input`.
 */
export function assessCorpusCoverageGate(input: CorpusGateInput): CorpusGateDecision {
  const { coverage, embedderAvailable, legs, retrievalDepth } = input;

  // Sources with an embedding leg. `not-semantic` sources are excluded up front
  // (rule 2): they can never be degraded by coverage, so letting them into the
  // verdict would either fire every turn or dilute the ones that matter.
  const semantic = coverage.perSource.filter((a) => a.verdict !== 'not-semantic');

  const reasons: string[] = [];
  const notes: string[] = [];

  // ── The suppression case ────────────────────────────────────────────────
  //
  // Three conjuncts, all required, because each on its own has an innocent
  // reading and only their conjunction is unambiguous:
  //
  //   1. the vector leg RAN — otherwise this was honest BM25, not noise;
  //   2. every semantic source's index is below its own selectivity floor —
  //      so the vector leg's output is arbitrary with respect to the query;
  //   3. the lexical leg contributed NOTHING to fusion — so there is no
  //      sound line in the section to protect.
  //
  // Drop any one of them and suppression starts discarding real matches, which
  // is the trade rule 3 forbids. Together they are exactly the plan's phrase:
  // confidently emitting nearest-neighbours from a near-empty index.
  const lexicalContributed = legs === null || legs.lexical.candidates > 0;
  const allSemanticUnselective =
    semantic.length > 0 && semantic.every((a) => isVectorIndexWithoutSelectivity(a, retrievalDepth));

  if (embedderAvailable && allSemanticUnselective && !lexicalContributed) {
    return {
      verdict: 'sit-out',
      reasons: [
        // The row counts ride along so a suppressed turn is diagnosable from the
        // reason alone — a section that silently did not render is otherwise the
        // hardest state to notice after the fact.
        ...semantic.map(
          (a) => `vector-index-unselective:${a.source}:${bestEmbeddedRows(a) ?? 0}/${retrievalDepth}`,
        ),
        'lexical-leg-contributed-nothing',
      ],
      notice: null,
    };
  }

  // ── The marking cases ───────────────────────────────────────────────────
  if (!embedderAvailable) {
    reasons.push('embedder-unavailable');
    notes.push(
      'the semantic half did not run (no query vector) — every pointer below is a LEXICAL match',
    );
  }

  for (const a of semantic) {
    if (a.verdict === 'degraded') {
      reasons.push(`coverage-degraded:${a.source}`);
      notes.push(
        `'${a.source}' is only ${pct(a.coverage)} embedded, so a better match may exist but be unindexed`,
      );
    } else if (a.verdict === 'unknown') {
      reasons.push(`coverage-unknown:${a.source}`);
      notes.push(
        `embedding coverage for '${a.source}' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy`,
      );
    }
  }

  // The engine's own verdict on whether it ran at full strength. Reported
  // separately from the two above because it catches a DIFFERENT failure: a leg
  // that was configured, attempted, and then failed per-source — which leaves
  // coverage healthy and `embedderAvailable` true while the ranking is still not
  // the one the configuration promises.
  if (legs?.degraded && legs.warning) {
    reasons.push('search-leg-degraded');
    notes.push(legs.warning);
  }

  if (reasons.length === 0) return { verdict: 'ok', reasons: [], notice: null };

  return {
    verdict: 'degraded',
    reasons,
    notice: `⚠ Retrieval for these pointers was DEGRADED: ${notes.join('; ')}.`,
  };
}
