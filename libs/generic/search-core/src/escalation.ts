/**
 * §5 — tiered escalation gate: decide whether to spend the expensive LLM
 * category-match pass on top of the cross-encoder.
 *
 * The insight: spend the LLM call only when the reranker is AMBIGUOUS — its top
 * scores cluster tightly, which is exactly when accessories sit next to products
 * ("dell laptop": laptop 0.92 / palmrest 0.90). With a clear winner + dropoff
 * (an exact SKU, or "laptop charger" 0.90 vs 0.38) the reranker is already
 * confident → skip. Conservative: errs toward calling; never skips a genuinely
 * tight cluster.
 *
 * `tiered: false` (the default — Restart only flips it on behind LLM_RERANK_TIER)
 * means always escalate, i.e. the LLM runs on every query (safest, cost-no-object).
 *
 * Pure: pass the reranker's relevance scores (any order, non-numbers ignored).
 */
export interface EscalationOptions {
  /** When false/omitted, always escalate. Map your tiering env-gate here. */
  tiered?: boolean;
  /** Score spread below which the top cluster is "tight" ⇒ escalate. Default 0.15. */
  gap?: number;
  /** 0-indexed depth for the spread comparison (~top-5). Default 4. */
  k?: number;
}

export function shouldEscalate(scores: number[], opts: EscalationOptions = {}): boolean {
  if (!opts.tiered) return true; // tiering off → always
  const sorted = scores.filter((s) => typeof s === 'number').sort((a, b) => b - a);
  if (sorted.length < 2) return true; // no signal → be safe, call
  const gap = opts.gap ?? 0.15;
  const kth = sorted[Math.min(opts.k ?? 4, sorted.length - 1)]; // ~top-5
  return sorted[0] - kth < gap; // tight cluster ⇒ ambiguous ⇒ escalate
}
