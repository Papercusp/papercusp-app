/**
 * Papercusp's per-ranker `minScore` floors for the prose search surfaces
 * (`@papercusp/search`'s `SearchContext.minScore`, P-001).
 *
 * The engine ships the MECHANISM with no default, deliberately: a floor is a
 * number in one embedder's units over one corpus, so a generic library has no
 * defensible constant to pick. This file is where papercusp picks one, and it
 * exists as its own module so the VALUE always travels with the measurement
 * that justifies it.
 *
 * ─── WHY A FLOOR AT ALL ────────────────────────────────────────────────────
 * RRF fuses by rank position and discards the native score. A vector leg over
 * a sparsely-embedded corpus always returns its k nearest rows — relevant or
 * not — and its rank-1 row then receives exactly the same fusion weight as a
 * rank-1 row from a leg that found a real answer. Nothing downstream of fusion
 * can undo that, because the native score is gone. The floor is the only stage
 * that can.
 *
 * ─── THE MEASUREMENT (su-373a9, 2026-08-03T09:20-09:27Z, live corpus) ───────
 * Top-1 cosine, gemma@768, real query→doc direction: 6 in-domain queries
 * (subjects this corpus provably discusses) vs 6 off-domain ones (coherent
 * English about subjects it has no content on — the "no good answer exists"
 * case a floor must reject):
 *
 *   surface        in-domain top-1              off-domain top-1
 *   session_turns  min .4825  mean .6743        min .4134  mean .4978  max .5629
 *   doc_sections   min .5536  mean .6679        min .4277  mean .4728  max .5224
 *
 * The MEANS separate cleanly (~.18), and that is independently corroborated:
 * the prose gold-set bake-off measures gemma@768's rejection margin at .1702.
 * The TAILS overlap on session_turns (worst in-domain .4825 sits BELOW the
 * best off-domain .5629), so no absolute floor can fully separate the two
 * populations. A floor is a noise reducer here, never a classifier — which is
 * exactly why the value below is set from the worst-observed TRUE hit rather
 * than from the best-observed noise.
 *
 * The floor therefore sits ~0.03 BELOW the worst in-domain top-1 we measured,
 * and above the bulk of an off-domain list's deeper candidates (their top-5 ran
 * .40-.53, i.e. flat — every row equally unrelated). It removes candidates from
 * the fusion pool without threatening a hit we observed to be genuine. The
 * asymmetry is deliberate: keeping noise costs a rank slot that the
 * cross-encoder rerank can still demote, whereas dropping a true hit is
 * unrecoverable — nothing downstream can restore a row the floor deleted.
 *
 * ─── THE 2026-09-05 GOLD-SET SWEEP (EI-19446413397755983) ──────────────────
 * A floor sweep over the frozen 134-query prose gold set (2029-doc corpus,
 * gemma@768) at 0.45→0.55, measuring BOTH axes rather than top-1 alone:
 *
 *   floor   retrievable true hits lost   hard-negatives rejected   MRR@10
 *   0.45              0 / 86                    3 / 12             0.7542
 *   0.47              0 / 86                    7 / 12             0.7542
 *   0.49              0 / 86                    9 / 12             0.7542
 *   0.51              0 / 86                   10 / 12             0.7542
 *   0.53              2 / 86                   12 / 12             0.7542
 *   0.55              6 / 86                   12 / 12             0.7542
 *
 * Two findings decided the value:
 *
 * 1. TOP-1 IS THE WRONG STATISTIC. The gold set's answerable top-1 (min .5488)
 *    separates cleanly from hard-negative top-1 (max .5168), which reads as
 *    ~.08 of free headroom. It is not: top-1 is the query's BEST candidate and
 *    is the TRUE hit for only 29/122 answerable queries, so it overstates the
 *    cosine of the hit a floor would actually delete. Expected-key cosine —
 *    what the floor really cuts — runs min .4759 / p10 .5128, i.e. straight
 *    through the "headroom".
 *
 * 2. THE LEGS ARE COMPLEMENTARY, WHICH BOUNDS THE DAMAGE. bm25 covers the
 *    expected key for 73/90 `exact-identifier` queries (all at rank 1) and for
 *    0/24 `lexical-gap` + 0/8 `session-start-intent`. The classes with NO
 *    lexical fallback have in-pool expected cosine ≥ .5672; every true hit any
 *    floor ≤ .55 deletes is `exact-identifier`, recovered by bm25 at rank 1.
 *    That — not an absence of cost — is why MRR@10 is flat across the sweep.
 *
 * WHY 0.47 AND NOT 0.53. On this gold set 0.53 looks strictly better (12/12
 * rejection, no MRR cost). It is not licensed, because the gold set CANNOT SEE
 * THE TAIL that justifies this constant: its answerable top-1 bottoms out at
 * .5488, while the live-corpus probe above observed a genuine in-domain query
 * at .4825. A floor above that empties the vector leg outright for such a
 * query, and if it is paraphrase-shaped (the 0%-bm25-coverage case) the search
 * returns nothing. The gold set's "answerable" class is CONSTRUCTED and may be
 * systematically easier, so it can raise confidence but cannot overturn a
 * live-tail observation. 0.47 is the largest raise that stays below .4825: it
 * more than doubles hard-negative rejection (3/12 → 7/12) at zero measured
 * cost on either axis, while remaining bounded by the live measurement.
 *
 * TO GO HIGHER, MEASURE THE LIVE TAIL, NOT THE GOLD SET: the blocking datum is
 * the in-domain top-1 distribution on the live corpus at n >> 6 (the original
 * probe's sample). If its worst case proves to sit above ~.55, floors through
 * 0.51 are already evidenced as free by the sweep above.
 *
 * ─── WHY IT IS KEYED BY EMBEDDER MODE (do not remove this) ─────────────────
 * Cosine offsets are a property of the MODEL, not of similarity. On this
 * corpus, gemma puts two RANDOM UNRELATED session_turns at mean .6119
 * (p95 .8105, p99 .8897, n=16,110 pairs) — a huge positive offset. A model
 * without that offset (OpenAI text-embedding-3-small) puts unrelated text far
 * lower, so applying gemma's .45 to it would delete nearly every result while
 * looking like a correctly-configured floor. Hence: a floor is returned ONLY
 * for the mode it was measured on. An unmeasured mode gets NO floor, which
 * degrades to exactly today's behaviour rather than to a silent outage.
 *
 * The lexical (`lexical`) leg is likewise UNFLOORED: `ts_rank_cd` distributions
 * on these surfaces have not been measured, and an invented lexical floor
 * would delete real hits for no evidenced gain. Add one here when someone
 * measures it — the mechanism already supports it.
 */

import type { MinScoreFloors } from '@papercusp/search';

/**
 * Cosine floor for the gemma prose space. See the measurement above before
 * changing it — this number is only meaningful next to the distribution it
 * was derived from.
 */
export const EMBEDDING_FLOOR_GEMMA = 0.47;

/**
 * The floors to apply for a query embedded by `mode`, or `undefined` when
 * that mode has no measured floor (⇒ the engine filters nothing).
 *
 * `mode` is the resolved query-embedder mode from
 * `buildQueryEmbedderResolved()`. Prose surfaces route `harrier`/`local`
 * through `proseSurfacePreference` to `gemma` before reaching here, so in
 * practice this sees `gemma` or `openai`.
 */
export function proseMinScoreFloors(mode: string | null | undefined): MinScoreFloors | undefined {
  if (mode === 'gemma') return { embeddings: EMBEDDING_FLOOR_GEMMA };
  return undefined;
}
