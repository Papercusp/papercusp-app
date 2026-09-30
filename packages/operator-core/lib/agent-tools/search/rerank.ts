/**
 * Stage-B rerank — the operator's reranker seam over `@papercusp/search`'s
 * RRF-fused output. `@papercusp/search` does Stage A (BM25 + pgvector → RRF)
 * and stops there; this adds a cross-encoder relevance reorder (via
 * `@papercusp/search-core` → `@papercusp/rerank`) so the most relevant hits
 * rise to the top of the page. Adopted from Restart's search-core
 * (search-core-papercup-adoption-2026-05-30).
 *
 * ENGINE (plan local-reranker-gte-modernbert-2026-08-02, P-007). This seam used
 * to be dark: with no ZeroEntropy key — the common case, and the only case on a
 * desktop install — it returned the RRF order untouched, so Stage B never ran
 * for anyone. It now defaults to the LOCAL cross-encoder
 * (gte-reranker-modernbert-base, ~150M), which needs no credential and no
 * network: served by the shared embed sidecar when the host runs one (one warm
 * model for the whole box, `/rerank` beside `/embed`), in-process where none is
 * configured. A configured ZeroEntropy key still wins — adding a credential is
 * an explicit act and hosted zerank-2 is the stronger model.
 *
 * Engine selection lives in `resolveProseRerankEngine` alone, so adding the
 * self-hosted zerank-2 (Apache-2.0, 4B) on the GPU host later is one more
 * branch there, not another rewrite of `rerankProseHits`.
 *
 * FLAGS.LOCAL_RERANK (default ON) gates the LOCAL engine only — turning it off
 * restores the pre-P-007 behavior exactly: hosted when a key is configured, RRF
 * passthrough otherwise. It is read per query, not latched at import, so a flip
 * in /admin/features takes effect without restarting the operator.
 *
 * Fail-safe by construction — a rerank outage degrades to retrieval (RRF)
 * order, it never breaks search. Note the two halves are deliberately not in
 * tension: the sidecar client THROWS when a configured sidecar is sick (so the
 * sickness is visible rather than silently absorbed by loading a duplicate
 * model per process), and `@papercusp/rerank`'s single fail-safe seam converts
 * that throw into "keep retrieval order" one layer up. Anything else that can
 * go wrong here — the lib failing to import, the credential read throwing,
 * the sidecar refusing to spawn — lands in the same passthrough below.
 *
 * Domain note: search-core's instruction / LLM-category-match / query-rewrite
 * stages default to e-commerce (Restart sells laptops) and do NOT transfer to
 * agent-memory search — so we use the pure cross-encoder rerank only (no
 * `instruction`, no `llm`). The only tiebreak is the fused RRF/BM25 score, kept
 * within a rerank-score bucket. If we later want instruction-following, pass
 * our OWN agent-memory prompts (never search-core's e-commerce defaults).
 */

import type { RerankScoreFn } from '@papercusp/rerank';
import type { SearchHit } from '@papercusp/search';

/**
 * Over-fetch factor: how many candidates to RETRIEVE per requested result.
 *
 * A reranker can only reorder what retrieval handed it, so reranking an
 * already-sliced page is nearly pointless — it can shuffle the page but can
 * never pull a buried hit INTO it. Retrieving `limit * RERANK_OVERFETCH` and
 * letting the reranker choose the final `limit` is what makes Stage B worth
 * paying for at all.
 */
export const RERANK_OVERFETCH = 4;

