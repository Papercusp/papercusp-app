/**
 * corpus-recall-io — the LIVE leg of the P-008 second retrieval corpus
 * (context-injection-audit-2026-07-28, built to D-037). The pure selection
 * core is ./corpus-recall; this file is only the fetch seam.
 *
 * RETRIEVAL IS REUSED, NOT REBUILT — this is P-010's reuse-first check,
 * discharged. `@papercusp/search` + `SEARCH_SOURCES` already own the SQL for
 * both corpora this item wants: `session_turn` (BM25 over `text_tsv` +
 * gemma@768 cosine over `text_embedding`, with the full filter bag) and
 * `work_item` (BM25 over `engineer_issues._search`). `runHybridSearch` already
 * supplies RRF fusion, a bounded query-embed, abort threading and
 * degrade-to-BM25 on a missing embedder. Hand-writing pgvector SQL here would
 * fork a registry whose stated purpose is that the SQL lives in exactly one
 * place.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE mem0 INJECTION PATH:
 *
 *   • It does NOT call `noteMemoryFailure`. That latch drops the whole process
 *     into degraded mode so later turns skip the mem0 store entirely — correct
 *     for a hung embedder on the memory path, wrong here: this is a different
 *     subsystem, and a slow corpus search must never disable memory recall.
 *     The bound below is local and stateless.
 *
 *   • It uses the PROSE-surface embedder (`buildQueryEmbedder` already applies
 *     `proseSurfacePreference`, mapping a harrier preference → gemma), because
 *     these corpora store gemma@768 vectors. That is the same fact that makes
 *     this a separate leg rather than a fourth mem0 pool — see D-037.
 */

import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch, type SearchHit, type SearchLegs } from '@papercusp/search';
import { SEARCH_SOURCES } from '../agent-tools/search/sources';
import {
  buildQueryEmbedder,
  embedderModeOf,
  embedderProfileIdOf,
} from '../agent-tools/search/embedder';
import { stampEmbedderMode } from '../search/embedder-mode-registry';
import { rerankRows } from '../agent-tools/search/rerank';
import { createMemoryWorkDeadline, MemoryTimeoutError } from './op-deadline';
import {
  CORPUS_BUDGET_CHARS,
  CORPUS_MAX_ITEMS,
  corpusQueryText,
  CORPUS_GRADED_QUERY_MAX_TERMS,
  renderCorpusBlock,
  selectCorpusLines,
  sessionIdOfHit,
  type CorpusDrop,
  type CorpusHit,
  type CorpusLine,
} from './corpus-recall';
// NOTE: `corpusTermDfLookup` is deliberately NOT imported here any more — see the
// D-066 revert note at the `effectiveQuery` assignment below. The DF table and its
// refresh routine stay live and populated; only this leg's use of DF as a pure
// rarity SELECTOR was unwired.

/** The two registered sources this leg reads. Anything else in SEARCH_SOURCES
 *  (escalations, brainstorm, decisions, coord_message, operator turns) is out
 *  of P-008's scope — widening this list is a plan decision, not an edit. */
// Exported so the P-004 injection-reach alarm can PIN its own copy against this one
// (`injection-coverage.test.ts`) instead of drifting from it. Exported for the
// assertion only — the alarm deliberately does not import it at runtime, which would
// drag the whole live retrieval stack into the DBOS alarm process.
export const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;

/**
 * P-009 — the corpus leg's recency decay half-life.
 *
 * Injection's job is to surface what the agent is ABOUT TO RE-DERIVE, which makes
 * this corpus unusually time-sensitive: on this fleet a finding from yesterday is
 * routinely the one that saves the turn, while a near-duplicate from two months ago
 * is the failure P-009 was filed against. Seven days puts a 3-day-old hit at 0.74
 * decay and a 3-month-old one at ~0.0001 — i.e. the plan item's own example
 * ("a three-month-old near-duplicate outranks a three-day-old finding") separates
 * decisively, without a cliff that a one-week-old document falls off.
 */
export const CORPUS_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How strongly recency competes with relevance on the corpus leg, 0..1.
 *
 * Left at the engine's documented default. In `linear` mode this is a TRUE mixing
 * fraction against a rank-normalised relevance term, which buys a bound that holds
 * regardless of corpus or query: the recency term can move a hit at most
 * `w·(n-1)/(1-w)` rank positions. At w=0.3 over this leg's ~24-row fused pool that
 * is ~10 positions — enough to rescue a fresh hit past the relevance-only cut (the
 * whole point), and far short of letting an irrelevant-but-recent row lead.
 *
 * ⚠ That bound is a property of `mode: 'linear'` ONLY. `multiply` max-divides
 * instead, and `weight` there is an exponent, not a share — do not carry this
 * number across if the mode ever changes.
 */
export const CORPUS_RECENCY_WEIGHT = 0.3;

/**
 * Wall-clock bound for the WHOLE corpus leg (search + embed). This rides the
 * pre-turn prompt build, so it must fail open fast: on timeout the turn simply
 * gets no pointer section. Deliberately tighter than the mem0 path's 5s
 * MEMORY_INJECT_TIMEOUT_MS — the mem0 block is the primary payload and worth
 * waiting for; this one is additive. Env-tunable; `<= 0` disables the bound.
 */
export function corpusRecallTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 2_000;
}

