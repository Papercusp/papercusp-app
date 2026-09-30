/**
 * corpus-query-clarity — a PRE-RETRIEVAL query-performance predictor for the
 * corpus leg (P-019).
 *
 * P-019 asks for a CHEAPEST-FIRST CASCADE rather than an always-on rewriter:
 * run the statistical path always, and escalate to something more expensive
 * only when a predictor says this particular query is not going to work. This
 * module is the predictor half. It decides NOTHING and calls nothing — it turns
 * a query into a verdict, and the cascade decides what to do with it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PREDICTOR AND NOT THE UNDER-FILL TRIGGER WE ALREADY HAVE
 *
 * The leg already cascades: stage 1 ANDs two terms, and stage 2 (coverage-
 * graded) runs only when stage 1 under-fills `maxItems` (corpus-recall-io.ts).
 * That is a POST-retrieval trigger — it costs a full retrieval round to learn
 * that the query was hopeless, and it cannot distinguish "this query is
 * unfocused prose" from "this query is fine, the corpus simply holds little on
 * the topic". A pre-retrieval predictor answers before any query is issued and
 * separates those cases, which is what makes a THIRD (expensive) tier
 * decidable without paying for it on every turn.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE LOAD-BEARING RULE, INHERITED FROM `search/coverage-gate.ts`: absence of
 * evidence is NOT focus. No DF signal ⇒ `unknown`, never `focused`. Defaulting
 * the unmeasured case to "this query is fine" would silently disable the
 * escalation tier exactly when the signal it depends on is broken — the same
 * silent-confidence shape P-003 existed to remove.
 *
 * ⚠ RARITY IS A WEIGHT, NOT A SELECTOR — and this module is where that
 * distinction finally pays. D-064/D-066 measured that CHOOSING query terms by
 * rarity is strictly worse (known-item 2/7 → 0/7): maximal idf means hapax
 * legomenon, which means noise, so rarity-as-selector picks the terms
 * guaranteed to match nothing. That reverted the SELECTOR and deliberately KEPT
 * the DF table and its refresh routine, with `corpus-recall-io.ts` recording
 * why: "the redesign needs the signal, just not as a pure rarity ranker."
 * Scoring a query that ALREADY EXISTS is the legitimate use — it weights, it
 * does not choose — so nothing here re-opens D-066.
 *
 * PURE. The DF signal and the collection size are INJECTED, exactly as
 * `corpusQueryText` injects them, so this is testable without a database.
 */

import {
  corpusTerms,
  corpusQueryText,
  corpusQueryIdToken,
  CORPUS_QUERY_MIN_DF,
} from './corpus-recall';

/**
 * What the statistical (cheap) path can be expected to do with this query.
 *
 * The four non-`unknown` values are deliberately NOT a severity ladder — they
 * are different KINDS of query needing different responses, which is the whole
 * point of a cascade. Collapsing them into one "difficulty" scalar is what
 * makes an always-on rewriter look necessary.
 */
export type QueryClarityVerdict =
  /**
   * The query carries a resolvable record handle (WI-6512, EI-9748, D-037) and
   * short-circuits to that id ALONE. Retrievable by construction — a near-unique
   * key cannot be improved by rewriting, and ANDing anything beside it can only
   * cost recall. NEVER escalate.
   */
  | 'keyed'
  /** Attested terms with a clarity score at or above the threshold. The cheap
   *  path is expected to work; do not spend anything more. */
  | 'focused'
  /**
   * Attested terms, but the query looks like the corpus at large rather than
   * like any part of it.
   *
   * ⚠ THIS WAS THE ESCALATION CANDIDATE AND IS NO LONGER ONE — D-095 §4
   * measured it as the BEST-reaching bucket, not the failing one. See
   * {@link clarityWarrantsEscalation} for the numbers and the reversal.
   */
  | 'unfocused'
  /**
   * NO term in this query is attested by the corpus at least `minDf` times.
   * Materially different from `unfocused`: widening, re-ranking and grading all
   * operate on documents the query MATCHED, and this query matches nothing, so
   * every cheap tier is provably a no-op. D-064 measured that a term the corpus
   * attests fewer than twice cannot retrieve at all — under `plainto_tsquery`'s
   * AND it empties the result set outright, and even in the graded cascade it
   * contributes no coverage.
   */
  | 'unretrievable'
  /** No usable DF signal (no table built yet, or an empty collection). NOT a
   *  synonym for `focused` — see the load-bearing rule above. */
  | 'unknown';

