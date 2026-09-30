/**
 * Pure critique core for the Scout loop (hive-creative-ideation-2026-06-08,
 * P-005 / D-005). The deterministic, network-free spine of the adversarial
 * novelty + feasibility critics:
 *
 *   - `corpusNovelty` — the SEARCH-FIRST novelty signal: how unlike everything
 *     the Hive has already considered an idea is, measured against the corpus
 *     (prior plans, decisions, ideas, dropped/shipped improvements) using the
 *     same stable-signature + token-set Jaccard matcher the self-improvement
 *     dedup uses (lib/harness/improvements/digest). The plan's "if it's the
 *     obvious idea or already-dropped, send it back to go weirder" reduces to:
 *     a high-similarity match — especially to an already-DECIDED prior
 *     (dropped/shipped/resolved) — ⇒ low novelty + an `alreadyTried` flag.
 *   - `bucketByCritique` — the two-critics-in-tension partition plus the
 *     MOONSHOT bucket (D-005): keep high-novelty/high-feasibility, reject the
 *     obvious, and PRESERVE a small *capped* bucket of high-novelty/low-feasibility
 *     leaps so the critics don't strangle them.
 *
 * Pure + deterministic — no LLM, no IO. The LLM feasibility/novelty judgment is
 * layered on top in `critics.ts` (injected `llmCall`, the gym:judge pattern);
 * this module is the part the tests pin hard. Types here are intentionally
 * Idea-shape-agnostic (plain {id,text}) so they don't couple to P-004's Idea
 * and stay reusable.
 */
import { dedupSignature, titleSimilarity } from '../harness/improvements/digest';

export type CorpusKind = 'plan' | 'decision' | 'idea' | 'improvement' | 'implementation' | 'memory' | 'digest-pattern';

/** A prior the Hive has already considered — what novelty is measured against. */
export interface CorpusEntry {
  /** Drill-in reference: a plan slug, D-id, idea/EI-id, or settled work-item id. */
  ref: string;
  kind: CorpusKind;
  /** The comparable text (title, optionally + a short body) of the prior. */
  text: string;
  /** Lifecycle of the prior — a 'dropped'/'shipped'/'resolved' near-match is the
   *  strongest "already tried" signal. Optional. */
  state?: string;
}

export interface CorpusMatch {
  ref: string;
  kind: CorpusKind;
  /** Blended similarity [0,1]: lexical token-set Jaccard, or — when a semantic
   *  (cosine) similarity was resolved for this prior and beat lexical — that. */
  similarity: number;
  /** True when the P-017 embedding leg's cosine BEAT lexical for this prior — the
   *  match was caught semantically (a re-worded re-encounter the token matcher missed). */
  semantic?: boolean;
  state?: string;
}

export interface CorpusNovelty {
  /** 1 = nothing in the corpus is like it; 0 = an exact prior exists. */
  novelty: number;
  /** Closest priors above the match floor, strongest first (search-first evidence). */
  matches: CorpusMatch[];
  /** True when the strongest above-floor match is an already-decided prior
   *  (dropped/shipped/resolved/closed/done) — "already tried", the adversarial
   *  reject signal. */
  alreadyTried: boolean;
}