/**
 * Hard ceiling on candidates scored per query.
 *
 * MEASURED (P-001 spike, 2026-08-01, gte-reranker-modernbert-base @ q8, pinned
 * to 4 cores): ~45ms per query/document pair, and it does NOT improve with more
 * cores (4 pinned cores matched a 128-core box under load 136). So cost is
 * linear in candidates with no parallelism escape hatch, and the cap — not the
 * multiplier — is what bounds worst-case latency.
 *
 * Both prose search tools default to `limit` 5 (max 50). Without a cap, a
 * `limit: 20` call would rerank 80 pairs ≈ 3.6s. At 24 the worst case is
 * ≈ 1.1s while the common `limit: 5` path still gets a full 4× pool.
 *
 * Their max rose 20 → 50 (EI-20275475712246963), which is ABOVE this cap — so
 * both now go through {@link rerankPageHead} rather than {@link rerankProseHits}
 * to keep the scored-pair count pinned here regardless of page size.
 */
export const RERANK_MAX_CANDIDATES = 24;

/**
 * Wall-clock budget for the whole rerank stage of a prose search. On expiry the
 * page degrades to RRF order through @papercusp/rerank's single fail-safe seam
 * — the same path as an engine outage, so search never throws and never stalls.
 *
 * SIZED FROM THE MEASUREMENT, not guessed. At the {@link RERANK_MAX_CANDIDATES}
 * cap the worst case is 24 × ~45ms ≈ 1.1s on this box, and P-001 found a laptop
 * runs ~1.5–2× slower ⇒ ≈ 2.2s. 4s leaves ~1.8× headroom over that worst case.
 *
 * ⚠⚠ THAT HEADROOM IS PER-CALL, AND THE SCORER IS SHARED — this block used to
 * conclude "so a HEALTHY rerank never trips it, and only genuine pathology
 * does", which is FALSE the moment two searches overlap (WI-37676). The sizing
 * argument prices ONE call's COMPUTE against a WALL-CLOCK bound while the
 * in-process scorer is a single serialized resource, so N concurrent callers
 * each wait ~N × their own compute. Measured 2026-08-10 over the real worker
 * path, at the cap (24 pairs) and again at 100:
 *
 *     concurrency    1      2      4      8
 *     per-call     1.00x  2.04x  3.98x  7.68x   of the solo wall clock
 *     throughput   30.9   30.3   31.1   32.2    pairs/s
 *
 * Latency is exactly linear in the number of callers and aggregate throughput is
 * FLAT — concurrency buys nothing here. So five-plus concurrent prose searches
 * used to blow this budget together and EVERY in-flight search degraded to RRF
 * order at the same moment, each after spending its full 4s. A correlated
 * failure, which is why it never presented as flakiness.
 *
 * ⚠ Do not trust an older note quoting `1 → 1951ms · 2 → 1617/1880 · 4 → 3363`.
 * Those were real numbers off the INLINE fallback, recorded as a property of the
 * worker path — the worker never came up in a standalone script (WI-37680), so
 * the path that ships had never actually been measured.
 *
 * ✅ FIXED (WI-37676): `@papercusp/rerank`'s `scorer-gate.ts` admits callers to
 * the shared scorer one at a time and REFUSES, at ~1ms, any call its measured
 * cost estimate says cannot finish inside the caller's `timeoutMs`. Since
 * concurrency bought no throughput, serializing costs nothing. Measured
 * end-to-end at this cap and this budget, 8 concurrent searches:
 *
 *     before: 0/8 reranked — all 8 spent the full 4000ms, wall 5957ms
 *     after:  5/8 reranked (686…3446ms), 3/8 shed in 1ms, wall 3446ms
 *
 * A shed reports `onDegrade('timeout')`, not `scoring-failed`: the engine is
 * healthy, the budget was not there. Still do not read a green single-call
 * latency measurement as evidence this bound is safe under load — what makes it
 * safe now is the gate, not the headroom.
 *
 * DELIBERATELY TIGHTER than the library backstop (20s) and than the sidecar
 * client's 15s retry budget, because those bound a HANG while this bounds a
 * user's wait. A search that has already spent 4s reranking has failed its
 * latency contract regardless of whether the sidecar might still recover.
 *
 * ⚠ ACCEPTED TRADEOFF: an in-process COLD START (first query in a fresh process
 * loads a ~150M model) can exceed this, so that first search returns RRF order
 * and later ones rerank normally. That is the correct failure direction —
 * correct results slightly less well ordered, rather than a multi-second stall
 * on someone's first search. It does not arise in the intended deployment,
 * where the sidecar holds the model warm across processes.
 *
 * ⚠ HISTORY, and the current limit (bug EI-20005411672741677, fixed 2026-08-09;
 * measured as D-093 in context-injection-retrieval-reach-and-visibility-2026-08-03).
 * This bound is enforced by `Promise.race` + `setTimeout` inside `@papercusp/rerank`,
 * and a timer CANNOT preempt a stage that blocks the event loop. WITH A SIDECAR the
 * stage is an HTTP call, genuinely async, and the bound always worked as described.
 * WITHOUT one the cross-encoder runs in-process on the main thread — and until the
 * fix that meant NEITHER the cold start NOR a slow query "returned RRF order" on
 * expiry: both ran to completion while the caller waited, with no degrade available.
 * Measured on the sibling corpus path, which uses the same seam: a 2,000ms bound
 * overrun to 2,473ms with the call still reporting success.
 *
 * `scoreCrossEncoder` now yields to the event loop between batches and re-checks a
 * deadline there, so the timer CAN fire and the stage does degrade. The residual
 * limit is GRANULARITY, not correctness: a single forward pass still holds the
 * thread, so the caller's wait is bounded to this value plus at most one batch
 * (default 16 pairs ≈ 720ms on this box). Comfortable inside 4s; size any tighter
 * bound — the corpus leg's 2,000ms — with that one-batch overrun in mind.
 *
 * Making the bound EXACT needs the model on a worker thread, as the local embedder
 * already does (`local-embedder-worker.ts`); that is tracked separately and is the
 * only remaining reason this says "bounded" rather than "precise". Still not a
 * constant to tune: a bigger number here never bought enforcement.
 */
