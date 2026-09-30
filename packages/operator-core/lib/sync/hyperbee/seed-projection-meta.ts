/**
 * The manifest contract for "this corestore is a FILTERED CURRENT-STATE PROJECTION",
 * in a module with NO dependencies.
 *
 * ── WHY THIS IS ITS OWN FILE ──
 * Two layers must agree on this fact and must not be able to drift:
 *   • `seed-provider-corestore.ts` — the `if (filtered)` branch, which KNOWS it minted a
 *     projection because it is the code that minted it.
 *   • `seed-degradation-guard.ts` (apps/operator) — which must EXEMPT that population from
 *     the history size floor.
 * The guard is a pure, fs-free judge over a manifest read off disk; importing the provider
 * to reach this key would drag `corestore` + the whole hypercore graph into the guard and
 * its tests. A dependency-free contract module is the seam that lets both sides share ONE
 * definition, exactly as `seed-excluded-tables.ts` does for the exclusion policy.
 *
 * ── WHY THE FACT IS RECORDED AT ALL (WI-10001612) ──
 * The guard used to INFER this population from a proxy: a core shorter than
 * `DEFAULT_CORE_LENGTH_FLOOR_BLOCKS` (1,000) "cannot hold history". That was sound when
 * written — the 0.0.17-alpha projection was 76 blocks — and it EXPIRED SILENTLY as the
 * workspace grew: the 2026-09-16 0.0.20 cut minted ~1,041 blocks, 4.1% over the floor, and
 * the guard refused a healthy 4.06 GB projection after a 4.5-hour scan while citing a cause
 * that had never applied to it. A proxy for a fact is a time bomb with an unknown fuse. The
 * branch already knows the fact; it just never said so. Now it says so.
 */

/** Meta key on a corestore {@link SeedStoreEntry} carrying {@link CoreProjectedFrom}. */
export const SEED_PROJECTED_FROM_META_KEY = 'coreProjectedFrom';

/**
 * SHIPPED minted core key (hex) → the SOURCE own-log key (hex) it was projected from.
 *
 * Both halves are load-bearing, and the mapping — rather than a bare `projection: true`
 * flag — is what makes the claim falsifiable instead of self-asserted. A filtered
 * projection is minted into a FRESH core the owner never wrote (see
 * `mintFilteredSeedContentCore`: mint-then-replicate, so the staging copy carries no
 * signing secret). So `minted !== source` is a structural property of a real projection,
 * and a manifest claiming to be a projection whose shipped key IS the owner's own log is
 * claiming the one thing a projection cannot be: a replica of the source history. That is
 * the same shape of lie as D-009's "labelled sparse, starts at block 0" — recorded so the
 * guard can catch it rather than having to trust the label.
 */
export type CoreProjectedFrom = Readonly<Record<string, string>>;

/**
 * Narrow an untyped manifest `meta` bag to {@link CoreProjectedFrom}.
 *
 * Manifests are read off disk from prior cuts — including cuts made before this key
 * existed — so nothing here may assume the provider's in-process types. Returns
 * `undefined` when the key is absent or not a string→string record; a PARTIAL bag (some
 * non-string values) keeps only the string entries, which the guard then judges against
 * the entry's `coreKeys`: a core missing from the map is simply not proven to be a
 * projection, which is the fail-safe direction.
 */
export function readCoreProjectedFrom(
  meta: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> | undefined {
  const value = meta?.[SEED_PROJECTED_FROM_META_KEY];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}
