/**
 * Lightweight shared home for the live push-path admission contract.
 * Keep this dependency-free so isolated benchmark workers can use the same
 * production floor constructor without importing the full injection host graph.
 */
/**
 * Auto-inject relevance floor (memory-backend-improve-and-hybrid P-001 / P-031 /
 * D-003; RE-CALIBRATED by context-injection-audit-2026-07-28 P-050 / D-058).
 * The PUSH path applies an absolute cosine floor so an off-topic turn is NOT
 * injected with nearest-neighbour noise — the hard-negative FP fix, where there
 * is no LLM in the loop to filter the inject. The push path FAVORS PRECISION: an
 * irrelevant inject pollutes the turn, a missed one is recoverable via the pull
 * path.
 *
 * ⚠ THE PREVIOUS VALUE (0.45) WAS MEASURED WHOLLY INERT — not weak, INERT. In the
 * 2026-08-02 re-sweep (150 gold queries, real corpus.v1, production `cosine-gated`
 * contract) floor 0.45 was IDENTICAL TO NO FLOOR AT ALL in every column: hard-neg
 * FP@5 100%, R@10 98%, MRR 0.92, exact-id MRR 1.00, 0 positives emptied — the same
 * row as floor 0.00. D-006 calibrated 0.45 when the classes were separable
 * (hard-negatives ~0.385 vs real hits ~0.51-0.58); the embedder flip to harrier@1024
 * (P-014/P-015) moved the whole distribution up and nobody re-swept, so the floor
 * sat BELOW the weakest off-topic query's top score (0.4658) and could not reject
 * a single one. The stale doc-comment that used to live here quoted the old space's
 * numbers (FP@5 100%→17%, R@10 ~82%) and read as if it still held.
 *
 * 0.58 is BOTH the F1-max (0.947) and the knee of the marginal-cost curve:
 *   0.52 → 0.58 buys 56 points of FP for 6 points of recall;
 *   0.58 → 0.62 buys 24 more points of FP for 17 points of recall.
 *
 * ⚠ THE ACCEPTED FP RATE IS 27% (8 of 30 hard negatives still admit something),
 * and it is accepted DELIBERATELY, not overlooked. Zero FP is reachable only at
 * 0.65, which empties 45 of 150 queries and halves R@10 (98% → 52%) — the classes
 * genuinely OVERLAP in embedding space (hard-neg tops span 0.4658-0.6250 vs
 * on-topic min 0.5500), so no threshold both admits every real hit and rejects
 * every hard negative. n=30 on that class, so read 27% as ~±16pp at 95%, not as a
 * precise constant.
 *
 * MEASURED COST of 0.45 → 0.58: R@10 98% → 92%, exact-id MRR 1.00 → 0.91, and 4 of
 * 120 positive queries return nothing. The exact-id loss is the one to watch: under
 * `cosine-gated` a lexical-only hit is inadmissible, so a high cosine floor also
 * suppresses exact-identifier lookups the lexical leg would otherwise have caught.
 * If that becomes the binding cost, the fix is an admissible exact-identifier
 * lexical path — NOT lowering this floor back into inertness.
 *
 * ⚠ VALID ONLY UNDER `cosine-gated`. Under `floored-union` the lexical leg admits
 * independently of this value and backfills whatever the floor rejects (D-008), so
 * this number does not transfer to the pull path.
 *
 * Env-tunable via PAPERCUSP_MEMORY_MIN_SCORE; `<= 0` disables.
 *
 * Exported so the bench instruments measure at the EXACT production floor — a
 * single source of truth, not a copied magic number. (`recall-stats.ts`'s
 * COSINE_ADMISSION_FLOOR is a deliberate NON-copy: see the note there.) The
 * `injectMin*` readers below default to these (env-overridable).
 */
export const MEMORY_INJECTION_COSINE_FLOOR = 0.58;
export const MEMORY_INJECTION_LEX_FLOOR = 0.4;

function injectMinScore(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_MIN_SCORE);
  if (Number.isFinite(raw)) return raw > 0 ? raw : undefined;
  return MEMORY_INJECTION_COSINE_FLOOR;
}

/**
 * Hybrid-only PUSH lexical-admission bar (P-031 / D-006). The hybrid backend's
 * default lexical bar (0.30) is recall-favoring for the pull path; the no-LLM
 * push path TIGHTENS it to 0.40 so generic lexical token-overlap on an off-topic
 * turn isn't admitted (cuts push FP at a small exact-id cost). Ignored by
 * non-hybrid backends. Env-tunable.
 */