export const PROSE_RERANK_TIMEOUT_MS = 4_000;

/**
 * How long one process may reuse the hosted-vs-local engine decision.
 *
 * `operator_credentials` is intentionally excluded from the generic operator-
 * state cache because it is encrypted secret material. Reading it for every
 * prose search nevertheless turns an almost-static engine choice into a PG
 * round-trip on the hot path. Keep that optimization at this narrow seam: a
 * newly added or removed ZeroEntropy key is observed within one minute, while
 * unrelated credential consumers retain their existing freshness semantics.
 */
export const PROSE_RERANK_ENGINE_DECISION_TTL_MS = 60_000;

/**
 * How many hits to RETRIEVE so the reranker has a real pool to choose from.
 * Never returns fewer than `limit` (an over-fetch must never under-fetch).
 */
export function rerankCandidateCount(limit: number): number {
  return Math.max(limit, Math.min(limit * RERANK_OVERFETCH, RERANK_MAX_CANDIDATES));
}

/**
 * The text a cross-encoder should score against the query.
 *
 * ⚠ NOT `hit.excerpt`. In `sources.ts`, `excerpt` is `trunc(body)` — literally
 * `body.slice(0, 200)`, the first 200 characters of the document — while the
 * MATCH-CENTRED text (`ts_headline`, up to 2 fragments around the query terms)
 * lands in a separate `highlight` field that the rerank path never read.
 *
 * Scoring the excerpt therefore asks the cross-encoder "is this document's
 * OPENING about the query?" — which for any document whose relevant passage is
 * not in its first 200 chars is the wrong question, and it silently demotes
 * exactly the long documents a reranker is most useful for.
 *
 * So: lead with the matched fragments (marker tags stripped — `<mark>` is a
 * rendering concern and would just be tokenizer noise), then append the opening
 * for topical context when it adds anything. Both fields are already on every
 * `SearchHit`, so this costs no extra retrieval.
 */
