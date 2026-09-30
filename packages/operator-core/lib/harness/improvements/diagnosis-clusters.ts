/**
 * diagnosis-clusters.ts — rank the reflection lane by DIAGNOSIS, not by singleton
 * (false-premise-in-prescriptive-artifacts-2026-08-02 P-005).
 *
 * ## The gap this fills, measured before it was built
 *
 * The lane already clusters. `findLikelyDuplicates` (./digest) groups captures by
 * a shared quoted-error signature, an exact title signature, then token-set
 * Jaccard; `signatureRecurrence` counts the repeats and `recurrence-escalation`
 * turns ≥3 into a severity bump. Every one of those keys measures **topic**.
 *
 * The most-filed agent-confusion class is topically DIVERSE by construction: it
 * recurs precisely because it happens across unrelated subject matter. Measured
 * against the real corpus (15,166 open `EI-%` rows, harness `papercusp`,
 * 2026-08-03) on the seven filings the plan's Background names:
 *
 *   - incumbent lexical key: 6 of 7 are SINGLETONS. The 7th clusters only by an
 *     incidental quoted string (`quote:import("@emoji-mart…`) — a false merge on
 *     an unrelated topic, not a recognition of the class.
 *   - pairwise title Jaccard: max 0.556, median 0.133, ZERO pairs ≥ the 0.8
 *     NEAR_DUP bar. Zero pairs share a quoted signature.
 *   - stored-embedding cosine (the `digest-embed-cluster-leg` instrument, 96.5%
 *     of the corpus carries a `gemma` vector): 0.41–0.64 across the class,
 *     against a random-pair baseline of p50 0.361 / p95 0.531 / p99 0.641
 *     (n=79,800). The leg's 0.92 threshold catches NONE of them — including the
 *     one pair that is literally the same observation filed twice (0.829). See
 *     {@link EMBEDDING_CANNOT_SEPARATE} — this is pinned as a test, because the
 *     obvious "improvement" to this module is to swap in the embedding leg, and
 *     it is measurably the wrong instrument for this class.
 *
 * So the class is invisible to every key the lane owns, and stayed invisible
 * while narrower classes shipped. That is the P-005 finding.
 *
 * ## Why a DERIVED marked term, and not a declared field
 *
 * D-002 (this plan) ruled that premises must be derived from text the author
 * already wrote, because a declared field is filled in only by the already-careful.
 * That prediction is now MEASURED on this corpus: the declared shape fields are
 * empty — `findingClass` on 12 of 15,169 rows (0.08%), `watchdogKey` on 49, and
 * the author-declared `observation.kind` on 8.8%. A "declare your diagnosis"
 * field would inherit exactly that fill rate.
 *
 * ## Why the key is ONE WORD, and why every refinement made it worse
 *
 * The first draft was a five-pattern regex thicket requiring an asserted falsity
 * term near the marked word. Hand-reading its output, then re-measuring BOTH
 * directions, refuted it: tightening dropped `THE PREMISE WAS THE BUG` (the
 * canonical member), `A WORK-ITEM'S OWN PREMISE IS THE HIGHEST-VALUE THING TO
 * VERIFY`, `SUSPECT THE PREMISE THEY SHARE`, and `WI-6209's own stated premise is
 * unsupported` — recall fell 7/7 → 5/7 to remove almost nothing real.
 *
 * The reason is a property of the REGISTER, not of the pattern: in agent
 * reflections "premise" is already a MARKED term — it is written almost only when
 * flagging one as suspect. Hand-read precision on a 40-row deterministic sample of
 * the bare word: 39/40 genuine (the one miss, "the current fixed-premise model",
 * uses it as a design term). So the correct key is the simple one, and the
 * tightened variant is pinned as a test so it is not "improved" back in.
 *
 * ## What this is NOT
 *
 * NOT a dedup pass. The members are distinct filings about distinct subjects that
 * happen to share a diagnosis; merging them would destroy the very signal —
 * "sixty-five different agents hit this" — that makes the cluster rankable.
 * `findLikelyDuplicates` answers "are these the same report?"; this answers "is
 * this the same LESSON?". They are different questions with different consumers,
 * which is why this is a sibling function rather than a fourth pass inside it.
 */

import type { ImprovementCandidate } from './policy';

/**
 * A named diagnosis shape. `measured` is REQUIRED, deliberately: a shape may not
 * be added to {@link DIAGNOSIS_SHAPES} without stating what it was measured to do
 * against a real corpus, which is D-001's rule (verify the prescription, do not
 * assert an unchecked premise in the imperative voice) applied to this registry.
 */
export interface DiagnosisShape {
  /** Stable machine key, e.g. `false-premise`. */
  key: string;
  /** One line a human reads in a digest. */
  label: string;
  /**
   * The marked term. Matched against title + body. Keep it a MARKED TERM, not a
   * description of the class — see the header: refinements measured strictly
   * worse in both directions.
   */
  match: RegExp;
  /** What this key was measured to do, and on what. Stated, not assumed. */
  measured: {
    /** The corpus the numbers below come from. */
    corpus: string;
    rows: number;
    distinctAuthors: number;
    /** Hand-read precision: `truePositives` of `sampled`. */
    sampled: number;
    truePositives: number;
    /** Recall against the class members named in the plan's Background. */
    recall: string;
  };
}

/**
 * The registry. ONE shape today, because one shape is what there is measured
 * evidence for — D-001's "producer and demand demonstrated, not assumed". Adding
 * another means running the same measurement, not appending a plausible regex.
 */