export interface QueryClarityAssessment {
  verdict: QueryClarityVerdict;
  /**
   * Simplified Clarity Score (He & Ounis 2004) in BITS — the pre-retrieval
   * approximation of Cronen-Townsend et al. (2002) clarity that P-019 names.
   * KL divergence of the query language model from the collection language
   * model: high ⇒ the query looks unlike the corpus at large ⇒ its result
   * distribution will be concentrated. `null` when it could not be computed.
   */
  scs: number | null;
  /** Mean IDF (bits) over attested terms — the standard baseline predictor,
   *  reported because it is cheaper to reason about than SCS and the two
   *  disagreeing is itself informative. `null` when nothing was attested. */
  avgIdf: number | null;
  /** IDF (bits) of the single most discriminating attested term. A query can
   *  have a poor mean and still be rescued by one strong term, which is exactly
   *  what the leg's 2-term AND exploits. */
  maxIdf: number | null;
  /** Candidate terms `corpusTerms` extracted from the text. */
  terms: number;
  /** How many of those the corpus attests at least `minDf` times. */
  attestedTerms: number;
  /** attested / terms, 0..1. `null` when there were no terms at all. */
  attestedRatio: number | null;
  /** The id this query short-circuits on, when `verdict === 'keyed'`. */
  idToken: string | null;
  /** One line a human or an agent can act on. */
  note: string;
}

export interface QueryClarityOptions {
  /**
   * Corpus DOCUMENT frequency of a raw `corpusTerms` token. MUST be built with
   * `corpusTerms`, not `ts_stat` — see `corpus-term-df.ts` for why a stemming
   * mismatch silently inverts every ranking built on it. Omit ⇒ `unknown`.
   */
  df?: (term: string) => number;
  /** Corpus size: how many documents the DF table was folded over
   *  (`corpus_term_df.ndocs`). Omit or ≤ 0 ⇒ `unknown`. */
  ndocs?: number;
  /** Terms attested fewer than this many times count as unattested. Defaults to
   *  {@link CORPUS_QUERY_MIN_DF}, so this module and the query builder agree on
   *  what "the corpus knows this word" means. */
  minDf?: number;
  /** SCS at or above this (bits) reads as `focused`. Defaults to
   *  {@link CORPUS_CLARITY_FOCUSED_BITS}. */
  focusedBits?: number;
}

/**
 * SCS threshold separating `focused` from `unfocused`, in bits.
 *
 * ⚠ THIS NUMBER IS A PLACEHOLDER UNTIL THE DISTRIBUTION IS MEASURED, and it is
 * exported (rather than inlined) so the measurement can move it in one place.
 * Do NOT tune it by taste against a handful of example queries: the whole
 * argument for a cascade is an empirical claim about what fraction of REAL
 * traffic needs the expensive tier — the Coverage Illusion (2026-05-26)
 * measured 27.8% against a synthetic estimate of >90%, i.e. a synthetic guess
 * was wrong by more than 3x in the direction that justifies always-on spend.
 * Picking this constant from intuition reproduces exactly that error.
 *
 * ⚠ SINCE D-095 THIS CONSTANT GOVERNS NO SPEND. It separates `focused` from
 * `unfocused`, and `unfocused` no longer escalates
 * ({@link clarityWarrantsEscalation}), so moving it re-labels queries between
 * two buckets that BOTH retrieve well and changes no cost. It stays
 * uncalibrated ON PURPOSE, not by neglect: D-095 §5 found no knee in the decile
 * curve to calibrate against, and explicitly forbids picking a percentile or
 * fitting to the paper's 27.8%. Calibrate it when — and only when — a tier
 * exists that spends differently on the two sides of it.
 */