export function rerankText(hit: SearchHit): string {
  const highlight = (hit.highlight ?? '').replace(/<\/?mark>/g, '').trim();
  const excerpt = (hit.excerpt ?? '').trim();
  if (!highlight) return excerpt;
  if (!excerpt || highlight.includes(excerpt) || excerpt.includes(highlight)) return highlight;
  return `${highlight} … ${excerpt}`;
}

type HostedRerankDecision = { apiKey: string } | null;

let hostedRerankDecisionCache: {
  decision: HostedRerankDecision;
  expiresAtMs: number;
} | null = null;
let hostedRerankDecisionPromise: Promise<HostedRerankDecision> | null = null;

const envHostedRerankDecision = (): HostedRerankDecision => {
  const apiKey = process.env.ZEROENTROPY_API_KEY || undefined;
  return apiKey ? { apiKey } : null;
};

/**
 * Resolve the hosted half of the engine choice behind a short process-local
 * TTL. Concurrent cold searches share one credential read.
 *
 * A failed credential read is deliberately not negative-cached: the current
 * query still falls back to the environment, but the next query may recover as
 * soon as PG does. Successful positive and negative reads are safe to cache for
 * the bounded interval above.
 */
async function hostedRerankDecision(): Promise<HostedRerankDecision> {
  const cached = hostedRerankDecisionCache;
  if (cached && Date.now() < cached.expiresAtMs) return cached.decision;
  if (hostedRerankDecisionPromise) return hostedRerankDecisionPromise;

  const pending = (async (): Promise<HostedRerankDecision> => {
    try {
      const { readCredentials } = await import('../../credentials');
      const creds = await readCredentials();
      const decision = creds.zeroentropy_api_key ? { apiKey: creds.zeroentropy_api_key } : envHostedRerankDecision();
      hostedRerankDecisionCache = {
        decision,
        expiresAtMs: Date.now() + PROSE_RERANK_ENGINE_DECISION_TTL_MS,
      };
      return decision;
    } catch {
      const decision = envHostedRerankDecision();
      if (decision) {
        hostedRerankDecisionCache = {
          decision,
          expiresAtMs: Date.now() + PROSE_RERANK_ENGINE_DECISION_TTL_MS,
        };
      }
      return decision;
    }
  })();
  hostedRerankDecisionPromise = pending;
  try {
    return await pending;
  } finally {
    if (hostedRerankDecisionPromise === pending) hostedRerankDecisionPromise = null;
  }
}

/** Test seam: drop the engine-decision memo without changing process env. */
export function _resetProseRerankEngineDecisionForTests(): void {
  hostedRerankDecisionCache = null;
  hostedRerankDecisionPromise = null;
}

/** Read the rerank key from the seam-local decision cache. */
async function rerankApiKey(): Promise<string | undefined> {
  const decision = await hostedRerankDecision();
  return decision?.apiKey;
}

let localScorerPromise: Promise<RerankScoreFn> | null = null;

/**
 * The local cross-encoder scorer, built ONCE per process.
 *
 * Memoized rather than rebuilt per query for two reasons, only the first of
 * which is cost: building it resolves — and on an opted-in host may SPAWN —
 * the shared sidecar; and the client it returns carries the sidecar's up/down
 * transition state, so a fresh client per query would report every outage as
 * brand new and could never report the recovery.
 *
 * A FAILED build is never cached (same rule as the query-embed cache): a
 * transient spawn failure must not disable reranking for the life of the
 * process.
 */
function localRerankScorer(): Promise<RerankScoreFn> {
  if (!localScorerPromise) {
    localScorerPromise = import('../../memory/embed-sidecar-wiring')
      .then((m) => m.buildSidecarAwareReranker())
      .catch((err) => {
        localScorerPromise = null;
        throw err;
      });
  }
  return localScorerPromise;
}

/** Test seam: drop the memoized scorer so a test can rebuild it. */
export function _resetLocalRerankScorerForTests(): void {
  localScorerPromise = null;
}

