/**
 * model-tier — classify a model id as 'weak' (small/local) or 'frontier'
 * (large hosted). The SINGLE gate for the weak-model lite tooling tier
 * (weak-model-tool-tier-2026-07-01).
 *
 * Weak/local models can't parse the full ~606-tool / ~185K-token catalog, so
 * every lite lever (catalog trim, lite-schema, named-JSON convention,
 * grammar-constrained decoding, in-context examples) is gated on THIS — never
 * on agent-type (`agent === 'omp'`) and never on a manual flag (D-001). OMP
 * runs weak AND strong models, so the tier MUST come from the model the
 * session launched with, not the client. Frontier tier is byte-identical to
 * today: zero regression for Claude/Opus/GPT sessions.
 *
 * Heuristic: weak IFF the model runs LOCALLY (an ollama/local provider
 * prefix). A local model on the box is resource-bounded and weak relative to
 * a hosted frontier model; a hosted anthropic/openai/google model is
 * frontier. An unknown/empty model id defaults to 'frontier' — the SAFE
 * default: never accidentally trim a strong model. A mis-classified weak
 * model merely keeps today's full-catalog behavior (a missed optimization,
 * not a regression). The override lists handle the rare exceptions (a large,
 * capable local model; a known-weak hosted one) without loosening the rule.
 */

export type ModelCapabilityTier = 'weak' | 'frontier';

/**
 * Provider prefixes that denote a LOCAL model (small, weak for tool-use).
 * Matched case-insensitively against the START of the model id.
 */
const LOCAL_PROVIDER_PREFIXES: readonly string[] = [
  'ollama/',
  'ollama-cc/', // custom ollama-compatible llama-server provider (e.g. ollama-cc/maxwell1500/ornith-35b) — missed by the bare ollama/ prefix, so the ornith incident session was tiered frontier (deterministic-context-carry P-001)
  'local/',
  'llamacpp/',
  'llama.cpp/',
  'lmstudio/',
  'localai/',
];

/**
 * Explicit overrides, matched (case-insensitively) as a SUBSTRING of the
 * model id. Kept empty by default; add an entry only for a genuine exception
 * the prefix rule gets wrong (e.g. a 70B+ local model deemed capable →
 * FORCE_FRONTIER; a known-weak hosted model → FORCE_WEAK).
 */
const FORCE_FRONTIER_CONTAINS: readonly string[] = [];
const FORCE_WEAK_CONTAINS: readonly string[] = [];

/**
 * Classify a model id (e.g. `ollama/qwen3.5:latest`, `anthropic/claude-opus-4-6:high`)
 * into its capability tier. Tolerant of provider prefixes and `:effort`/`:quant`
 * suffixes — it keys off the provider prefix, not the full id.
 */
export function modelCapabilityTier(modelId?: string | null): ModelCapabilityTier {
  if (!modelId) return 'frontier';
  const id = modelId.trim().toLowerCase();
  if (!id) return 'frontier';
  if (FORCE_WEAK_CONTAINS.some((t) => id.includes(t))) return 'weak';
  if (FORCE_FRONTIER_CONTAINS.some((t) => id.includes(t))) return 'frontier';
  if (LOCAL_PROVIDER_PREFIXES.some((p) => id.startsWith(p))) return 'weak';
  return 'frontier';
}

/** Convenience boolean for the lite-tier gate: true iff the model is weak/local. */
export function isWeakModel(modelId?: string | null): boolean {
  return modelCapabilityTier(modelId) === 'weak';
}