/**
 * Acquisition + per-query budget for the gemma query embed. A COLD embedder
 * (sidecar spawn + ONNX pipeline load) can take 15–30s the first time; on this
 * path that must degrade to BM25-only rather than stall the turn, which is
 * exactly what a null embedder does inside `runHybridSearch`. BM25-only is a
 * genuinely useful degradation here and not a silent loss: the motivating
 * retrieval (find WI-6512 from its distinctive terms) is a lexical match.
 */
export function corpusEmbedBudgetMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_CORPUS_EMBED_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_200;
}

/**
 * Wall-clock bound for the STAGE-1 rerank alone (P-008).
 *
 * ⚠ MUST stay STRICTLY BELOW `corpusRecallTimeoutMs()` (2s). The two bounds fail
 * in completely different directions and conflating them is the whole reason
 * this constant exists rather than reusing the prose surfaces' 4s default:
 *
 *   • THIS bound expiring → the reranker's own fail-safe returns the RRF order
 *     and the leg proceeds normally. Cost: a slightly worse ORDER.
 *   • The LEG bound expiring → `recallCorpusContext` returns `empty('timed-out')`
 *     and the turn gets NO pointer section at all. Cost: the whole feature.
 *
 * So the rerank must always lose its race first. `rerankProseHits`'s 4s default
 * is TWICE the leg's entire budget and would guarantee the second outcome — that
 * is why the `rerankTimeoutMs` override was added for this caller.
 *
 * SIZED FROM THE MEASUREMENT (bench/corpus-rerank-reach-cli.ts, 120 queries,
 * post-P-024): stage-1 rerank p50 ≈ 1,185ms against a leg whose own p50 is
 * ≈ 105ms, and one stage breaches the 2s leg bound on 2/120 (1.7%). 1,500ms sits
 * above the p50 — so a healthy rerank completes and is not needlessly discarded —
 * while still reserving 500ms for search, selection and stage 2. That 1.7% tail
 * is precisely what this converts from "no pointer section" into "RRF order".
 *
 * ⚠ THIS BOUND ONCE COULD NOT FIRE AGAINST THE IN-PROCESS ENGINE (bug
 * EI-20005411672741677, fixed 2026-08-09). Both this and the leg's own bound are
 * `Promise.race` + `setTimeout`, and a timer cannot preempt a stage that blocks
 * the event loop. On a host with NO embed sidecar the cross-encoder runs
 * in-process and did exactly that, so the "degrade to RRF order" contract above
 * was INOPERATIVE there and the rerank ran to completion however long it took.
 *
 * MEASURED, not inferred (D-093): with no sidecar configured, `recallCorpusContext`
 * returned `outcome: 'ok'` after 2,473ms, 2,455ms and 2,302ms — through a 2,000ms
 * `withBound`. Had the timer fired, those would have been `'timed-out'` at ~2,000ms.
 *
 * `scoreCrossEncoder` now yields between batches and honours a deadline derived
 * from this value, so the degrade works in-process too. What remains is
 * GRANULARITY: one forward pass still holds the thread, so the real ceiling is
 * this bound plus at most one batch. That matters MORE here than on the
 * interactive path, because the leg's own 2,000ms `withBound` sits only 500ms
 * above this 1,500ms — a one-batch overrun can still push the LEG past its bound
 * and yield no pointer section. Sizing this pair is therefore still a real
 * trade-off, not a solved problem; the exact fix is the worker thread, tracked
 * separately.
 *
 * Out-of-process (sidecar configured — every operator unit on the dev box) the
 * stage is an HTTP call, genuinely async, and both bounds always worked as
 * documented. The residual granularity is DEPLOYMENT-SHAPED, landing on the
 * desktop install, which is the shipping target and the case with no sidecar.
 */
export function corpusRerankTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_CORPUS_RERANK_TIMEOUT_MS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 1_500;
}