/**
 * Which engine scores this query, and what it needs to run.
 *
 * The ONE place engine selection lives — see the header note. Hosted wins when
 * a key is configured; otherwise the local cross-encoder, which needs no
 * credential.
 *
 * `null` means "score nothing, keep the RRF order" — reachable only when
 * FLAGS.LOCAL_RERANK is OFF and no hosted key is configured, which is exactly
 * the pre-P-007 dark seam this flag can restore.
 */
type ResolvedRerankEngine = { engine: 'zeroentropy'; apiKey: string } | { engine: 'local'; scorer: RerankScoreFn };

/**
 * Is the local engine allowed? Read per query, never latched at module load:
 * a flag flipped in /admin/features must take effect without restarting the
 * operator, and latching at import time would pin whatever was true at boot.
 *
 * Fails OPEN (the flag's default) rather than closed: a flag-backend outage
 * must not silently switch reranking off across the fleet, which would look
 * exactly like the reranker being broken.
 */
async function localRerankEnabled(): Promise<boolean> {
  try {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    return await getFlag(FLAGS.LOCAL_RERANK, 'system:search-rerank');
  } catch {
    return true;
  }
}

async function resolveProseRerankEngine(): Promise<ResolvedRerankEngine | null> {
  const apiKey = await rerankApiKey();
  if (apiKey) return { engine: 'zeroentropy', apiKey };
  if (!(await localRerankEnabled())) return null;
  return { engine: 'local', scorer: await localRerankScorer() };
}

/**
 * Rerank ANY row shape with the cross-encoder, returning the new relevance
 * order sliced to `limit`. Degrades to the input (retrieval) order sliced to
 * `limit` whenever the engine can't score.
 *
 * This is the row-shape-agnostic core: {@link rerankProseHits} is this function
 * bound to `SearchHit`, and the corpus leg of context injection (P-008) binds it
 * to its own `CorpusHit`. Engine resolution and the fail-safe seam live HERE and
 * nowhere else, so a new engine — or a fix to the degrade path — reaches every
 * caller at once. Adding a second copy of this try/catch for a new row type is
 * the thing this exists to prevent.
 *
 * ⚠ `rows` should be an OVER-FETCHED candidate pool, not an already-cut page:
 * a reranker can only reorder what retrieval handed it. Size the retrieval call
 * with {@link rerankCandidateCount}.
 *
 * ⚠ `limit` is a SLICE, and a caller that has its own downstream filtering
 * should pass `rows.length` rather than its page size — see the corpus leg,
 * where slicing to the page here would starve the filters the over-fetch exists
 * to feed.
 */
/**
 * What the Stage B reranker actually did on one call — the measurement seam
 * described on `rerankRows`' `onOutcome` below.
 *
 * Named and exported because a MEASURING caller (a bench, an A/B arm) needs to
 * report it alongside its numbers: the fail-soft contract returns the input
 * order on every degrade path, which is byte-identical to a rerank-disabled
 * control, so a run that silently lost its engine otherwise publishes a
 * confident null instead of voiding itself (WI-37670).
 */
export interface RerankStageOutcome {
  attempted: boolean;
  reason?: string;
  /** The resolved engine, recorded even when the stage then degraded. */
  engine?: string | null;
  /** Rows the cross-encoder scored. 0 ⇒ the returned order is retrieval order. */
  scored?: number;
}

