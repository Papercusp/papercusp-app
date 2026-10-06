/**
 * @papercusp/search-core — engine-agnostic search-relevance core.
 *
 * The valuable two-stage relevance logic built on top of @papercusp/rerank's
 * cross-encoder primitive: instruction-following steering, a live LLM
 * category-match pass, brand-aware query rewrite, the tiered-escalation gate,
 * and the shared eval-harness metric contract. NO project deps (Typesense, PG,
 * catalog schema, brand source) — those are injected as config/callbacks — so
 * both Restart and Papercusp consume the same relevance behavior.
 *
 * Contract mirror of @papercusp/rerank: {query, docs:[{id,text,row}], opts} →
 * ordered rows, just with more stages. Fail-safe throughout.
 */

// §1d instruction template
export { DEFAULT_RERANK_INSTRUCTION } from './instruction';

// §1c rerank-document builder
export { buildRerankDoc, type RerankDocMode, type RerankDocFields } from './doc';

// Phase 4 brand-aware query rewrite
export { rewriteQuery, clearRewriteCache, defaultRewritePrompt, type RewriteQueryOptions } from './rewrite';

// §1e live LLM category-match rerank
export { llmRerank, defaultLlmRerankPrompt, type LlmRerankOptions } from './llm-rerank';

// §5 tiered-escalation gate
export { shouldEscalate, type EscalationOptions } from './escalation';

// Shared eval-harness metric contract
export { dcg, ndcg, ndcgAtK, precisionAtK, accessoryAtK } from './metrics';

// Eval harness over those metrics. `recallAtK` lives HERE, not in metrics.ts,
// because unlike every metric there it cannot be computed from the ranking
// alone — it needs an externally-known relevant set. That is also why the
// metrics above cannot see a MISS, and why this module exists.
export {
  evaluateRelevance,
  assertRelevance,
  recallAtK,
  type RelevanceEvalCoverage,
  type RelevanceGroundTruth,
  type RelevanceEvalInput,
  type RelevanceEvalResult,
  type RelevanceFloor,
  type RelevanceAssertion,
} from './relevance-eval';

// Two-stage orchestrator
export { rankWithReranker, type RankDoc, type RankWithRerankerOptions } from './rank';

// Chunking retrieval bench: rank-based past-the-window gain and short-row
// demotion, with the corpus, splitters and embedder injected.
export {
  runChunkingBench,
  decideChunking,
  drawTailProbe,
  drawShortProbe,
  isDistinctiveProbe,
  rankKeys,
  summarizeRankings,
  pooledScore,
  cosine,
  type BenchEmbed,
  type BenchEmbedKind,
  type BenchRow,
  type BenchSplitter,
  type BenchProbe,
  type BenchFold,
  type ProbeClass,
  type TailProbeOptions,
  type ChunkingBenchInput,
  type ChunkingBenchResult,
  type ArmResult,
  type ArmClassResult,
  type RankSummary,
  type SplitterStats,
  type ChunkingDecisionRule,
  type ChunkingDecision,
} from './retrieval-bench';

// Width sweep — rank-based recall of text past an embed-prefix cut, per width (moved from
// papercusp's turn-truncation-width instrument; corpus and embedder injected).
export {
  runWidthSweep,
  type WidthSweepDoc,
  type WidthSweepChunkArm,
  type WidthSweepInput,
  type WidthSweepArm,
  type WidthSweepResult,
} from './width-sweep';