export interface CorpusRecallInput {
  /** Parent prompt lifetime, shared with memory retrieval and preparation. */
  signal?: AbortSignal;
  /** The retrieval query — the same effective text the mem0 leg searched with. */
  queryText: string;
  workspaceId: string;
  /** Harnesses in scope. Narrows WORK-ITEM hits only — see the note on
   *  `SelectCorpusInput.harnessSlugs` for why turns must not be slug-scoped. */
  harnessSlugs?: readonly string[];
  /**
   * The CALLER'S coord ownerId (`su-xxxx…`). Every session in its
   * carry-respawn chain is dropped as echo — see
   * `SelectCorpusInput.excludeSessionIds` for why this is owner-wide and not
   * a single session id (EI-19460887729945170: the single-id form could never
   * match a real turn, because both injection ports pass an ownerId here while
   * hits carry native transcript uuids).
   */
  excludeOwnerId?: string | null;
  /** The caller's active work-item, used to disambiguate related pointers. */
  declaredWorkItemId?: string | null;
  /** Explicit per-session refs that ambient retrieval must never inject. */
  ambientExcludedRefs?: ReadonlySet<string>;
  /** Handle refs already delivered to this agent. */
  knownRefs?: ReadonlySet<string>;
  maxItems?: number;
  budgetChars?: number;
  /** Test seam: skip the flag read (the caller already gated). */
  skipFlagCheck?: boolean;
  /**
   * Terms handed to the COVERAGE-GRADED cascade stage. Defaults to
   * {@link CORPUS_GRADED_QUERY_MAX_TERMS}. Exposed so a bench can measure both
   * arms in ONE process against the SAME corpus instant — the corpus is written
   * continuously by the fleet, so two runs minutes apart are not a paired
   * comparison, which is how P-018 shipped on a real-but-unrelated gain.
   */
  gradedMaxTerms?: number;
  /** WI-9273: the graded stage's anchor cost budget (summed lexeme df). `0`
   *  selects the pre-WI-9273 single-rarest-lexeme anchor — the bench's control
   *  arm. Absent ⇒ the search source's default. */
  anchorDfBudget?: number;
  /**
   * P-008: run the stage-1 cross-encoder rerank. **DEFAULT OFF — MEASURED AND
   * NOT ADOPTED (D-093).** Deliberately not flag-gated; see `rerankStage1`.
   *
   * ⚠ READ D-093 BEFORE TURNING THIS ON. The wiring is complete and correct, and
   * it is off because it was measured, not because it is unfinished:
   *
   *   • RELEVANCE: 0/7 → 0/7 on the WI-6512 answer-bearing acceptance set. The
   *     reorder is REAL (it moved the admitted order on 5/7 batches) — it just
   *     never moved the ANSWER. Of the 7 batches only 2 were rescuable by ANY
   *     reordering (5 were NOT-RETRIEVED, which no reorder can fix), and it
   *     rescued neither.
   *   • COST: +1,801ms per call on a leg whose control p50 is ~40-240ms and
   *     whose entire bound is 2,000ms — charged to EVERY turn's prompt build.
   *
   * Kept as a re-measurable seam rather than deleted, for the same reason
   * `anchorDfBudget` keeps its: the cost side is an engine property, so if the
   * reranker gets an order of magnitude cheaper this becomes worth re-running
   * rather than re-deriving. Re-measure with:
   *   --mode none --ceiling --rerank-arms
   *
   * ⚠ A rerank is a REORDER, so it CANNOT change how many lines are admitted —
   * an acceptance measured on line counts produces a confident null (D-066).
   * Both arms must be answer-bearing.
   */
  rerank?: boolean;
}

/**
 * WHY the leg ended where it did. `lines: []` alone is five different states
 * wearing one face, and the most dangerous of them — the wall-clock bound
 * expiring — is indistinguishable from the most benign, "the corpus genuinely
 * had nothing". EI-19460902984682209: that ambiguity is what let every first
 * injection in a fresh process return an empty block for its whole life
 * without anyone noticing.
 *
 * Only `'ok'` means the leg ran to completion, and even then `lines` may be
 * empty — that is the honest "nothing relevant".
 */
export type CorpusRecallOutcome =
  /** The leg ran to completion. `lines` may still be empty. */
  | 'ok'
  /** `corpusRecallTimeoutMs` expired. NOT evidence that the corpus is empty. */
  | 'timed-out'
  /** The kill-switch flag is off, or no in-scope source is registered. */
  | 'disabled'
  /** Nothing searchable in the input text. */
  | 'no-query'
  /** The leg threw (PG down, engine error). Best-effort, never rethrown. */
  | 'failed';

/**
 * Did the P-008 stage-1 rerank run, and if not, why not?
 *
 * Every non-`'reranked'` value produces the SAME observable output — the RRF
 * order — which is why this needs its own field rather than a boolean: the
 * states call for opposite responses. `'off'` is a deliberate control;
 * `'no-engine'` is a misconfigured host; `'failed'` is a bug or a sick engine.
 * Collapsing them loses the ability to tell "the experiment was not run" from
 * "the experiment ran and found nothing".
 */
export type CorpusRerankOutcome =
  /** An engine resolved and scored the pool. The ONLY value that licenses an A/B. */
  | 'reranked'
  /** The flag (or the caller's explicit `rerank: false`) held it off. */
  | 'off'
  /** No hosted key and the local engine is flagged off — the pre-P-007 dark seam. */
  | 'no-engine'
  /** The stage threw or its bound expired. Fail-soft: RRF order was kept. */
  | 'failed'
  /** Fewer than 2 candidates — a reorder is vacuous, so no engine was resolved. */
  | 'nothing-to-reorder';

export interface CorpusRecallResult {
  /** The rendered markdown section, or null when nothing was admitted. */
  block: string | null;
  lines: CorpusLine[];
  dropped: CorpusDrop[];
  /** False ⇒ the search ran BM25-only (no query vector). */
  embedderAvailable: boolean;
  /** Candidates the engine returned, before pure-core selection. */
  candidateCount: number;
  /** Why the leg ended here — see `CorpusRecallOutcome`. Read this before
   *  concluding anything from an empty `lines`. */
  outcome: CorpusRecallOutcome;
  /**
   * P-008 — did the stage-1 cross-encoder rerank actually run?
   *
   * ⚠ REQUIRED READING FOR ANY A/B ON THIS LEG. The rerank is fail-soft: with no
   * engine it returns the RRF order untouched, which is BYTE-IDENTICAL to what a
   * `rerank: false` control arm produces. So a treatment arm that quietly lost
   * its engine yields a clean, confident NULL that reads as "reranking does not
   * help" — and the natural response to that null is to abandon the feature.
   * Assert `'reranked'` on the treatment arm before believing any comparison,
   * exactly as this leg's benches already assert `embedderAvailable` before
   * believing a BM25-vs-hybrid one.
   */
  rerank: CorpusRerankOutcome;
  /**
   * P-003 — the engine's per-leg execution report for the search that produced
   * `lines`, or null when the leg never reached fusion.
   *
   * Threaded for the same reason P-001 threaded `embedderAvailable`, and it is
   * the STRONGER of the two signals: `embedderAvailable` only says a query
   * vector was produced, which stays true when every per-source embedding query
   * fails and when a leg runs perfectly but returns nothing. `legs.lexical`
   * additionally answers "did the term leg contribute anything to this fusion",
   * which is what separates a degraded section from an unearned one.
   */
  legs: SearchLegs | null;
  /**
   * Candidates asked of the engine (the over-fetch depth). The coverage gate
   * derives its near-empty floor from this rather than from a constant — an
   * index holding fewer vectors than the leg over-fetches cannot rank
   * selectively, whatever its coverage percentage says.
   */
  retrievalDepth: number;
}