export interface CorpusNoveltyOptions {
  /** Min similarity to surface a match (default 0.5). */
  matchFloor?: number;
  /** Max matches to return (default 5). */
  maxMatches?: number;
  /** States that count as "already tried/decided" (default dropped/shipped/resolved/closed/done). */
  decidedStates?: readonly string[];
  /** Extra novelty penalty when the closest above-floor match is an already-decided
   *  prior — we've literally tried/shipped/dropped this before (default 0.15). */
  decidedPenalty?: number;
  /**
   * P-017 hybrid embedding leg (D-016): a per-corpus-ref cosine similarity [0,1] in
   * the active embedding space, resolved JOIN-WISE by the caller (semantic-novelty-leg).
   * When present for an entry, its score is blended as `max(lexical, cosine)` — so a
   * re-worded re-encounter the lexical matcher misses is still caught by its semantic
   * neighbour. Keeps this core PURE (the impure vector IO lives in the caller); absent
   * the map, scoring is byte-identical to the lexical-only original.
   *
   * ⚠ The cosine is CALIBRATED before blending — see `semanticBaselineQuantile`. Raw
   * cosine and lexical similarity are NOT the same scale, and blending them directly
   * severed Scout for six days (EI-19899846879024832).
   */
  semanticSimByRef?: ReadonlyMap<string, number>;
  /**
   * Quantile of THIS text's OWN cosine distribution treated as the "same-domain
   * baseline" and subtracted before the cosine is blended with lexical (default 0.9).
   *
   * WHY THIS EXISTS. Lexical similarity scores ~0.00 for unrelated text, so a
   * `matchFloor` of 0.5 / a reject line at 0.66 mean what they look like. Embedding
   * cosine does NOT share that origin: measured on the live papercusp corpus
   * (2210 entries, gemma/768), cosine between two UNRELATED same-domain entries has
   * p50 ~0.62 and reaches 0.77, while genuine Scout ideas score 0.73-0.82. Feeding
   * that raw into `max(lexical, cosine)` put every in-domain idea above the reject
   * line, so the critic rejected 100% of Scout's output — 520 ideas generated, 0
   * routed, for six days (EI-19899846879024832).
   *
   * Rescaling against the corpus's own distribution restores the lexical scale's
   * meaning (typical unrelated entry -> 0) and is SCALE-FREE, which matters because
   * the query text (title+body) is much longer than the corpus entries (titles), so
   * no absolute cosine threshold transfers between them. Verified across
   * quantile 0.5/0.9/0.99: 13/13 real ideas keep, 2/2 topically-alien texts keep.
   *
   * ⚠ This fixes the FALSE-REJECT outage. It does NOT make semantic dedup work:
   * duplicates (0.77-0.82) and merely-same-domain ideas (up to 0.77) OVERLAP on this
   * signal, so no threshold separates them (independently reproduced by EI-10562).
   * Re-worded conceptual dupes are the LLM novelty-skeptic's job (critic #2 in
   * critics.ts), not this leg's. Restoring real semantic dedup needs a different
   * mechanism (full-body embedding, or a cross-encoder / LLM pairwise judge).
   */
  semanticBaselineQuantile?: number;
}

const DEFAULT_DECIDED_STATES = ['dropped', 'shipped', 'resolved', 'closed', 'done'] as const;

/**
 * Default search-first novelty knobs (P-009 scout-config seam,
 * domain-generic-hive-architecture-2026-06-18). The SINGLE source of truth for these
 * values: `corpusNovelty`'s `??` fallbacks and the blueprint `scout.novelty` config
 * default (`scout/config.ts`) both reference this, so they cannot drift. Per-blueprint
 * tuning flows in via the resolved ScoutConfig; absent a blueprint override, behavior is
 * byte-identical to the previous inline constants.
 */
/**
 * The CONFIGURABLE novelty knobs — every `CorpusNoveltyOptions` field except
 * `semanticSimByRef`, which is per-call runtime data (the resolved cosine map for one
 * idea), never a tuning value. Blueprint config carries this shape; a caller passes
 * the cosine map separately.
 */
export type CorpusNoveltyTuning = Omit<Required<CorpusNoveltyOptions>, 'semanticSimByRef'>;

export const DEFAULT_CORPUS_NOVELTY_OPTIONS: CorpusNoveltyTuning = {
  matchFloor: 0.5,
  maxMatches: 5,
  decidedStates: DEFAULT_DECIDED_STATES,
  decidedPenalty: 0.15,
  semanticBaselineQuantile: 0.9,
};

/**
 * Below this many resolved cosines the distribution is too small to estimate a
 * baseline from, so the semantic leg is left UNCALIBRATED (baseline 0 — the raw
 * `max(lexical, cosine)` blend). Refusing to calibrate off a handful of samples is
 * the honest choice: a "baseline" taken from 3 points is noise, not a population.
 * Live corpora are ~2200 entries, so production always calibrates.
 */
const MIN_SEMANTIC_SAMPLES_TO_CALIBRATE = 20;

/** Ascending-sorted quantile. */
function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[i];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Search-first novelty of `text` against the corpus. Deterministic: novelty is
 * `1 - (closest similarity)`, with an extra penalty when the closest above-floor
 * prior was already decided. Reuses the self-improvement dedup matcher so a
 * re-worded re-encounter still collides (token-order-insensitive signature).
 */
