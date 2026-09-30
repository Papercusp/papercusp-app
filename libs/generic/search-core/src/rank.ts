/**
 * The two-stage relevance orchestrator — the headline value of search-core.
 *
 * Same contract as @papercusp/rerank ({query, docs:[{id,text,row}], opts} →
 * ordered rows), just more stages:
 *   1. instruction-following cross-encoder rerank (zerank-2 via @papercusp/rerank)
 *   2. bucket scores (so genuine relevance leads) + a completeness tiebreak
 *   3. tiered-escalation gate (§5)
 *   4. live LLM category-match pass (§1e) over a kept window
 *   5. slice to `limit`
 *
 * Engine/project-agnostic: the caller supplies the doc text (see buildRerankDoc),
 * the per-row `qualityScore` tiebreak, the `getTitle` for the LLM pass, and the
 * gate flags. Fail-safe throughout — a rerank or LLM outage degrades to
 * retrieval order, never an error.
 */
import { rerank, type RerankDegradeReason, type RerankEngine } from '@papercusp/rerank';
import { shouldEscalate, type EscalationOptions } from './escalation';
import { llmRerank, type LlmRerankOptions } from './llm-rerank';

export interface RankDoc<T> {
  /** Stable id (for caching / debugging). */
  id: string;
  /** The text the cross-encoder scores against the query (see buildRerankDoc). */
  text: string;
  /** Caller's payload, carried through untouched. */
  row: T;
}

export interface RankWithRerankerOptions<T> {
  /** Final page size. */
  limit: number;
  /** Instruction-following steering for the reranker; omit for a plain rerank. */
  instruction?: string;
  /** Reranker model. Default @papercusp/rerank's default (zerank-2). */
  rerankModel?: string;
  /** Reranker API key. Default ZEROENTROPY_API_KEY (handled by @papercusp/rerank). */
  rerankApiKey?: string;
  /**
   * Which cross-encoder scores stage 1, forwarded to @papercusp/rerank:
   * `local` (an ONNX cross-encoder — no key, no network, no per-call cost) or
   * `zeroentropy` (the hosted zerank API). Default: the lib's default
   * (`zeroentropy`), so an existing consumer's behavior is unchanged.
   */
  engine?: RerankEngine;
  /**
   * Scoring override for `engine: 'local'` — returns scores index-aligned with
   * `docs`, and MAY throw.
   *
   * This is the seam a REMOTE local-model host (e.g. a sidecar process serving
   * one warm model for the whole box) reaches the stages below through, without
   * search-core learning anything about transport. A throw is caught by
   * @papercusp/rerank's single fail-safe seam, so a scorer outage degrades to
   * retrieval order exactly like a missing runtime does.
   */
  scorer?: (query: string, texts: string[]) => Promise<number[]>;
  /**
   * Wall-clock bound on stage-1 scoring, forwarded to @papercusp/rerank. On
   * expiry the rerank degrades to retrieval order through that library's single
   * fail-safe seam — same path as an engine outage, so it never throws.
   *
   * Default: the library's backstop (20s), which is sized to catch a HANG, not
   * to meet a latency contract. A user-facing caller should pass its own,
   * much tighter budget.
   */
  rerankTimeoutMs?: number;
  /**
   * Window kept after the rerank so the LLM pass can pull a buried product up
   * into the page and push accessories out. Default max(limit, 15).
   */
  window?: number;
  /**
   * Score bucketing granularity: scores are bucketed to `round(score * bucket)`
   * so near-equal relevance ties break on `qualityScore`. Default 20 (0.05 buckets).
   */
  scoreBucket?: number;
  /** Per-row completeness tiebreak (higher = better), applied only within a bucket. */
  qualityScore?: (row: T) => number;
  /** §5 tiered-escalation config. Omit → always escalate (LLM runs every query). */
  escalation?: EscalationOptions;
  /** Live LLM category-match pass (§1e). Omit to skip it entirely. */
  llm?: LlmRerankOptions<T>;
  /**
   * Observe whether stage 1 actually RANKED anything. Called exactly once per
   * invocation, immediately after the rerank, on every path.
   *
   * `scored: 0` means the cross-encoder scored nothing and this call returned
   * RETRIEVAL ORDER — behaviourally identical to a caller with no reranker at
   * all, and (WI-37670) invisible from the returned rows, which carry no
   * provenance. `degradeReason` names WHY, straight from @papercusp/rerank's
   * single fail-safe seam: notably `'timeout'` (the stage was too slow for
   * `rerankTimeoutMs`) vs `'scoring-failed'` (the engine could not score).
   *
   * Measured 2026-08-10 on the WI-37653 bench: 238/238 queries returned
   * retrieval order with no signal anywhere, because four concurrent calls
   * serialize on ONE inference thread and each one's wall clock is therefore
   * ~4x its own compute — well past a budget sized against a single call.
   */
  onRerankStage?: (info: {
    /** Rows the cross-encoder scored. 0 ⇒ this call returned retrieval order. */
    scored: number;
    /** Rows handed to it. */
    total: number;
    /** Present only when the fail-safe passthrough fired. */
    degradeReason?: RerankDegradeReason;
  }) => void;
  /**
   * Hand out stage 1's PER-ROW cross-encoder scores. Called exactly once,
   * immediately after the rerank and BEFORE the bucketing/windowing/slicing
   * below, so the values are the reranker's own output rather than an artefact
   * of shaping — the same reason {@link onRerankStage} is called there.
   *
   * This is the only way to observe those scores: `onRerankStage` reports
   * COUNTS, and the returned rows carry no provenance, so the one number in the
   * stack that is a true query↔document relevance MAGNITUDE is otherwise
   * discarded microseconds after it is computed. A caller wanting to THRESHOLD
   * on relevance needs it: a threshold on a fused retrieval score is a rank
   * cutoff in disguise, because RRF is rank-derived and its output is in
   * nobody's units.
   *
   * ⚠ `score` is `null` — never `0` — for a row the cross-encoder did not
   * score. @papercusp/rerank's degrade path returns `{ score: 0, reranked:
   * false }`, so a caller reading the raw number cannot distinguish "judged
   * irrelevant" from "never judged", and any floor computed over those zeros
   * silently counts every degraded row as maximally irrelevant. Normalising to
   * `null` here makes that distinction unmissable at the type level.
   */
  onRerankScores?: (rows: Array<{ row: T; score: number | null }>) => void;
}