export async function rerankRows<T>(
  query: string,
  rows: readonly T[],
  opts: {
    /** A caller with a local-compute budget must not silently dispatch a hosted paid reranker. */
    engine?: 'auto' | 'local';
    /** How many rows to return. Pass `rows.length` to reorder without cutting. */
    limit: number;
    /** Stable identity for the pair cache / dedup inside the reranker. */
    id: (row: T) => string;
    /** The text scored against the query — prefer MATCH-CENTRED text. */
    text: (row: T) => string;
    /** Tiebreak within a rerank-score bucket (typically the fused score). */
    qualityScore?: (row: T) => number;
    /**
     * Wall-clock bound for the stage. REQUIRED — there is no safe default across
     * callers, because the right value is a function of the caller's own budget
     * (see {@link PROSE_RERANK_TIMEOUT_MS} for the interactive-surface value and
     * the corpus leg for a tighter one).
     */
    rerankTimeoutMs: number;
    /**
     * Observe whether the stage ran. Called EXACTLY ONCE per invocation, before
     * returning, on every path including the failure paths.
     *
     * EXISTS FOR MEASUREMENT INTEGRITY, not for telemetry. This function is
     * fail-soft by contract: when no engine resolves it returns the input order
     * untouched — which is byte-identical to what a rerank-disabled control arm
     * produces. So an A/B whose treatment silently lost its engine reports a
     * clean, confident NULL that is indistinguishable from "reranking does not
     * help", and the natural next action is to abandon the feature. A benchmark
     * must be able to VOID such a run rather than publish it.
     *
     * `attempted: true` means the stage actually RANKED — an engine resolved,
     * the call returned, and the cross-encoder scored at least one row. A call
     * that resolved an engine but scored NOTHING (the library's fail-safe
     * passthrough: a timeout, an engine outage, unusable scores) reports
     * `attempted: false` with `reason: 'degraded:<why>'` and `scored: 0`, and
     * still names the `engine` that was resolved — because the returned rows are
     * the input order either way, and a caller measuring the reranker's effect
     * must be able to tell those apart.
     *
     * ⚠ HISTORY (WI-37670). This used to report `attempted: true` for any call
     * that did not throw, which made a TOTAL degrade indistinguishable from a
     * healthy rerank that changed nothing. Measured 2026-08-10: the WI-37653
     * bench got `attempted:true, reason:'local'` on 238/238 queries while the
     * stage had scored zero rows on every one of them — the run was only saved
     * by a separate "did the order ever move" guard the bench happened to have.
     *
     * ⚠ Still necessary-not-sufficient in the PARTIAL case: `scored` between 1
     * and `rows.length` means some pairs degraded inside a successful call. A
     * caller needing certainty should compare `scored` against `rows.length`.
     */
    onOutcome?: (outcome: RerankStageOutcome) => void;
    /**
     * Observe the PER-ROW cross-encoder scores — the one true relevance
     * magnitude in the stack, which is otherwise computed and discarded (see
     * `onRerankScores` in `@papercusp/search-core`). Interactive surfaces ignore
     * this; a caller studying a relevance FLOOR needs it, because the fused
     * retrieval score is an RRF value and a threshold on it is a rank cutoff.
     *
     * ⚠ `score` is `null`, never `0`, for a row the cross-encoder did not score.
     * Not called at all on the paths that never reach the engine (a single row,
     * no engine, a throw) — those return retrieval order, so there are no scores
     * to report and an empty array would read as "all unscored" rather than
     * "never ran".
     */
    onScores?: (rows: Array<{ row: T; score: number | null }>) => void;
  },
): Promise<T[]> {
  // Nothing to reorder → no engine resolution, no rerank import.
  if (rows.length <= 1) {
    opts.onOutcome?.({ attempted: false, reason: 'nothing-to-reorder' });
    return rows.slice(0, opts.limit);
  }

  try {
    const resolved =
      opts.engine === 'local'
        ? (await localRerankEnabled())
          ? { engine: 'local' as const, scorer: await localRerankScorer() }
          : null
        : await resolveProseRerankEngine();
    // Local engine flagged off and no hosted key → the pre-P-007 dark seam.
    if (!resolved) {
      opts.onOutcome?.({ attempted: false, reason: 'no-engine' });
      return rows.slice(0, opts.limit);
    }
    const { rankWithReranker } = await import('@papercusp/search-core');
    // Held in a ref rather than a bare `let`: TypeScript's control-flow analysis
    // does not see writes made inside the callback below, so a plain local would
    // be narrowed to `null` (then `never`) at every read site.
    const stage: { info: { scored: number; total: number; degradeReason?: string } | null } = {
      info: null,
    };
    const ordered = await rankWithReranker<T>(
      query,
      rows.map((row) => ({
        id: opts.id(row),
        text: opts.text(row),
        row, // carried through untouched
      })),
      {
        limit: opts.limit,
        // Bound the stage so a sick engine degrades the page instead of
        // stalling it (the lib's 20s backstop is a hang guard, not a UX budget).
        rerankTimeoutMs: opts.rerankTimeoutMs,
        ...(resolved.engine === 'zeroentropy'
          ? { rerankApiKey: resolved.apiKey }
          : { engine: 'local' as const, scorer: resolved.scorer }),
        // Generic relevance rerank: no e-commerce instruction / LLM pass.
        ...(opts.qualityScore ? { qualityScore: opts.qualityScore } : {}),
        onRerankStage: (info) => {
          stage.info = info;
        },
        ...(opts.onScores ? { onRerankScores: opts.onScores } : {}),
      },
    );
    // A call that scored NOTHING returned retrieval order — report it as a
    // non-engagement with its reason, not as a successful rerank (WI-37670).
    // `stage === null` means the search-core build in this process predates
    // onRerankStage; that is unknown, not zero, so it keeps the old reading.
    const scored: number | null = stage.info === null ? null : stage.info.scored;
    if (scored === 0) {
      opts.onOutcome?.({
        attempted: false,
        reason: `degraded:${stage.info?.degradeReason ?? 'no-rows-scored'}`,
        engine: resolved.engine,
        scored: 0,
      });
      return ordered;
    }
    opts.onOutcome?.({
      attempted: true,
      reason: resolved.engine,
      engine: resolved.engine,
      ...(scored === null ? {} : { scored }),
    });
    return ordered;
  } catch (err) {
    // Engine unresolvable, lib/dep unavailable, or a throw that got past the
    // lib's own fail-safe seam → retrieval passthrough. Never breaks a caller.
    opts.onOutcome?.({
      attempted: false,
      reason: `threw:${err instanceof Error ? err.name : 'unknown'}`,
    });
    return rows.slice(0, opts.limit);
  }
}