export const CORPUS_CLARITY_FOCUSED_BITS = 5;

const log2 = (x: number): number => Math.log(x) / Math.LN2;

/**
 * Score one already-extracted term pool. PURE.
 *
 * Split from {@link assessCorpusQueryClarity} so a caller that has already run
 * `corpusTerms` (the leg has) does not tokenize the same text twice.
 *
 * ⚠ SCS AND IDF ARE COMPUTED OVER ATTESTED TERMS ONLY, and that exclusion is
 * load-bearing rather than a convenience. `P(t|C) = df/ndocs` is 0 for an
 * unattested term, so its KL contribution is infinite — i.e. a query made
 * entirely of hex digests and session nonces would score as MAXIMALLY clear,
 * the precise inversion D-064 measured and reverted (a miss reads as df 0, i.e.
 * maximal rarity, i.e. selected). Unattested terms are therefore counted in
 * `attestedRatio` and excluded from the scores, and a query with none of them
 * attested gets its own verdict instead of a flattering number.
 *
 * ⚠ `P(t|C)` uses DOCUMENT frequency where textbook SCS uses collection TERM
 * frequency. DF is what `corpus_term_df` persists (deliberately — it also drops
 * the hapax tail), so this is an approximation, not the exact statistic. It is
 * monotone in the same direction and the threshold is calibrated against THIS
 * definition, so the substitution is sound as long as nothing compares these
 * bits against a published SCS value.
 */