export async function rankWithReranker<T>(
  query: string,
  docs: Array<RankDoc<T>>,
  opts: RankWithRerankerOptions<T>,
): Promise<T[]> {
  let degradeReason: RerankDegradeReason | undefined;
  const reranked = await rerank(query, docs, {
    instruction: opts.instruction,
    model: opts.rerankModel,
    apiKey: opts.rerankApiKey,
    engine: opts.engine,
    scorer: opts.scorer,
    timeoutMs: opts.rerankTimeoutMs,
    onDegrade: (reason) => {
      degradeReason = reason;
    },
  });
  // Report engagement BEFORE the shaping below, so the count is the reranker's
  // own output and not an artefact of windowing/slicing further down.
  opts.onRerankStage?.({
    scored: reranked.filter((r) => r.reranked).length,
    total: docs.length,
    ...(degradeReason ? { degradeReason } : {}),
  });
  // Same placement rationale, and `null` (not 0) for a row that was never
  // scored — see the field doc; the degrade path reports `score: 0`.
  opts.onRerankScores?.(reranked.map((r) => ({ row: r.row, score: r.reranked ? r.score : null })));

  const W = opts.window ?? Math.max(opts.limit, 15);
  const bucket = opts.scoreBucket ?? 20;
  const quality = opts.qualityScore ?? (() => 0);

  let ordered: T[];
  if (reranked.some((r) => r.reranked)) {
    // Bucket rerank scores so genuine relevance leads, then break ties by quality.
    ordered = reranked
      .map((r) => ({ row: r.row, b: Math.round((r.score ?? 0) * bucket), qs: quality(r.row) }))
      .sort((a, x) => x.b - a.b || x.qs - a.qs)
      .slice(0, W)
      .map((r) => r.row);
  } else {
    // Rerank unavailable → keep retrieval order.
    ordered = reranked.slice(0, W).map((r) => r.row);
  }

  const escalate = shouldEscalate(
    reranked.filter((r) => r.reranked).map((r) => r.score),
    opts.escalation,
  );
  if (escalate && opts.llm) ordered = await llmRerank(query, ordered, opts.llm);

  return ordered.slice(0, opts.limit);
}