/**
 * Rerank fused prose hits with the cross-encoder, returning them in the new
 * relevance order, sliced to `limit`. Degrades to the RRF order (sliced to
 * `limit`) whenever the engine can't score.
 *
 * `hits` is the OVER-FETCHED candidate pool from `@papercusp/search` — size the
 * retrieval call with `rerankCandidateCount(limit)`, not `limit`. This reorders
 * that pool and slices to `limit`, so the reranker can pull a buried hit INTO
 * the page instead of only shuffling a page retrieval already chose.
 */
export async function rerankProseHits(
  query: string,
  hits: SearchHit[],
  limit: number,
  opts?: {
    /**
     * Override the stage bound. Defaults to {@link PROSE_RERANK_TIMEOUT_MS} (4s),
     * which is correct for the interactive search surfaces this function was
     * written for and WRONG for any caller with a tighter whole-operation bound.
     *
     * The corpus leg of context injection is the motivating case (P-008): it wraps
     * its whole recall in a 2,000ms `withBound`, i.e. HALF this default. A rerank
     * that runs long there does not degrade the page — `recallCorpusContext`
     * returns `empty('timed-out')` and the agent gets NO pointer section at all,
     * which is strictly worse than not reranking. Passing a bound BELOW the
     * caller's own budget is what lets the stage fall back to RRF order instead of
     * taking the whole leg down with it.
     *
     * Callers should pass a value strictly less than their own bound, leaving room
     * for the rest of their work — never equal to it.
     */
    rerankTimeoutMs?: number;
    /**
     * Observe whether the stage actually ranked — see {@link RerankStageOutcome}.
     * Interactive surfaces ignore this; a caller MEASURING the reranker's effect
     * must read it, because a total degrade returns the retrieval order and is
     * otherwise indistinguishable from a healthy rerank that changed nothing.
     */
    onOutcome?: (outcome: RerankStageOutcome) => void;
  },
): Promise<SearchHit[]> {
  // Keyed by object identity: `rerankRows` carries the caller's row through
  // untouched, so the hits handed to `onScores` ARE these hits.
  const scores = new Map<SearchHit, number | null>();
  const ordered = await rerankRows<SearchHit>(query, hits, {
    limit,
    id: (hit) => `${hit.source}:${hit.source_id}`,
    text: rerankText, // match-centred text, NOT the head-of-doc excerpt
    // Within a rerank-score bucket, keep the higher RRF/BM25 hit first.
    qualityScore: (hit) => hit.score,
    rerankTimeoutMs: opts?.rerankTimeoutMs ?? PROSE_RERANK_TIMEOUT_MS,
    ...(opts?.onOutcome ? { onOutcome: opts.onOutcome } : {}),
    onScores: (rows) => {
      for (const r of rows) scores.set(r.row, r.score);
    },
  });
  // Empty ⇒ the stage never reached the engine (single row / no engine / threw)
  // and these are retrieval-order hits, so there is nothing to annotate.
  if (scores.size === 0) return ordered;
  // Copy rather than mutate — `hits` belongs to the caller. A hit the stage did
  // not score keeps `rerankScore` ABSENT, never 0; see `onScores`.
  return ordered.map((hit) => {
    const score = scores.get(hit);
    return typeof score === 'number' ? { ...hit, rerankScore: score } : hit;
  });
}