export function corpusNovelty(
  text: string,
  corpus: readonly CorpusEntry[],
  opts: CorpusNoveltyOptions = {},
): CorpusNovelty {
  const matchFloor = opts.matchFloor ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.matchFloor;
  const maxMatches = opts.maxMatches ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.maxMatches;
  const decidedStates = opts.decidedStates ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.decidedStates;
  const decidedPenalty = opts.decidedPenalty ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.decidedPenalty;
  const semanticSimByRef = opts.semanticSimByRef;
  const semanticBaselineQuantile =
    opts.semanticBaselineQuantile ?? DEFAULT_CORPUS_NOVELTY_OPTIONS.semanticBaselineQuantile;

  // No comparable tokens (e.g. empty / punctuation-only) — maximally novel, but
  // we surface nothing (there is nothing to compare).
  if (!dedupSignature(text)) {
    return { novelty: 1, matches: [], alreadyTried: false };
  }

  // P-017 hybrid leg, calibration pass (EI-19899846879024832). Cosine does not share
  // lexical similarity's origin — unrelated same-domain text sits around 0.62, not 0 —
  // so the raw value cannot be compared against a lexical-tuned floor. Establish THIS
  // text's own same-domain baseline from the resolved cosines and subtract it below.
  let semanticBaseline = 0;
  if (semanticSimByRef && semanticSimByRef.size >= MIN_SEMANTIC_SAMPLES_TO_CALIBRATE) {
    const cosines: number[] = [];
    for (const e of corpus) {
      const c = semanticSimByRef.get(e.ref);
      if (typeof c === 'number' && Number.isFinite(c)) cosines.push(c);
    }
    if (cosines.length >= MIN_SEMANTIC_SAMPLES_TO_CALIBRATE) {
      cosines.sort((a, b) => a - b);
      semanticBaseline = quantile(cosines, semanticBaselineQuantile);
    }
  }
  const semanticSpan = Math.max(1e-6, 1 - semanticBaseline);

  const scored: CorpusMatch[] = [];
  for (const e of corpus) {
    const lexical = round2(titleSimilarity(text, e.text));
    // P-017 hybrid leg: blend the caller-resolved cosine as max(lexical, calibrated).
    // Computed BEFORE the <=0 skip on purpose — a re-worded re-encounter with zero
    // lexical overlap (the 2026-07-10 dupe-storm class) is only caught this way.
    const cos = semanticSimByRef?.get(e.ref);
    // Rescale so "typical unrelated entry" maps to 0, matching the lexical scale.
    // Below the baseline there is no evidence of similarity at all, hence the clamp.
    const calibrated =
      typeof cos === 'number' && Number.isFinite(cos)
        ? Math.max(0, (cos - semanticBaseline) / semanticSpan)
        : undefined;
    const useSemantic = typeof calibrated === 'number' && calibrated > lexical;
    const similarity = useSemantic ? round2(calibrated) : lexical;
    if (similarity <= 0) continue;
    scored.push({
      ref: e.ref,
      kind: e.kind,
      similarity,
      ...(useSemantic ? { semantic: true } : {}),
      ...(e.state ? { state: e.state } : {}),
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);

  const top = scored[0];
  const maxSim = top ? top.similarity : 0;
  const alreadyTried = !!top && top.similarity >= matchFloor && !!top.state && decidedStates.includes(top.state);

  let novelty = 1 - maxSim;
  if (alreadyTried) novelty -= decidedPenalty;
  novelty = round2(Math.max(0, Math.min(1, novelty)));

  const matches = scored.filter((m) => m.similarity >= matchFloor).slice(0, maxMatches);
  return { novelty, matches, alreadyTried };
}

export type CritiqueVerdict = 'keep' | 'moonshot' | 'reject';

/** The minimal per-idea scores the bucketing reasons over. */
export interface CritiqueScores {
  id: string;
  /** 0..1 — how unlike the corpus (search-first + LLM-blended). */
  novelty: number;
  /** 0..1 — how groundable in this architecture, cost vs upside. */
  feasibility: number;
}

export interface BucketOptions {
  /** Below this novelty an idea is "the obvious idea / already tried" → reject (default 0.34). */
  noveltyFloor?: number;
  /** At/above this feasibility an idea is buildable now (default 0.5). */
  feasibilityFloor?: number;
  /**
   * The ABSOLUTE moonshot novelty floor (default 0.66) — in `bucketByCritique` it is the
   * CAP of the batch-relative floor (WI-39492: a leap never needs MORE than this, but the
   * effective floor adapts DOWN as the corpus densifies — see `effectiveMoonshotFloor`).
   * `verdictFor` called directly (the pre-cap single-idea path) still uses it as-is.
   */
  moonshotNoveltyFloor?: number;
  /** Max ideas kept in the moonshot bucket so leaps survive but don't flood (D-005, default 2). */
  maxMoonshots?: number;
  /**
   * WI-39492 — the quantile of the batch's novelty distribution the RELATIVE moonshot
   * floor tracks (default 0.75 ≈ the 2nd-highest of an 8-idea batch, matching
   * `maxMoonshots` 2). See `effectiveMoonshotFloor`.
   */
  moonshotFloorQuantile?: number;
  /**
   * WI-39492 — hard minimum of the relative moonshot floor (default 0.45): however
   * compressed the batch, "a leap" never means less novelty than this.
   */
  moonshotFloorMin?: number;
}

/**
 * Default verdict-bucket knobs (P-009 scout-config seam) — single source of truth for
 * `verdictFor`/`bucketByCritique`'s `??` fallbacks AND the blueprint `scout.buckets`
 * config default (`scout/config.ts`).
 */
export const DEFAULT_BUCKET_OPTIONS: Required<BucketOptions> = {
  noveltyFloor: 0.34,
  feasibilityFloor: 0.5,
  moonshotNoveltyFloor: 0.66,
  maxMoonshots: 2,
  moonshotFloorQuantile: 0.75,
  moonshotFloorMin: 0.45,
};

/**
 * WI-39492 — below this many scored ideas the batch novelty distribution is too small to
 * take a quantile of, so `effectiveMoonshotFloor` falls back to the absolute floor
 * (same refuse-to-calibrate-off-noise discipline as MIN_SEMANTIC_SAMPLES_TO_CALIBRATE).
 */
const MIN_BATCH_FOR_RELATIVE_MOONSHOT_FLOOR = 4;

/**
 * WI-39492 — the batch-relative moonshot novelty floor.
 *
 * The fixed 0.66 floor drifted out of reach: search-first novelty is a CEILING
 * (`1 − closest corpus similarity`, LLM may only lower it), and against a ~2200-entry
 * corpus that ceiling compresses to ~0.5–0.65 — measured live: 0 moonshots in 96 ideas
 * across 12 cycles, every low-feasibility leap rejected as "not strong enough". That
 * quietly defeats D-005's leap preservation. So the floor tracks the batch instead:
 *
 *   effectiveFloor = min(moonshotNoveltyFloor,               // never demand MORE than the absolute
 *                        max(moonshotFloorMin,               // a leap still means something
 *                            quantile(batch novelties, q)))  // adapt to what's achievable now
 *
 * Batches below MIN_BATCH_FOR_RELATIVE_MOONSHOT_FLOOR use the absolute floor unchanged.
 */
export function effectiveMoonshotFloor(novelties: readonly number[], opts: BucketOptions = {}): number {
  const absoluteFloor = opts.moonshotNoveltyFloor ?? DEFAULT_BUCKET_OPTIONS.moonshotNoveltyFloor;
  if (novelties.length < MIN_BATCH_FOR_RELATIVE_MOONSHOT_FLOOR) return absoluteFloor;
  const q = opts.moonshotFloorQuantile ?? DEFAULT_BUCKET_OPTIONS.moonshotFloorQuantile;
  const floorMin = opts.moonshotFloorMin ?? DEFAULT_BUCKET_OPTIONS.moonshotFloorMin;
  const sorted = [...novelties].sort((a, b) => a - b);
  return round2(Math.min(absoluteFloor, Math.max(floorMin, quantile(sorted, q))));
}

export interface CritiqueBuckets<T extends CritiqueScores> {
  /** Novel AND feasible — proceed to debate/recombine. */
  kept: T[];
  /** High-novelty / low-feasibility leaps preserved on purpose (capped). */
  moonshot: T[];
  /** The obvious / already-tried, and the not-novel-enough leaps. */
  rejected: T[];
  /** Per-id verdict + one-line reason, for the digest/audit. */
  verdicts: Record<string, { verdict: CritiqueVerdict; reason: string }>;
}

/**
 * The two-critics-in-tension verdict for one idea (pre-cap). Novelty is the
 * gate; feasibility decides keep-vs-moonshot among the novel.
 */
export function verdictFor(s: CritiqueScores, opts: BucketOptions = {}): { verdict: CritiqueVerdict; reason: string } {
  const noveltyFloor = opts.noveltyFloor ?? DEFAULT_BUCKET_OPTIONS.noveltyFloor;
  const feasibilityFloor = opts.feasibilityFloor ?? DEFAULT_BUCKET_OPTIONS.feasibilityFloor;
  const moonshotNoveltyFloor = opts.moonshotNoveltyFloor ?? DEFAULT_BUCKET_OPTIONS.moonshotNoveltyFloor;

  if (s.novelty < noveltyFloor) {
    return {
      verdict: 'reject',
      reason: `novelty ${s.novelty} < ${noveltyFloor} — too close to an existing/already-tried idea`,
    };
  }
  if (s.feasibility >= feasibilityFloor) {
    return { verdict: 'keep', reason: `novel (${s.novelty}) + feasible (${s.feasibility})` };
  }
  // Novel but not currently feasible → a moonshot IF it's a genuine leap. The reason
  // names the floor in force (WI-39492): under bucketByCritique it is batch-relative,
  // so the audit trail must show what "a leap" meant for THIS batch.
  if (s.novelty >= moonshotNoveltyFloor) {
    return {
      verdict: 'moonshot',
      reason: `high novelty (${s.novelty} ≥ moonshot floor ${moonshotNoveltyFloor}) / low feasibility (${s.feasibility}) — preserved leap`,
    };
  }
  return {
    verdict: 'reject',
    reason: `mid novelty (${s.novelty} < moonshot floor ${moonshotNoveltyFloor}) but low feasibility (${s.feasibility}) — not a strong enough leap`,
  };
}

/**
 * Partition scored ideas into keep / moonshot / reject (D-005). The moonshot
 * bucket is capped (`maxMoonshots`) — the most-novel leaps win the slots, the
 * rest are demoted to rejected — so leaps survive without flooding the pipeline.
 * The moonshot floor is BATCH-RELATIVE here (WI-39492, `effectiveMoonshotFloor`):
 * clamped to [moonshotFloorMin, moonshotNoveltyFloor], tracking the batch's
 * novelty quantile so leaps stay reachable as the corpus densifies.
 */
export function bucketByCritique<T extends CritiqueScores>(
  items: readonly T[],
  opts: BucketOptions = {},
): CritiqueBuckets<T> {
  const maxMoonshots = opts.maxMoonshots ?? DEFAULT_BUCKET_OPTIONS.maxMoonshots;
  const moonshotFloor = effectiveMoonshotFloor(
    items.map((i) => i.novelty),
    opts,
  );
  const verdictOpts: BucketOptions = { ...opts, moonshotNoveltyFloor: moonshotFloor };
  const kept: T[] = [];
  const moonshotCandidates: T[] = [];
  const rejected: T[] = [];
  const verdicts: Record<string, { verdict: CritiqueVerdict; reason: string }> = {};

  for (const it of items) {
    const v = verdictFor(it, verdictOpts);
    verdicts[it.id] = v;
    if (v.verdict === 'keep') kept.push(it);
    else if (v.verdict === 'moonshot') moonshotCandidates.push(it);
    else rejected.push(it);
  }

  // Cap the moonshot bucket: keep the most-novel leaps, demote the rest.
  moonshotCandidates.sort((a, b) => b.novelty - a.novelty);
  const moonshot = moonshotCandidates.slice(0, maxMoonshots);
  for (const demoted of moonshotCandidates.slice(maxMoonshots)) {
    verdicts[demoted.id] = {
      verdict: 'reject',
      reason: `moonshot bucket full (max ${maxMoonshots}) — demoted lowest-novelty leap`,
    };
    rejected.push(demoted);
  }

  return { kept, moonshot, rejected, verdicts };
}
