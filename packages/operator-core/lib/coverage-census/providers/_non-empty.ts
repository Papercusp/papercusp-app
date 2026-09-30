/**
 * The empty-enumeration guard shared by every DECLARED provider.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-003), Decision D-001.
 *
 * WHY THIS EXISTS — the single most dangerous failure mode in the census.
 *
 * `SurfaceCensusProvider.kinds` is the RETIREMENT SCOPE: a census run may retire rows whose
 * kind is owned by a provider that reported SUCCESSFULLY in that run. So a provider that
 * returns `[]` with `status: 'ok'` is not saying "I found nothing" — it is asserting
 * "this application has no routes / no tools / no sync queries", and the diff dutifully
 * retires every surface of that kind.
 *
 * For the three declared Papercusp providers, zero is NEVER a legitimate reading. The route
 * table, the tool catalog and the sync-resolver registry are populated by module side effects
 * at import time; an empty one means the registry did not LOAD (a bundling seam, a module-record
 * split, a bootstrap that did not run), not that the surfaces were deleted. Those two states are
 * byte-identical downstream — which is exactly the "silent false confidence" D-001 names as the
 * worst failure this system can have, in its most destructive direction.
 *
 * THROWING is the correct response, not returning empty: `runProvider` turns a thrown provider
 * into `status: 'failed'`, and a failed provider's kinds are NOT retirable. So a registry that
 * fails to load leaves the existing census untouched and reports a visible failure, instead of
 * silently wiping the ledger it was supposed to maintain.
 *
 * The mass-retirement circuit breaker in `runCensus` is the second line of defence, not the
 * first: it bounds the blast radius of a bad run, while this bounds whether one happens at all.
 */

/**
 * Assert a production registry actually loaded. Returns `rows` unchanged when non-empty;
 * throws otherwise, so the caller reads as `status: 'failed'` rather than a successful wipe.
 *
 * @param rows     what the provider enumerated from the live registry
 * @param registry human-readable name of the registry that should have populated it
 * @param hint     what an operator should check first when this fires
 */
export function assertRegistryNonEmpty<T>(
  rows: readonly T[],
  registry: string,
  hint: string,
): readonly T[] {
  if (rows.length === 0) {
    throw new Error(
      `coverage-census: ${registry} enumerated ZERO surfaces. Refusing to report success, ` +
        `because an empty successful run would RETIRE every surface of this provider's kinds. ` +
        `Zero is not a legitimate reading here — it means the registry did not load. ${hint}`,
    );
  }
  return rows;
}