const empty = (outcome: CorpusRecallOutcome): CorpusRecallResult => ({
  block: null,
  lines: [],
  dropped: [],
  embedderAvailable: false,
  candidateCount: 0,
  outcome,
  // The leg never reached fusion, so there is no leg report to give. `null` says
  // that; `emptyLegs()` would say "every leg ran and found nothing", which is a
  // different — and here false — claim.
  legs: null,
  retrievalDepth: 0,
  // The leg never reached stage 1. Same reasoning as `legs: null` above —
  // `'off'` would claim a deliberate control arm, which is a different (and here
  // false) statement about why no reranking happened.
  rerank: 'nothing-to-reorder',
});

type QueryEmbedder = (text: string, signal?: AbortSignal) => Promise<number[]>;

export interface CorpusEmbedderWarmupOptions {
  /** Override the short request acquisition budget for boot/background work. */
  acquireBudgetMs?: number;
}

/** Warm state for the query embedder. Module-scoped on purpose: the cost being
 *  avoided is per-PROCESS, not per-call. */
let warmEmbedder: QueryEmbedder | null = null;
let warmupInFlight: Promise<boolean> | null = null;

/**
 * Acquire + prime the query embedder OFF the critical path, and resolve when
 * it is genuinely usable. Idempotent; safe to call on every request.
 *
 * ⚠ THE FIX FOR EI-19460902984682209 — read before "simplifying" this back
 * into an inline `await buildQueryEmbedder(...)` inside the leg.
 *
 * This leg's ENTIRE wall-clock bound is 2s (`corpusRecallTimeoutMs`). Measured
 * 2026-08-03 on this box, a cold embedder costs ~1374ms to ACQUIRE and a
 * further ~2222ms for its FIRST embed — ~3.6s, comfortably past the whole
 * budget. Awaiting acquisition inline spent 60%+ of the leg's deadline merely
 * DISCOVERING the embedder was not ready, leaving under 800ms for the ~1.2s
 * search it was supposed to be degrading to. So the leg timed out and returned
 * EMPTY — the one outcome indistinguishable from "nothing relevant" — on the
 * first call of every fresh process, for its whole life.
 *
 * The header of this file already promised the right behaviour ("a COLD
 * embedder ... must degrade to BM25-only rather than stall the turn"); the bug
 * was that the DISCOVERY was charged to the very budget the degradation exists
 * to protect. So a request uses the embedder only when it is ALREADY warm, and
 * otherwise runs BM25-only immediately and leaves the warmup to finish behind
 * it. Single-variable measurement, same 2s bound: cold call 2003ms/0 lines →
 * 1197ms/6 lines, and those 6 lines are byte-identical to the warm hybrid
 * result (this corpus's motivating retrieval is lexical — see
 * `corpusEmbedBudgetMs`).
 *
 * A failed acquisition never latches: `warmupInFlight` is cleared so a later
 * call retries, matching the rest of this file's fail-soft posture.
 */
export function warmCorpusEmbedder(opts: CorpusEmbedderWarmupOptions = {}): Promise<boolean> {
  const started = (warmupInFlight ??= (async () => {
    try {
      const built = (await buildQueryEmbedder({
        acquireBudgetMs: opts.acquireBudgetMs ?? corpusEmbedBudgetMs(),
      })) as QueryEmbedder | null;
      if (!built) {
        warmupInFlight = null;
        return false;
      }
      // Pay the cold ONNX/pipeline embed HERE rather than on a turn.
      await built('corpus recall embedder warmup');
      warmEmbedder = built;
      return true;
    } catch {
      warmupInFlight = null;
      return false;
    }
  })());
  return started;
}

/** Test seam: drop the process-wide warm state so a suite can exercise both
 *  the cold (BM25-only) and warm (hybrid) paths deterministically. */
export function resetCorpusEmbedderWarmup(): void {
  warmEmbedder = null;
  warmupInFlight = null;
}

/** Is the corpus leg enabled? Default ON — a finished, tested retrieval leg
 *  that ships dark is dead code. OFF is the clean kill-switch. */
async function corpusRecallEnabled(): Promise<boolean> {
  try {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    return await getFlag(FLAGS.MEMORY_CORPUS_RECALL, 'memory-corpus-recall');
  } catch {
    // A flags hiccup must not silently disable a default-ON feature.
    return true;
  }
}

/** Engine rows → the pure core's hit shape. */
function toCorpusHits(fused: { results: readonly SearchHit[] }): CorpusHit[] {
  return fused.results.map((r) => ({
    source: r.source,
    sourceId: r.source_id,
    scope: r.scope ?? null,
    excerpt: r.excerpt ?? '',
    highlight: r.highlight ?? null,
    score: r.score,
    ts: r.ts ?? null,
    rankers: r.rankers,
    // P-003/P-004: the work_item source stamps the engine-opaque `meta` bag with
    // the row's lane, because `source: 'work_item'` covers BOTH the curated lane
    // and the observation lane (56.7% of that relation). Absent ⇒ null ⇒ read as a
    // work-item downstream. See WORK_ITEM_LANE_NOTE in agent-tools/search/sources.ts.
    lane: r.meta?.lane ?? null,
  }));
}

