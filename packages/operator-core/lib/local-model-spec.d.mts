/**
 * Type sibling for `local-model-spec.mjs` — see that file for why the
 * implementation is plain ESM (bare-`node` psu-launcher.mjs cannot import TS).
 */

/**
 * Is `spec` a locally-served model (ollama / ornith) rather than a cloud model?
 * Prefix/word based, so `:effort` tails, `[1m]` window markers and quantization
 * tags do not affect the answer.
 */
export declare function isLocalModelSpec(
  spec: string | null | undefined,
): boolean;