/**
 * Stage B for a surface whose PAGE IS BIGGER THAN {@link RERANK_MAX_CANDIDATES}:
 * rerank the head of the retrieved pool and keep the remainder in retrieval
 * order, returning `limit` hits.
 *
 * WHY THIS EXISTS (P-010). `rerankCandidateCount` deliberately never
 * under-fetches — `Math.max(limit, …)` — so for any `limit` at or above the cap
 * it returns `limit` itself and the "over-fetch" degenerates to the page. Both
 * prose agent tools now cap at `limit` 50 (raised from 20 by
 * EI-20275475712246963), so they DO reach it, as does the transcript-search
 * route at 30 (the desktop pill) to 50 (the HUD). Handing that whole page to {@link rerankProseHits} would score 30–50
 * pairs against a cap MEASURED at 24 (≈45ms/pair, no parallelism escape hatch —
 * see RERANK_MAX_CANDIDATES) — i.e. 1.35–2.25s on this box and ~2–4.5s on a
 * laptop, straight through the {@link PROSE_RERANK_TIMEOUT_MS} budget into a
 * full degrade. Silently blowing the calibration is the one thing a "just call
 * the reranker" wiring must not do.
 *
 * So the cap is honoured as a CANDIDATE budget rather than as a page size: the
 * cross-encoder orders the head — the part a human actually reads — and the
 * tail rides through in RRF order beneath it. Worst-case cost is exactly the
 * calibrated 24 pairs regardless of page size.
 *
 * Below the cap this is plain {@link rerankProseHits}, so a small page still
 * gets genuine over-fetch (the reranker can pull a buried hit INTO the page).
 * Same fail-safe contract throughout: any failure degrades to retrieval order.
 */
export async function rerankPageHead(query: string, hits: SearchHit[], limit: number): Promise<SearchHit[]> {
  if (hits.length <= RERANK_MAX_CANDIDATES) return rerankProseHits(query, hits, limit);
  const head = await rerankProseHits(query, hits.slice(0, RERANK_MAX_CANDIDATES), RERANK_MAX_CANDIDATES);
  return [...head, ...hits.slice(RERANK_MAX_CANDIDATES)].slice(0, limit);
}
