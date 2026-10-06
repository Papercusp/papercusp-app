/**
 * Canonical model contract for every model-bearing learning path.
 *
 * Keep the bare model id and reasoning effort independently addressable for
 * APIs that expose separate fields, and use {@link LEARNING_MODEL_SPEC} at the
 * existing Papercusp model-spec seams (LLM calls and spawned roles).
 *
 * The `:<effort>` suffix is a PAPERCUSP spec convention, never part of a raw
 * upstream model id — each backend strips it its own way before the request
 * goes out: `canonicalizeAnthropicModel` (llm-client.ts) drops a known effort
 * suffix for the anthropic-direct path, and the Codex Responses bridge splits
 * it for codex models.
 *
 * Owner-directed [owner 2026-08-27]: moved BACK to `gpt-5.6-sol:xhigh` once the
 * codex limits reset ("CHANGE ALL OUR LEARNING LOOP AGENTS TO SOL XHIGH TOO").
 * This reverses the earlier same-day move to `claude-opus-5:xhigh` recorded
 * against plan work-queue-admission-and-bulk-dedup-2026-08-24 D-026 — that
 * switch was taken under codex rate-limit exhaustion, and the constraint it
 * answered no longer holds.
 *
 * Owner-directed [owner 2026-09-30, directive #1111, WI-10004483]: every
 * background process (learning / dreaming / bulk plan review / bulk work-queue
 * review) runs on "chatgpt 6.1 Sol Xhigh" — `gpt-6.1-sol:xhigh`. Same Codex
 * backend and effort; only the model generation moves.
 */
export const LEARNING_MODEL_ID = 'gpt-6.1-sol' as const;
export const LEARNING_MODEL_EFFORT = 'xhigh' as const;
export const LEARNING_MODEL_SPEC = `${LEARNING_MODEL_ID}:${LEARNING_MODEL_EFFORT}` as const;

/** True only for the exact owner-directed learning model contract. */
export function isCanonicalLearningModel(value: unknown): value is typeof LEARNING_MODEL_SPEC {
  return value === LEARNING_MODEL_SPEC;
}

/**
 * Parse a routine payload's optional `model` override into a model spec.
 *
 * `undefined` means "no override" — the caller falls back to
 * {@link LEARNING_MODEL_SPEC}. A blank/whitespace string is treated as absent
 * rather than as an empty model id, so a payload field cleared in the admin UI
 * cannot send `model: ''` to a backend. A non-string is a payload authoring
 * error and throws, naming `label` so the routine that received it is obvious
 * from the message alone.
 *
 * Shared by every scheduled admission path (promoter, bulk-dedup, daily-digest)
 * so a per-run override behaves identically at all three seams.
 */
export function optionalModelSpec(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${label} expected a model spec string, received ${String(value)}`);
  }
  const spec = value.trim();
  return spec === '' ? undefined : spec;
}
