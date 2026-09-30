/**
 * The Postgres CensusStore — the concrete backend behind @papercusp/testing-shell/census.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * WHY IT LIVES HERE AND NOT IN testing-shell: the census job is framework-neutral (D-001) and
 * takes an injected store, precisely so the package holds no dependency on harness_shared or the
 * operator's pg client. This module is that dependency, kept on the operator side of the seam.
 *
 * THE ONE INVARIANT THIS FILE CAN BREAK THAT THE PURE DIFF CANNOT:
 *   `first_seen` MUST NEVER be written after insert.
 * The green-checkpoint NEW-surface guard is scoped by first_seen (a surface first seen after the
 * last green pin must be at/above the depth floor). If an upsert refreshed first_seen, EVERY
 * surface would look new on every census run and the gate would red the entire backlog at once —
 * or, with the guard inverted, never fire. It is absent from the UPDATE SET list below for that
 * reason, and pg-store.integration.test.ts asserts it against real Postgres, because no unit test
 * over the pure diff can observe an UPDATE that touches the wrong column.
 */

import { getOrgPg } from '@papercusp/db-org';
import type {
  CensusDiff,
  CensusScope,
  CensusStore,
  ExistingSurface,
  Fidelity,
  ProviderRegistration,
} from '@papercusp/testing-shell/census';
import { pgTimestampToIsoOrNull } from '../pg-timestamp';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface PgCensusStoreOptions {
  /** Injected for tests; defaults to the operator's org pool. */
  getSql?: () => Sql;
}

export function createPgCensusStore(options: PgCensusStoreOptions = {}): CensusStore {
  const getSql = options.getSql ?? (() => getOrgPg().sql);

  return {
    async loadRegistrations(scope: CensusScope): Promise<ProviderRegistration[]> {
      const sql = getSql();
      const rows = await sql<
        { provider: string; config: Record<string, unknown>; enabled: boolean; source: string }[]
      >`
        SELECT provider, config, enabled, source
          FROM harness_shared.census_provider_registrations
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
         ORDER BY provider
      `;
      return rows.map((r) => ({
        provider: r.provider,
        config: r.config ?? {},
        enabled: r.enabled,
        source: r.source as ProviderRegistration['source'],
      }));
    },

    async loadExisting(scope: CensusScope): Promise<ExistingSurface[]> {
      const sql = getSql();
      // Retired rows are INCLUDED deliberately: a returning surface must be un-retired in place
      // so it keeps its original first_seen, not re-inserted as a new one.
      const rows = await sql<
        {
          id: string | number;
          kind: string;
          surface_id: string;
          provider: string;
          fidelity: string;
          source_file: string | null;
          retired_at: Date | string | null;
        }[]
      >`
        SELECT id, kind, surface_id, provider, fidelity, source_file, retired_at
          FROM harness_shared.testing_surfaces
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
      `;
      return rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        surfaceId: r.surface_id,
        provider: r.provider,
        fidelity: r.fidelity as Fidelity,
        sourceFile: r.source_file,
        retiredAt: pgTimestampToIsoOrNull(r.retired_at),
      }));
    },

    async applyDiff(
      scope: CensusScope,
      diff: Pick<CensusDiff, 'upserts' | 'retires'>,
    ): Promise<{ upserted: number; retired: number }> {
      const sql = getSql();
      let upserted = 0;
      let retired = 0;

      // `tx` is postgres.js's TransactionSql, not Sql — typed via the callback parameter rather
      // than annotated, so this cannot drift if the client's transaction type changes.
      await sql.begin(async (tx) => {
        for (const u of diff.upserts) {
          // NOTE THE UPDATE SET LIST: last_seen, provider, fidelity, source_file, schema_ref,
          // attrs, retired_at. `first_seen` is deliberately ABSENT — see the file header.
          // retired_at is cleared only when this row is genuinely coming back, so an ordinary
          // refresh cannot resurrect a surface that a concurrent run just retired.
          await tx`
            INSERT INTO harness_shared.testing_surfaces
              (workspace_id, harness_slug, kind, surface_id, source_file, schema_ref, attrs,
               provider, fidelity)
            VALUES (${scope.workspaceId}, ${scope.harnessSlug}, ${u.kind}, ${u.surfaceId},
                    ${u.sourceFile}, ${u.schemaRef === null ? null : JSON.stringify(u.schemaRef)},
                    ${JSON.stringify(u.attrs)}, ${u.provider}, ${u.fidelity})
            ON CONFLICT (workspace_id, harness_slug, kind, surface_id) DO UPDATE
               SET last_seen   = now(),
                   provider    = EXCLUDED.provider,
                   fidelity    = EXCLUDED.fidelity,
                   source_file = EXCLUDED.source_file,
                   schema_ref  = EXCLUDED.schema_ref,
                   attrs       = EXCLUDED.attrs,
                   retired_at  = CASE WHEN ${u.unretire} THEN NULL
                                      ELSE harness_shared.testing_surfaces.retired_at END
          `;
          upserted += 1;
        }

        if (diff.retires.length > 0) {
          const ids = diff.retires.map((r) => r.id);
          const rows = await tx<{ id: string | number }[]>`
            UPDATE harness_shared.testing_surfaces
               SET retired_at = now()
             WHERE id = ANY(${ids}::bigint[])
               AND retired_at IS NULL
            RETURNING id
          `;
          retired = rows.length;
        }
      });

      return { upserted, retired };
    },
  };
}