export const DIAGNOSIS_SHAPES: readonly DiagnosisShape[] = [
  {
    key: 'false-premise',
    label: 'An artifact stated a load-bearing premise that turned out to be false',
    match: /\bpremise\b/i,
    measured: {
      corpus: '15,166 open EI-% rows, harness papercusp, 2026-08-03',
      rows: 376,
      distinctAuthors: 74,
      sampled: 40,
      truePositives: 39,
      recall: '7/7 of the class members named in the plan Background',
    },
  },
] as const;

/**
 * The MEASURED negative result that the obvious refactor of this module would
 * undo. Pinned here (and asserted in the tests) rather than left as prose,
 * because "cluster these semantically with the embedding leg instead" is the
 * first idea a reader has, and it is measurably wrong for this class: whole-text
 * embeddings are dominated by SUBJECT MATTER, and this class is defined by being
 * subject-diverse.
 */
export const EMBEDDING_CANNOT_SEPARATE = {
  classPairCosineMin: 0.4076,
  classPairCosineMax: 0.6355,
  /** The one excluded pair is the same observation filed twice. */
  duplicatePairCosine: 0.8293,
  legThreshold: 0.92,
  randomBaseline: { p50: 0.3608, p95: 0.5309, p99: 0.641, pairs: 79800 },
  note:
    'Class pairs sit between the p50 and p99 of random pairs, so no threshold ' +
    'separates them: at 0.64 roughly 1% of all pairs merge. The leg at 0.92 ' +
    'clusters none of them, including the true duplicate at 0.829.',
} as const;

/** One diagnosis cluster: distinct filings that share a LESSON, not a topic. */
export interface DiagnosisCluster {
  shape: string;
  label: string;
  /** Member ids, newest-first. */
  ids: string[];
  /** How many filings. */
  rows: number;
  /**
   * How many DISTINCT filers — the rank key. Measured rationale: 67.8% of the
   * incumbent clusters (661/975) are a single author re-filing, which is a much
   * weaker signal than independent convergence. Row count alone cannot tell the
   * two apart.
   */
  distinctAuthors: number;
  /** ISO of the oldest / newest member — a chronic class spans; a burst does not. */
  firstSeen?: string;
  lastSeen?: string;
}

export interface DiagnosisClusterReport {
  clusters: DiagnosisCluster[];
  /** Candidates actually examined. */
  considered: number;
  /**
   * Candidates matching NO shape. Reported so a small `clusters` array reads as
   * "the registry does not cover this corpus" rather than "this corpus has no
   * recurring diagnoses" — D-003's ruling, and the same convention the sibling
   * `likelyDuplicatesScope` already uses for dedup scope.
   */
  unshaped: number;
  /**
   * Templated per-agent filings held out BEFORE clustering: rubric-graded
   * scorecards (`observation.rubricRef` present). Measured 1,326 rows filed by
   * 1,208 DISTINCT authors — so they survive a distinct-author rank on their own
   * merits and would otherwise top every lane forever. They are a ritual, not a
   * diagnosis. Held out structurally, never by matching their title text.
   */
  ritualExcluded: number;
}

/** A rubric-graded scorecard — a per-agent ritual filing, not a diagnosis. */
function isRitualFiling(c: ImprovementCandidate): boolean {
  return typeof c.observation?.rubricRef === 'string' && c.observation.rubricRef.length > 0;
}

function searchText(c: ImprovementCandidate): string {
  return `${c.title ?? ''}\n${c.body ?? ''}`;
}

/**
 * Group candidates by shared DIAGNOSIS. Pure, deterministic, O(n) — no network,
 * no embeddings (see {@link EMBEDDING_CANNOT_SEPARATE}), so it stays regenerable
 * and cheap enough to run on the whole corpus rather than a window.
 *
 * Note it deliberately runs over the FULL candidate list it is given: the O(n²)
 * cost gate that forces `findLikelyDuplicates` to degrade above
 * NEAR_DUP_MAX_CANDIDATES does not apply to a linear pass.
 */
export function clusterByDiagnosis(
  candidates: readonly ImprovementCandidate[],
  shapes: readonly DiagnosisShape[] = DIAGNOSIS_SHAPES,
): DiagnosisClusterReport {
  const eligible: ImprovementCandidate[] = [];
  let ritualExcluded = 0;
  for (const c of candidates) {
    if (isRitualFiling(c)) ritualExcluded += 1;
    else eligible.push(c);
  }

  const shaped = new Set<string>();
  const clusters: DiagnosisCluster[] = [];

  for (const shape of shapes) {
    const members = eligible.filter((c) => shape.match.test(searchText(c)));
    if (members.length === 0) continue;
    members.forEach((m) => shaped.add(m.id));

    const sorted = [...members].sort(
      (a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'),
    );
    const stamps = members
      .map((m) => m.createdAt)
      .filter((t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
      .sort();
    const authors = new Set(
      members.map((m) => m.createdBy).filter((a): a is string => typeof a === 'string' && a.length > 0),
    );

    clusters.push({
      shape: shape.key,
      label: shape.label,
      ids: sorted.map((m) => m.id),
      rows: members.length,
      distinctAuthors: authors.size,
      ...(stamps.length ? { firstSeen: stamps[0], lastSeen: stamps[stamps.length - 1] } : {}),
    });
  }

  return {
    clusters: rankDiagnosisClusters(clusters),
    considered: candidates.length,
    unshaped: eligible.length - shaped.size,
    ritualExcluded,
  };
}

/**
 * Rank by INDEPENDENT CONVERGENCE: distinct authors first, then volume. "Filed
 * fifteen times by fifteen agents" outranks fifteen unrelated singletons AND
 * outranks one agent filing the same thing fifteen times.
 */
export function rankDiagnosisClusters(clusters: readonly DiagnosisCluster[]): DiagnosisCluster[] {
  return [...clusters].sort(
    (a, b) => b.distinctAuthors - a.distinctAuthors || b.rows - a.rows || a.shape.localeCompare(b.shape),
  );
}
