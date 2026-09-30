/**
 * Type sibling for `omp-native-lsp-tier.mjs` — see that file for why the
 * implementation is plain ESM (bare-`node` psu-launcher.mjs cannot import TS).
 */

/**
 * Is `model` positively known to be a cloud model, and therefore tier-eligible
 * to keep OMP's native `lsp` builtin?
 *
 * FAILS CLOSED: false for a local model AND for an unknown/blank one, because
 * an omp launch with no model spec runs omp's own configured default, which is
 * local here. This is the TIER term only — it does not read
 * FLAGS.OMP_NATIVE_LSP_BUILTIN.
 */
export declare function ompModelTierAllowsNativeLsp(
  model: string | null | undefined,
): boolean;
