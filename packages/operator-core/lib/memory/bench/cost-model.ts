/**
 * Cost model for the memory-backend scorecard (memory-backend-benchmark
 * P-006, D-004): $/1k ops per backend, computed from measured op counts
 * and character volumes with documented public pricing. ESTIMATES, not
 * billing data — the methodology rides the report so the owner can
 * re-derive.
 *
 * Pricing (2026-06, public list):
 *   - OpenAI text-embedding-3-small: $0.02 / 1M tokens.
 *   - OpenAI gpt-4o-mini (mem0's extraction fallback): $0.15 / 1M input,
 *     $0.60 / 1M output.
 *   - Anthropic Haiku 4.5 (extraction when the key works): $0.80 / 1M
 *     input, $4 / 1M output (recorded for the report; the dev box
 *     currently extracts via gpt-4o-mini per D-007).
 * Token estimate: chars / 4 (the standard rough cut for English).
 */

export const OPENAI_EMBED_USD_PER_MTOK = 0.02;
export const GPT4O_MINI_IN_USD_PER_MTOK = 0.15;
export const GPT4O_MINI_OUT_USD_PER_MTOK = 0.6;

/** mem0's additive-extraction prompt overhead per add(), in tokens:
 *  the system prompt + ~10 nearby memories + instructions (measured
 *  order-of-magnitude from mem0ai 3.0.3's prompt assembly). */
export const MEM0_EXTRACTION_PROMPT_OVERHEAD_TOK = 1800;
/** Typical extraction completion size, tokens. */
export const MEM0_EXTRACTION_OUTPUT_TOK = 150;

export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

export interface CostInputs {
  /** Mean characters per remembered entry. */
  avgRememberChars: number;
  /** Mean characters per search query. */
  avgSearchChars: number;
  /** Does a remember() run LLM extraction (mem0's default path)? */
  extractionOnRemember: boolean;
  /**
   * Is that extraction METERED (a fallback API key) rather than
   * subscription-borne? Default false — the live path rides the Claude Code
   * OAuth SESSION (Haiku 4.5, direct to api.anthropic.com) at ~$0 marginal
   * (session-extraction-llm D-001 / D-005). Set true to estimate the
   * metered-key fallback rung (gpt-4o-mini, mem0's default) as the upper bound.
   */
  extractionMetered?: boolean;
  /** Does the backend embed at all (mem0 yes, file/noop no)? */
  embeds: boolean;
}

/** $ per 1k remember() calls. */
export function costPer1kRemembers(i: CostInputs): number {
  if (!i.embeds) return 0;
  const embed = tokensOf(i.avgRememberChars) * OPENAI_EMBED_USD_PER_MTOK;
  // Extraction rides the Claude subscription session by default (~$0 marginal);
  // only the metered-key FALLBACK rung incurs per-call $ (D-005). So a live
  // remember is embedding-only unless `extractionMetered` is explicitly set.
  const extraction = i.extractionOnRemember && i.extractionMetered
    ? (MEM0_EXTRACTION_PROMPT_OVERHEAD_TOK + tokensOf(i.avgRememberChars)) * GPT4O_MINI_IN_USD_PER_MTOK +
      MEM0_EXTRACTION_OUTPUT_TOK * GPT4O_MINI_OUT_USD_PER_MTOK
    : 0;
  return ((embed + extraction) / 1e6) * 1000;
}

/** $ per 1k search() calls (query embedding only). */
export function costPer1kSearches(i: CostInputs): number {
  if (!i.embeds) return 0;
  return ((tokensOf(i.avgSearchChars) * OPENAI_EMBED_USD_PER_MTOK) / 1e6) * 1000;
}

export const COST_METHODOLOGY =
  'Estimates from measured op counts × public list prices. Embeddings: text-embedding-3-small $0.02/MTok. ' +
  'Extraction rides the Claude Code OAuth SESSION (Haiku 4.5, direct to api.anthropic.com) at ~$0 marginal ' +
  '(subscription, D-005) — so a live remember is embedding-only; the gpt-4o-mini $0.15/$0.60 figures (~1800-tok ' +
  'prompt overhead + ~150-tok output per add) estimate only the metered-key FALLBACK rung (extractionMetered=true). ' +
  'Verbatim seeding skips extraction entirely. claude-file embeds nothing → $0. tokens ≈ chars/4.';