/**
 * The text the cross-encoder scores against the query.
 *
 * Mirrors `rerankText` for `SearchHit` and for the same reason: `excerpt` is
 * `trunc(body)` — the document's first 200 chars — while the MATCH-CENTRED text
 * is in `highlight`. Scoring the excerpt asks "is this document's OPENING about
 * the query?", which silently demotes exactly the long documents a reranker is
 * most useful for. Both fields are already on every `CorpusHit`, so this costs
 * no extra retrieval.
 */
function corpusRerankText(hit: CorpusHit): string {
  const highlight = (hit.highlight ?? '').replace(/<\/?mark>/g, '').trim();
  const excerpt = (hit.excerpt ?? '').trim();
  if (!highlight) return excerpt;
  if (!excerpt || highlight.includes(excerpt) || excerpt.includes(highlight)) return highlight;
  return `${highlight} … ${excerpt}`;
}

/**
 * P-008 — stage-1 cross-encoder rerank of the over-fetched candidate pool.
 *
 * WHY IT SITS HERE, before `selectCorpusLines` rather than after: selection
 * takes a hard cut at `maxItems` (6) over a pool of `retrievalDepth` (24). An
 * interactive searcher scans a page and picks; this leg picks FOR the agent, so
 * the order handed to `select` IS what survives the budget. Measured
 * (bench/corpus-rerank-reach-cli.ts, post-P-024): on the 48/120 multi-tier
 * queries an upstream reorder moves the admitted top-1 65.0% of the time, null
 * control 0/120 — so the reranker genuinely reaches the page rather than being
 * absorbed by the scale-free agreement key (D-091 §1, which RETRACTED the
 * standing reach-ceiling objection).
 *
 * ⚠⚠ IT REORDERS ALL `hits` AND CUTS NOTHING — `limit: hits.length`, not
 * `maxItems`. Slicing to the page here would defeat the entire point twice
 * over: the reranker could no longer pull a buried hit INTO the page, AND
 * `selectCorpusLines` would be starved. Selection drops self-session echoes,
 * out-of-scope work-items, no-overlap hits and duplicate refs BEFORE its cap,
 * which is exactly why `retrievalDepth` over-fetches 4× (see :372). Handing it 6
 * pre-cut rows would routinely admit FEWER than 6 lines — a reorder that
 * silently becomes a truncation.
 *
 * Fail-soft in the leg's own idiom: any failure returns the input order
 * untouched. Bounded by `corpusRerankTimeoutMs()`, which is strictly below the
 * leg's own bound so a slow rerank costs the ORDER and never the section.
 */
async function rerankStage1(
  hits: CorpusHit[],
  queryUsed: string,
  override: boolean | undefined,
): Promise<{ hits: CorpusHit[]; outcome: CorpusRerankOutcome }> {
  // Nothing to reorder → no engine resolution, no import.
  if (hits.length <= 1) return { hits, outcome: 'nothing-to-reorder' };
  // DEFAULT OFF — measured, not adopted (D-093). Not a flag: an unadopted
  // feature behind a runtime flag is dead code waiting to be flipped by someone
  // who has not read the measurement. This is a bench seam, exactly like
  // `anchorDfBudget`, whose default is likewise pinned to the control arm
  // because the widening measured neutral.
  if (override !== true) return { hits, outcome: 'off' };
  let outcome: CorpusRerankOutcome = 'failed';
  const ordered = await rerankRows<CorpusHit>(queryUsed, hits, {
    // Reorder the whole pool; the cut belongs to `selectCorpusLines`.
    limit: hits.length,
    id: (h) => `${h.source}:${h.sourceId}`,
    text: corpusRerankText,
    // Within a rerank-score bucket, keep the higher fused hit first.
    qualityScore: (h) => h.score,
    rerankTimeoutMs: corpusRerankTimeoutMs(),
    onOutcome: (o) => {
      outcome = o.attempted ? 'reranked' : o.reason === 'no-engine' ? 'no-engine' : 'failed';
    },
  });
  return { hits: ordered, outcome };
}

/**
 * Run the corpus leg and return its rendered pointer section.
 *
 * Best-effort in exactly the way the rest of the injection path is: any
 * failure — PG down, embedder missing, search throwing, flag read failing —
 * returns an empty result and the caller's prompt is unaffected. Never throws.
 */
export async function recallCorpusContext(input: CorpusRecallInput): Promise<CorpusRecallResult> {
  const deadline = createMemoryWorkDeadline(corpusRecallTimeoutMs(), input.signal);
  try {
    return await deadline.run(() => recallCorpusContextInner({ ...input, signal: deadline.signal }), 'corpus recall');
  } catch (error) {
    if (deadline.signal.aborted || error instanceof MemoryTimeoutError) return empty('timed-out');
    throw error;
  } finally { deadline.close(); }
}