function injectMinLexScore(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_MIN_LEX_SCORE);
  if (Number.isFinite(raw)) return raw >= 0 ? raw : undefined;
  return MEMORY_INJECTION_LEX_FLOOR;
}

/**
 * PUSH-path fusion mode (context-injection-audit-2026-07-28 P-032 / F-B, D-010).
 * THE fix that makes the injected block sized by relevance instead of by K.
 *
 * The hybrid default is `floored-union`, where the lexical leg admits hits on
 * `minLexScore` ALONE — independently of the cosine leg's FP floor — and the
 * fusion then returns `slice(0, limit)`. So the cosine leg could return ZERO and
 * the block still came back FULL, refilled by lexical token-overlap: measured at
 * 97% of turn-start recalls returning exactly the pool-limit sums (D-005), with a
 * 0.0% zero-hit rate. The limit was acting as a TARGET, not a ceiling.
 *
 * Note what was NOT the problem, because it is the natural thing to reach for and
 * it does not work (D-008): the 0.45 cosine floor was firing correctly the whole
 * time. Raising it removes cosine hits and the lexical leg simply back-fills the
 * freed slots — less relevance, same K. The size is decided by ADMISSION, so
 * admission is what has to change.
 *
 * Under `cosine-gated` the candidate set is seeded ONLY from cosine hits
 * (hybrid-fusion.ts) — lexical-only admission is skipped — so membership is
 * governed by the cosine floor and the result is naturally 0..K. A real ceiling.
 * The lexical leg still contributes its RANK to the fused score, so exact-id
 * matches keep re-ranking cosine hits to the top; what is given up is a
 * lexical-only hit the cosine leg missed entirely.
 *
 * PUSH ONLY — deliberately not set on the HybridBackend construction
 * (configure.ts), so the PULL path keeps `floored-union`. A human running
 * memory:search wants recall and can discard a bad hit; auto-injection has no
 * LLM filter downstream, so it wants precision. Same asymmetry that already
 * justifies the push path's tighter minLexScore above. Env-tunable for a
 * one-flip revert if the zero-hit rate overshoots.
 */
function injectFusionMode(): 'floored-union' | 'cosine-gated' {
  return process.env.PAPERCUSP_MEMORY_FUSION_MODE === 'floored-union' ? 'floored-union' : 'cosine-gated';
}

/**
 * THE PUSH-PATH ADMISSION CONTRACT, read in ONE place (P-002).
 *
 * These three values decide TOGETHER which entries an auto-injection may admit:
 * the cosine floor, the lexical bar, and the fusion mode that says whether a
 * lexical-only hit is admissible at all. The third is not a detail — under
 * `floored-union` the lexical leg admits independently of the cosine floor, so
 * the floor's effect on the ADMITTED SET is a function of all three, never of
 * `minScore` alone (D-010, and the reason D-008's "just raise the floor" fails).
 *
 * Exported so the P-002 recurrence guard measures THE CONSTRUCTION THIS PATH
 * RUNS instead of a copy of it — which is the difference between a guard and a
 * decoration. The failure mode is already in the tree: `bench/precision-monitor.ts`
 * documents itself as measuring "the EXACT production push floor" and hardcodes
 * `fusionMode: 'floored-union'` — the value this path STOPPED using when D-010
 * flipped the push default to `cosine-gated`. A copied constant cannot notice it
 * has gone stale, so that monitor has been reporting a shape production no longer
 * runs. A guard frozen the same way would pass forever against the shape it
 * captured on the day it was written.
 *
 * Reading the live values (env overrides included) makes the guard track a
 * retune automatically and FAIL if the floor is removed outright.
 */
export interface PushSearchFloors {
  /** Absolute cosine floor for the cosine leg; `undefined` = disabled. */
  minScore: number | undefined;
  /** Normalized lexical admission bar; `undefined` = the backend default. */
  minLexScore: number | undefined;
  /** Whether a lexical-only hit may be admitted at all. */
  fusionMode: 'floored-union' | 'cosine-gated';
}

export function pushSearchFloors(): PushSearchFloors {
  return {
    minScore: injectMinScore(),
    minLexScore: injectMinLexScore(),
    fusionMode: injectFusionMode(),
  };
}