export function scoreCorpusQueryClarity(
  terms: readonly string[],
  opts: QueryClarityOptions = {},
): QueryClarityAssessment {
  const minDf = opts.minDf ?? CORPUS_QUERY_MIN_DF;
  const focusedBits = opts.focusedBits ?? CORPUS_CLARITY_FOCUSED_BITS;
  const ndocs = opts.ndocs ?? 0;

  const base = {
    scs: null,
    avgIdf: null,
    maxIdf: null,
    terms: terms.length,
    attestedTerms: 0,
    attestedRatio: terms.length > 0 ? 0 : null,
    idToken: null,
  } as const;

  // Checked BEFORE the DF signal: a keyed query is retrievable by construction,
  // so it is answerable even when the DF table is missing entirely. Ordering
  // this after the `unknown` guard would report the leg's single most reliable
  // case as unmeasurable.
  const idToken = corpusQueryIdToken(terms);
  if (idToken) {
    return {
      ...base,
      verdict: 'keyed',
      // NOT measured rather than measured-zero: the short-circuit happens before
      // any attestation lookup, and this module's whole premise is that those
      // two must never collapse into one number.
      attestedRatio: null,
      idToken,
      note:
        `query short-circuits to the record handle '${idToken}' and is used ALONE — ` +
        `a near-unique retrieval key, so no rewrite or widening can improve it.`,
    };
  }

  if (!opts.df || ndocs <= 0) {
    return {
      ...base,
      verdict: 'unknown',
      attestedRatio: null,
      note:
        `no corpus DF signal available (df=${opts.df ? 'given' : 'absent'}, ndocs=${ndocs}) — ` +
        `query clarity is UNKNOWN, which is not the same as focused. ` +
        `Build the corpus_term_df table (system:corpus-term-df) to get a real verdict.`,
    };
  }

  if (terms.length === 0) {
    return {
      ...base,
      verdict: 'unretrievable',
      attestedRatio: null,
      note: 'no candidate terms in this text — there is nothing to retrieve on.',
    };
  }

  const attested: Array<{ term: string; df: number }> = [];
  for (const term of terms) {
    const df = opts.df(term);
    if (df >= minDf) attested.push({ term, df });
  }
  const attestedRatio = attested.length / terms.length;

  if (attested.length === 0) {
    return {
      ...base,
      verdict: 'unretrievable',
      attestedRatio: 0,
      note:
        `none of this query's ${terms.length} candidate term(s) are attested by the corpus ` +
        `(df ≥ ${minDf}) — every cheap tier is a provable no-op here, because widening, ` +
        `grading and re-ranking all operate on documents the query matched and this one ` +
        `matches nothing.`,
    };
  }

  // SCS = Σ P(t|Q)·log2(P(t|Q)/P(t|C)), with P(t|Q) uniform over the attested
  // terms (corpusTerms de-duplicates, so every qtf is 1) and P(t|C) = df/ndocs.
  const n = attested.length;
  const idfs = attested.map((a) => log2(ndocs / a.df));
  const scs = idfs.reduce((sum, idf) => sum + (idf - log2(n)) / n, 0);
  const avgIdf = idfs.reduce((a, b) => a + b, 0) / n;
  const maxIdf = idfs.reduce((a, b) => (b > a ? b : a));

  const focused = scs >= focusedBits;
  const bits = (v: number): string => v.toFixed(2);
  const shortfall =
    attested.length < terms.length
      ? ` ${terms.length - attested.length} of ${terms.length} candidate term(s) are unattested ` +
        `and contribute nothing to retrieval.`
      : '';

  return {
    verdict: focused ? 'focused' : 'unfocused',
    scs,
    avgIdf,
    maxIdf,
    terms: terms.length,
    attestedTerms: attested.length,
    attestedRatio,
    idToken: null,
    note: focused
      ? `clarity ${bits(scs)} bits (≥ ${bits(focusedBits)}) over ${n} attested term(s) — ` +
        `this query looks unlike the corpus at large, so the cheap path should concentrate.` +
        shortfall
      : `clarity ${bits(scs)} bits (< ${bits(focusedBits)}) over ${n} attested term(s), ` +
        `max term IDF ${bits(maxIdf)} — this query looks like the corpus at large, so its ` +
        `result distribution will be diffuse and the cheap path is expected to under-perform.` +
        shortfall,
  };
}

/**
 * Which terms to score.
 *
 * `issued` (DEFAULT) — the ≤`CORPUS_QUERY_MAX_TERMS` terms `corpusQueryText`
 * actually sends to the engine. This is what retrieval sees, so it is what a
 * prediction about retrieval must be about.
 *
 * `pool` — every candidate term `corpusTerms` extracted. Kept because it is the
 * natural question to ask ("how good is the evidence available?") and because
 * the CLI needs it as a control — NOT because it is a usable predictor. See the
 * warning on {@link assessCorpusQueryClarity}.
 */
export type QueryClarityScope = 'issued' | 'pool';

/**
 * Assess the raw injected text. Convenience wrapper over
 * {@link scoreCorpusQueryClarity}.
 *
 * ⚠⚠ SCORES THE ISSUED QUERY, NOT THE CANDIDATE POOL — and this default is a
 * MEASURED CORRECTION, not a preference. This function originally scored the
 * pool, justified in this very docstring as "the more useful question". The
 * P-019 probe falsified that: `SCS = avgIdf − log2(n)`, so a pool-scored query
 * loses a bit of clarity for every DOUBLING of the candidate count — and the
 * candidate count is set by the injecting SURFACE's clamp width, not by the
 * query's content. Measured over 2,000 real prompts
 * (`bench/corpus-query-clarity-cli.ts`), pool-scored median SCS falls
 * MONOTONICALLY as the clamp widens — 82ch 2.73 → 116ch 1.91 → 153ch 1.79 →
 * 300ch 0.95 → 979ch 0.26 bits — i.e. it ranks the LONGEST envelopes as the
 * least clear, which is backwards: more evidence is not less confidence.
 *
 * Scoring the issued query holds `n` at ≈2, removing that term, and the
 * ordering REVERSES to the sensible direction (5.41 → 6.39 → 6.44 → 7.11 →
 * 7.83 bits): a longer envelope offers more headroom for term selection to find
 * a discriminating pair. Against the same threshold the two scopes disagree on
 * the verdict for most of the corpus, so this is not a refinement — the pool
 * scope is simply the wrong instrument.
 *
 * ⚠ The issued query is derived with NO `df`, exactly as the leg derives it
 * (`corpus-recall-io.ts`: `effectiveQuery = corpusQueryText(rawText)`). Passing
 * this module's DF signal through would silently re-enable the BANDED selection
 * D-066 measured as worse and reverted, so a "clarity" reading would then
 * describe a query production never issues.
 */