async function recallCorpusContextInner(
  input: CorpusRecallInput,
): Promise<CorpusRecallResult> {
  const rawText = input.queryText?.trim() ?? '';
  if (!rawText) return empty('no-query');
  // The engine ANDs every lexeme (plainto_tsquery) and the injected text is the
  // raw prompt envelope — median 1000 chars at turn-start — so the raw text
  // must NEVER reach the engine. See corpusQueryText for the measurements.
  //
  // Derived TWICE on purpose. This first pass is the length-ordered form, used
  // only for the "nothing searchable at all" early-out below — it needs no
  // database, so the cheap exit stays cheap. The BANDED form (P-018/D-064)
  // needs a DF lookup and is derived inside the try, where `sql` exists.
  const queryText = corpusQueryText(rawText);
  if (!queryText) return empty('no-query');
  if (!input.skipFlagCheck && !(await corpusRecallEnabled())) return empty('disabled');
  input.signal?.throwIfAborted();

  const maxItems = input.maxItems ?? CORPUS_MAX_ITEMS;
  const gradedMaxTerms = input.gradedMaxTerms ?? CORPUS_GRADED_QUERY_MAX_TERMS;
  const sources = SEARCH_SOURCES.filter((s) =>
    (CORPUS_SOURCE_NAMES as readonly string[]).includes(s.name),
  );
  // Nothing registered to read — the leg is off by configuration, not empty.
  if (sources.length === 0) return empty('disabled');

  const budgetChars = input.budgetChars ?? CORPUS_BUDGET_CHARS;
  // Over-fetch depth: the pure core drops self-session echoes, out-of-scope
  // work-items, no-overlap hits and duplicate refs before the cap.
  //
  // Named once and returned, because P-003's coverage gate derives its
  // near-empty floor from this exact number: a vector index holding fewer rows
  // than the leg over-fetches returns essentially all of itself for any query,
  // so its "nearest neighbours" carry no selectivity. Deriving the floor from
  // the caller rather than hard-coding one in the gate means the two cannot
  // drift apart when this over-fetch is retuned.
  const retrievalDepth = Math.max(maxItems * 4, 8);

  // Declared out here so the RESULT can report it even though the stage runs
  // deep inside `run`. Defaults to the honest "we never got there": every early
  // return below leaves the leg short of stage 1.
  let rerankOutcome: CorpusRerankOutcome = 'nothing-to-reorder';

  try {
    const { sql } = getOrgPg();
    const embedBudget = corpusEmbedBudgetMs();
    const run = (async () => {
      // ⛔ BANDED term selection (P-018 / D-064) IS UNWIRED — it was MEASURED WORSE
      // and reverted the same day (D-066). Do not re-wire it without reading that
      // decision; the shape of the mistake is subtle and it looked like a win.
      //
      // WHAT WAS SHIPPED: pick the RAREST terms the corpus actually attests
      // (df >= 2), instead of the two longest. It raised admitted lines/query
      // 4.28 -> 4.73 (+0.46), which is why it read as a win.
      //
      // WHAT THE ACCEPTANCE CASE SAID: on the WI-6512 known-item replay, run
      // through THIS leg with both arms back-to-back against the same live
      // corpus, answer-bearing batches went 2/7 (length) -> 0/7 (banded).
      // More lines, and none of them the answer. The two metrics moved in
      // OPPOSITE directions, so the line count alone could never have caught it.
      //
      // WHY: the band fixed UNRETRIEVABLE (df<2 hapaxes match nothing) and left
      // IRRELEVANT untouched. Inside the attested band, "rarest" still means
      // "most incidental" — it chose `pretty` out of pg_size_pretty, `buffers`
      // out of EXPLAIN BUFFERS, `speaker` out of a column list, `components` out
      // of a path. Those DO match documents, which is exactly why the line count
      // rose; they just match the wrong ones. Rarity is a WEIGHT for documents
      // that already matched, never a SELECTOR for the query.
      //
      // The DF signal, its table and its refresh routine are all kept: the
      // redesign needs the signal, just not as a pure rarity ranker.
      const effectiveQuery = queryText;
      // Already-warm ONLY — never await acquisition here. See
      // `warmCorpusEmbedder` for the measurements behind that
      // (EI-19460902984682209); a cold process runs BM25-only and warms behind
      // this request instead of timing the whole leg out.
      const built = warmEmbedder;
      if (!built) void warmCorpusEmbedder();
      // The cascade can run the engine TWICE on the same query text, and the
      // query vector depends only on that text — memoise so the second stage
      // reuses the first stage's embedding instead of paying for it again.
      let embedP: Promise<number[]> | null = null;
      const embedder = built
        ? (t: string, signal?: AbortSignal) => (embedP ??= built(t, signal))
        : built;
      if (built && embedder) {
        const mode = embedderModeOf(built);
        const profileId = embedderProfileIdOf(built);
        if (mode) stampEmbedderMode(embedder, mode, profileId);
        // Search's storage-space filter and score policy key off the exact
        // embedder function object. Memoizing it above creates a new function,
        // so preserve that identity before handing the wrapper to the engine.
        // Otherwise the semantic SQL fails closed with zero candidates while
        // the call still reports that both semantic sources ran.
        if (
          embedderModeOf(embedder) !== mode ||
          embedderProfileIdOf(embedder) !== profileId
        ) {
          throw new Error('corpus recall memo wrapper lost embedder profile provenance');
        }
      }

      // Stage 2's query is derived SEPARATELY from stage 1's — see
      // CORPUS_GRADED_QUERY_MAX_TERMS. Stage 1 ANDs, so two terms is a
      // selectivity floor it cannot exceed; stage 2 grades by coverage, so the
      // same cap leaves it nearly nothing to rank with. Falls back to the
      // stage-1 text if the wider derivation yields nothing.
      const gradedQuery = corpusQueryText(rawText, gradedMaxTerms) || effectiveQuery;

      const search = (lexicalMode: 'and' | 'coverage-graded', queryFor: string) => {
        input.signal?.throwIfAborted();
        return runHybridSearch(sources, {
          signal: input.signal,
          caller: 'midturn:related-context',
          sql,
          query: queryFor,
          workspaceId: input.workspaceId,
          // MUST stay null: 99.993% of session turns carry harness_slug IS NULL,
          // so a slug scopeFilter would make this leg structurally empty while
          // looking healthy. Work-item scoping happens in the pure core instead.
          scopeFilter: null,
          // Over-fetch: the pure core drops self-session echoes, out-of-scope
          // work-items, no-overlap hits and duplicate refs before the cap.
          limit: retrievalDepth,
          mode: 'hybrid',
          embedder,
          embedTimeoutMs: embedBudget,
          // Highlights ARE used — the teaser and the relevance guard both read the
          // match fragment rather than the body lead. Deferring means the engine
          // hydrates them for the final top-N only, instead of paying ts_headline
          // across the whole limit*3 over-fetch pool.
          deferHighlight: true,
          // P-009 / D-001 — the recency term. It is a monotone RE-ORDER of an
          // existing ranking and compares nothing against an absolute scale,
          // which D-001 records as the reason it is compatible with a
          // rank-derived fusion: an absolute constant compared against a FUSED
          // RRF value would be meaningless, a reordering of one is not.
          //
          // ⚠ This used to read "D-037 forbids an absolute score FLOOR on this
          // leg". Both halves were wrong (D-097). D-037 lives on plan
          // context-injection-audit-2026-07-28 and forbids no such thing — its
          // only "floor" is the phrase "evict a floor-passing memory", about
          // mem0 POOL floors. And this leg IS floored: it passes no `minScore`,
          // so `resolveSearchDefaults` supplies the registered engine default
          // (`search/configure-search-defaults.ts`, reached via the side-effect
          // import in `agent-tools/search/sources.ts`) — measured live as
          // `{ embeddings: 0.45 }`, because `buildQueryEmbedder` hands back a
          // gemma-STAMPED instance and this file stores it unwrapped.
          //
          // That floor is currently INERT here, and the reason is worth
          // keeping: gemma carries a large positive cosine offset on this
          // corpus (two RANDOM UNRELATED session_turns average .6119, n=16,110
          // — see search/prose-min-score.ts), so a .45 cut sits ~0.16 BELOW the
          // noise mean and rejected 0 of 2,161 candidates across a warm 10-query
          // run, off-domain arm included. Do NOT "fix" that by raising it: the
          // in/off-domain tails overlap by measurement, so no absolute cut
          // separates them, and .45 also lands on the `work_item` source, which
          // was never calibrated for it (D-097 §3).
          //
          // `getTime` is left at its default (`hit.ts`) — both corpus sources
          // now populate it. See WORK_ITEM_RECENCY_NOTE in search/sources.ts for
          // why the work_item projection had to land FIRST: a missing timestamp
          // scores as decay 0 (oldest), so enabling this over a blind leg would
          // have demoted 36.6% of the section for being unmeasurable.
          //
          // `freshWindowMs` is deliberately NOT set. It adds a second BM25 leg
          // over a time window, which both widens the query cost on a path with
          // a hard latency budget and labels its hits `lexical-fresh` — one
          // ranker counted twice by any agreement measure. Revisit separately.
          recency: { halfLifeMs: CORPUS_RECENCY_HALF_LIFE_MS, weight: CORPUS_RECENCY_WEIGHT },
          lexicalMode,
          // Only when the caller set it — 0 is meaningful (argmin-only), so the
          // test is against undefined, not truthiness.
          ...(input.anchorDfBudget === undefined
            ? {}
            : { lexicalAnchorDfBudget: input.anchorDfBudget }),
        });
      };

      // Which of these hits' sessions belong to the CALLER (EI-19460887729945170)?
      //
      // Resolved from the candidates rather than from the owner, deliberately:
      // "every session this owner has ever had" grows without bound over a long
      // life, while the candidate pool is `limit` rows by construction — so this
      // stays one indexed lookup of ~24 ids no matter how long the agent has been
      // running. Memoised across the cascade's two stages so stage 2 only asks
      // about ids stage 1 did not already settle.
      //
      // Fail-soft, like every other step on this path: a lookup that throws
      // yields no exclusions, which is exactly today's behaviour — never a
      // broken leg.
      const ownSession = new Map<string, boolean>();
      const ownSessionIdsAmong = async (hits: readonly CorpusHit[]): Promise<Set<string>> => {
        input.signal?.throwIfAborted();
        const owner = input.excludeOwnerId?.trim();
        const mine = new Set<string>();
        if (!owner) return mine;
        const unknown: string[] = [];
        for (const hit of hits) {
          const sid = sessionIdOfHit(hit);
          if (!sid) continue;
          const cached = ownSession.get(sid);
          if (cached === undefined) unknown.push(sid);
          else if (cached) mine.add(sid);
        }
        if (unknown.length === 0) return mine;
        try {
          const rows = (await sql`
            SELECT DISTINCT session_id
              FROM harness_shared.session_turns
             WHERE owner = ${owner}
               AND session_id = ANY(${unknown}::text[])
          `) as unknown as Array<{ session_id: string }>;
          const owned = new Set(rows.map((r) => r.session_id));
          for (const sid of unknown) ownSession.set(sid, owned.has(sid));
          for (const sid of owned) mine.add(sid);
        } catch {
          /* no exclusion beats a dead leg */
        }
        return mine;
      };

      // One clock for both cascade stages keeps labels stable when stage 2 runs.
      const renderNow = Date.now();

      const select = async (
        hits: CorpusHit[],
        // MUST be the query that RETRIEVED these hits — per stage, not per leg.
        // `selectCorpusLines` applies a term-overlap guard, so judging hits
        // against a query that was never issued drops rows the issuing query
        // legitimately retrieved, as `no-term-overlap`.
        //
        // This was a leg-wide constant until WI-9273 and it silently neutralised
        // the whole stage-2 widening: the graded stage retrieved on its own
        // (wider) query, then had its hits judged against stage 1's two terms,
        // so every row the widening found was discarded before it could be
        // admitted. The arms came back byte-identical — a FALSE NULL that reads
        // exactly like "widening is not the lever".
        queryUsed: string,
        opts: { maxItems: number; budgetChars: number; knownRefs: ReadonlySet<string> },
      ) =>
        selectCorpusLines({
          hits,
          queryText: queryUsed,
          excludeSessionIds: await ownSessionIdsAmong(hits),
          harnessSlugs: input.harnessSlugs ?? [],
          declaredWorkItemId: input.declaredWorkItemId,
          ambientExcludedRefs: input.ambientExcludedRefs,
          knownRefs: opts.knownRefs,
          maxItems: opts.maxItems,
          budgetChars: opts.budgetChars,
          now: renderNow,
        });

      // ── Stage 1: today's AND query, unchanged. ──
      const andFused = await search('and', effectiveQuery);
      input.signal?.throwIfAborted();
      const stage1Rerank = await rerankStage1(
        toCorpusHits(andFused),
        effectiveQuery,
        input.rerank,
      );
      const andHits = stage1Rerank.hits;
      rerankOutcome = stage1Rerank.outcome;
      const known = input.knownRefs ?? new Set<string>();
      const stage1 = await select(andHits, effectiveQuery, { maxItems, budgetChars, knownRefs: known });
      input.signal?.throwIfAborted();

      // ── Stage 2 (P-017 / D-062 R2): relax ONLY when stage 1 under-fills. ──
      //
      // ⚠ THE TWO-STAGE SHAPE IS LOAD-BEARING — a single coverage-graded query
      // is NOT a no-op-or-better substitute for it, and the obvious "it is a
      // strict superset, so one query suffices" argument is FALSE at this level.
      // `graded ⊇ and` holds per-source in SQL, but this leg merges two sources
      // and then applies an overlap guard, a 6-item cap and an 1800-char budget
      // over a REORDERED walk — so grading alone evicts lines the AND query used
      // to admit. Measured live over 120 real turns: 180 admitted lines lost
      // across 79/120 queries, 18 of them the control's top-1, while the mean
      // admitted count stayed FLAT at 4.33. It was a swap, not an addition.
      //
      // Running stage 2 against the REMAINING cap and budget, with stage 1's
      // refs already marked known, makes the result additive by construction:
      // stage 1's lines are computed first and never revisited, so the admitted
      // set can only grow. `bench/corpus-leg-lexical-acceptance-cli.ts` asserts
      // exactly that (admitted-containment violations must be 0).
      if (stage1.lines.length >= maxItems) {
        return { lines: stage1.lines, dropped: stage1.dropped, fused: andFused, count: andHits.length };
      }

      const spent = stage1.lines.reduce((n, l) => n + l.line.length, 0);
      const gradedFused = await search('coverage-graded', gradedQuery);
      input.signal?.throwIfAborted();
      const seen = new Set(andHits.map((h) => `${h.source}:${h.sourceId}`));
      const gradedOnly = toCorpusHits(gradedFused).filter(
        (h) => !seen.has(`${h.source}:${h.sourceId}`),
      );
      const stage2 = await select(gradedOnly, gradedQuery, {
        maxItems: maxItems - stage1.lines.length,
        budgetChars: budgetChars - spent,
        knownRefs: new Set([...known, ...stage1.lines.map((l) => l.handle.ref)]),
      });

      return {
        lines: [...stage1.lines, ...stage2.lines],
        dropped: [...stage1.dropped, ...stage2.dropped],
        fused: gradedFused,
        count: andHits.length + gradedOnly.length,
      };
    })();

    const out = await run;
    // The bound expired. This is NOT "the corpus had nothing" — say so, so a
    // caller (and any benchmark) can tell the two apart (EI-19460902984682209).
    if (!out) return { ...empty('timed-out'), rerank: rerankOutcome };

    return {
      block: renderCorpusBlock(out.lines),
      lines: out.lines,
      dropped: out.dropped,
      embedderAvailable: out.fused.embedderAvailable,
      candidateCount: out.count,
      outcome: 'ok',
      rerank: rerankOutcome,
      // The LAST search's report. The cascade can run the engine twice, and it
      // is stage 2 (when it runs) that produced the final admitted set, so its
      // leg accounting is the one that describes this result.
      legs: out.fused.legs,
      retrievalDepth,
    };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[memory-corpus-recall] failed:', (err as Error).message);
    }
    return empty('failed');
  }
}
