/**
 * The census provider registry — which SurfaceCensusProvider implementations this build has.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002; populated by P-003).
 *
 * TWO DIFFERENT "REGISTRATIONS", and conflating them is the easy mistake:
 *   - harness_shared.census_provider_registrations says which providers a POT WANTS to run,
 *     with their per-pot config (D-004: pot-level, never plan-level).
 *   - THIS module says which providers this BUILD can actually run.
 * runCensus intersects them, and reports a registration with no implementation here as
 * `unimplementedProviders` rather than silently ignoring it — a pot asking for a provider that
 * does not exist is a misconfiguration worth seeing, not a no-op.
 *
 * EMPTY IS SAFE, BY CONSTRUCTION. With no implementations, no provider reports success, so no
 * kind is retirable and the census cannot retire anything (see diff.ts's retirement scoping).
 * The cadence therefore ran as a correct no-op between P-002 and P-003, rather than needing to
 * stay dark until then.
 *
 * P-003 populated it with the three declared providers below. Each derives its rows from the SAME
 * registry that serves production traffic — the mount table, the tool catalog, the sync-resolver
 * registry — never a hand-maintained list, which drifts silently and yields false confidence.
 * Each also refuses to report success on an EMPTY enumeration (see providers/_non-empty.ts),
 * because `kinds` is the retirement scope: a registry that fails to LOAD would otherwise present
 * as "every surface of this kind was deleted".
 */

import type { SurfaceCensusProvider } from '@papercusp/testing-shell/census';
import { honoRoutesProvider } from './providers/hono-routes';
import { mcpToolsProvider } from './providers/mcp-tools';
import { syncQueriesProvider } from './providers/sync-queries';

const providers: SurfaceCensusProvider[] = [
  honoRoutesProvider, // http-route  — routeRegistrationOrder() mount table
  mcpToolsProvider, //  mcp-tool    — getCatalog() + zod schema capture
  syncQueriesProvider, // sync-query — knownQueryNamesV2() dispatch registry
];

/** The providers this build can run. */
export function censusProviders(): readonly SurfaceCensusProvider[] {
  return providers;
}

/**
 * Register a provider implementation. Exported for P-003 and for tests that need a controlled
 * provider set; a duplicate id REPLACES rather than stacking, so a re-import cannot cause one
 * provider to enumerate twice (which diffCensus would report as a duplicate emission).
 */
export function registerCensusProvider(provider: SurfaceCensusProvider): void {
  const at = providers.findIndex((p) => p.provider === provider.provider);
  if (at >= 0) providers[at] = provider;
  else providers.push(provider);
}