export function assessCorpusQueryClarity(
  text: string,
  opts: QueryClarityOptions & { scope?: QueryClarityScope } = {},
): QueryClarityAssessment {
  if (opts.scope === 'pool') return scoreCorpusQueryClarity(corpusTerms(text), opts);
  const issued = corpusQueryText(text);
  return scoreCorpusQueryClarity(issued ? issued.split(' ') : [], opts);
}

/**
 * Does this verdict warrant paying for a tier the cheap path does not include?
 *
 * ONLY `unretrievable`. `keyed` and `focused` are expected to work, and
 * `unknown` deliberately does NOT escalate — a tier armed by a broken signal
 * would fire on 100% of traffic exactly when nobody is measuring it, which is
 * the failure mode a cascade exists to avoid. `unknown` is a reason to fix the
 * DF table, not to spend money.
 *
 * ⚠⚠ `unfocused` USED TO ESCALATE AND NO LONGER DOES. This is a MEASURED
 * reversal (D-095 §4), not a preference, and it falsifies the cascade's own
 * founding premise — that a query which "looks like the corpus at large" will
 * retrieve badly. The R5 study (n≈1,190, two independent seeds, warm embedder
 * arm) measured the opposite: `unfocused` had the BEST reach of any bucket —
 * mean 5.82 of 6 lines admitted, 92.4% filling all six, zero-hit rate 0.0% —
 * while the bucket that actually fails is `unretrievable`: zero-hit 21.7%, mean
 * admitted 0.93. Escalating `unfocused` would spend the expensive tier
 * precisely where retrieval already works.
 *
 * The narrowing is most of the traffic, not a rounding difference. Re-measured
 * 2026-08-12 (`bench/corpus-query-clarity-cli.ts --queries 2000`, live DF table
 * 40,325 terms / 40,000 docs) and weighted by the live 7-day surface mix,
 * `unfocused`+`unretrievable` is 29.4% of recalls while `unretrievable` alone is
 * ~9.6%. So this predicate now arms a tier on roughly a THIRD as much traffic —
 * and on the third that actually comes back empty.
 *
 * ⚠ KNOWN GAP, left uncovered deliberately: D-095 §4 also names the high-SCS
 * deciles 7–10 (zero-hit 12–14%) as a candidate trigger. They read as `focused`
 * against the current threshold and are NOT escalated here, because separating
 * them needs a calibrated SCS cut and D-095 §5 found no knee to calibrate
 * against. Whoever builds the tier must decide about that population
 * explicitly rather than inherit silence about it.
 *
 * ⚠ This predicate says WHEN a tier should be paid for. It says nothing about
 * WHAT the tier does — that is the parent plan's P-006 owner gate
 * (`context-injection-audit-2026-07-28`). Do not self-answer it here, and do
 * not wire an LLM leg behind this function.
 */
export function clarityWarrantsEscalation(verdict: QueryClarityVerdict): boolean {
  return verdict === 'unretrievable';
}
