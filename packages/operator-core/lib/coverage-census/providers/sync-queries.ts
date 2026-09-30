/**
 * `sync-queries` — the declared census provider for client data-sync surfaces.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-003), Decision D-001.
 *
 * THE POPULATION IS THE DISPATCH REGISTRY. `knownQueryNamesV2()` reports exactly the names
 * `resolveNamedQueryV2` will dispatch — the same table the REST query routes resolve against.
 * A name in this census is therefore a query a client can actually call, and a query a client
 * can call is necessarily in this census. There is no hand-maintained list to drift, and no glob:
 * the resolver registry is one object, and it is the thing that serves production reads.
 *
 * WHY `backingTables` IS CAPTURED AS AN ATTRIBUTE. A sync query's real contract is not just
 * "does it return rows" — it is "does the panel UPDATE when the underlying data changes". That
 * push path is a separate mechanism (PG triggers → cache tags → SSE invalidation), and it has
 * failed silently before: `accounts.pool` read a table that was in neither invalidation map, so
 * not one invalidation ever fired for ~7 weeks while the query itself worked perfectly. Nothing
 * threw; the tab just quietly stopped being live. Carrying the declared backing tables onto the
 * surface row means a depth ladder can ask the question that actually matters — is this query's
 * invalidation path exercised — instead of stopping at "the resolver returned rows".
 *
 * `backingTables` is optional on the registry entry (a shrink-only baseline of undeclared legacy
 * names still exists), so `null` here means UNDECLARED, not "reads nothing". Those two must stay
 * distinguishable: treating undeclared as empty would let a whole class of un-pushed queries
 * grade as fully covered.
 */

import { toJsonSchema } from '@papercusp/tooldef';
import type { ObservedSurface, SurfaceCensusProvider } from '@papercusp/testing-shell/census';
import { knownQueryNamesV2, getRegistryEntryV2 } from '../../sync-resolver';
import { assertRegistryNonEmpty } from './_non-empty';

/** The surface kind this provider owns — and therefore the only kind it may retire. */
export const SYNC_QUERY_KIND = 'sync-query';

function schemaOf(argsSchema: unknown): unknown {
  if (argsSchema == null) return undefined;
  try {
    return toJsonSchema(argsSchema);
  } catch {
    return undefined;
  }
}

export const syncQueriesProvider: SurfaceCensusProvider = {
  provider: 'sync-queries',
  kinds: [SYNC_QUERY_KIND],

  enumerate(): ObservedSurface[] {
    const names = knownQueryNamesV2();

    const surfaces = names.map((name): ObservedSurface => {
      const entry = getRegistryEntryV2(name);
      const backingTables = entry?.backingTables;

      return {
        kind: SYNC_QUERY_KIND,
        surfaceId: name,
        // Entries are values in one registry object (many delegating to helper modules), so the
        // registry carries no per-query file provenance. Asserted as unknown rather than guessed.
        sourceFile: null,
        schemaRef: schemaOf(entry?.argsSchema),
        attrs: {
          // null = the entry does not DECLARE its backing tables (legacy baseline), which is a
          // different state from declaring none. Kept distinguishable on purpose.
          backingTables: backingTables ? [...backingTables] : null,
          hasArgsSchema: entry?.argsSchema != null,
        },
        fidelity: 'declared',
      };
    });

    return assertRegistryNonEmpty(
      surfaces,
      'knownQueryNamesV2() (sync-resolver)',
      'The sync-resolver registry is empty — check that lib/sync-resolver/index.ts loaded.',
    ) as ObservedSurface[];
  },
};
