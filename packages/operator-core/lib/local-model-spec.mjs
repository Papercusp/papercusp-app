/**
 * The ONE definition of "is this model spec a LOCAL model?" — P-021 (D-013).
 *
 * WHY THIS FILE IS PLAIN .mjs
 *
 * Same reasoning (and same shape) as `su-tier-roles.mjs` beside it: both sides
 * of the launch path need this predicate, and one of them cannot import
 * TypeScript.
 *   • `apps/operator/scripts/psu-launcher.mjs` — bare `node`, unbundled. It
 *     already carried TWO byte-identical copies of this regex pair
 *     (`cloudModelBackendHint`, `validateModelSpec`).
 *   • `.../routes/agent-mcp/bootstrap-{su,role}.ts` — resolves the
 *     OMP_NATIVE_LSP_BUILTIN tier gate server-side and threads the answer to
 *     the launcher via envelopeEnv.
 *
 * A third copy is what this file exists to prevent. The drift would be quiet in
 * the dangerous direction: a local-model family added to one copy and not the
 * other keeps the tier gate OPEN for exactly the model class the gate exists to
 * exclude.
 *
 * ⚠ THIS PREDICATE IS A SAFETY GATE, NOT A COSMETIC CLASSIFIER. It is what
 * keeps OMP's native `lsp` builtin away from weak models regardless of how
 * FLAGS.OMP_NATIVE_LSP_BUILTIN is set. The documented tool-attractor incidents
 * are all local models — session 9885 abused `lsp` as a tools:call wrapper, and
 * the sibling attractor `eval` doom-looped ornith 56-80× (sessions 10234/10239)
 * until it was disabled at the omp-config layer, because message-based fixes
 * could not break the reflex. Widening this predicate is safe; NARROWING it
 * re-exposes that class.
 */

/**
 * Is `spec` a locally-served model (ollama / ornith), as opposed to a cloud
 * model routed through a provider account?
 *
 * Deliberately matches on a PREFIX (`ollama/`, `ollama-cc/`) and a WORD
 * (`ornith`), so it is insensitive to the decorations a spec may carry: an
 * `:effort` tail (`:low|medium|high|xhigh|max`), a `[1m]` window marker, or a
 * quantization tag (`maxwell1500/ornith-35b:IQ3_M`). Callers may therefore pass
 * either the raw spec or an already-peeled base.
 *
 * Pure — exported for tests.
 *
 * @param {string | null | undefined} spec
 * @returns {boolean}
 */
export function isLocalModelSpec(spec) {
  if (!spec) return false;
  const s = String(spec).trim();
  if (!s) return false;
  return /^ollama(-cc)?\//i.test(s) || /\bornith\b/i.test(s);
}
