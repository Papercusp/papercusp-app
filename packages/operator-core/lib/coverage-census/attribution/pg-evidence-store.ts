/**
 * The Postgres EvidenceStore — turns buffered traffic observations into `coverage_evidence`
 * rows, joined to the census surfaces P-003's providers wrote.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * ⚠ WHY THIS OPENS ITS OWN CONNECTION INSTEAD OF USING `getOrgPg()`.
 * The other half of this system (`../pg-store.ts`) runs INSIDE the operator, where the org pool
 * is configured. This one frequently runs inside a VITEST FORK — the in-process Hono app case —
 * where the org pool is not configured, and where any pool the test itself created points at a
 * throwaway testcontainer database. Writing there would put the evidence in a database that is
 * dropped at the end of the run: rows written, nothing kept, and no error to notice. So the
 * store resolves the CANONICAL admin URL explicitly, exactly as the test-runs reporter already
 * does for `test_runs` — which is what keeps a run's `test_runs` rows and its evidence rows in
 * the same database, so they can be joined at all.
 *
 * ⚠ TRAFFIC ROWS DELIBERATELY CARRY `test_run_id = NULL`. See D-010 on the plan. In short: the
 * `test_runs` row for a file is written by the reporter when that FILE FINISHES, which is
 * strictly after the traffic it is attributing, so at write time there is usually no id to
 * point at. Since `test_run_id` participates in the dedup index, resolving it opportunistically
 * would mean the SAME binding produces one row or two depending on whether the debounce
 * happened to fire before or after the file ended — the table's contents would become a
 * function of flush timing, which a *deterministic* census cannot have. Holding it at NULL
 * makes the binding the identity: exactly one row per (surface, test file, test case), refreshed
 * on every run. The run correlation is not lost — it is kept in `details.runGroupId`, which
 * joins to `test_runs.run_group_id`.
 *
 * UNMATCHED SURFACES ARE COUNTED, NEVER CREATED. If a call names a surface the census has no
 * row for, the honest answer is that the census is stale (or the route only exists in a test
 * app) — not that a new surface exists. Inserting one here would let TRAFFIC define the
 * population, which is precisely the hand-maintained-list drift the provider contract forbids.
 */

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import type { BufferedEvidence } from './buffer';
import type { AttributionScope } from './context';
import type { EvidenceStore } from './sink';

/**
 * The postgres.js client type, taken from the library itself via a TYPE-ONLY import — which
 * costs no runtime import, so this module still loads without pulling `postgres` in (the real
 * client is behind the dynamic import in `defaultSql`, which is what keeps the sink inert in a
 * process that never flushes).
 *
 * Deliberately NOT a hand-written structural stand-in. The first draft declared
 * `<T = unknown>(strings, ...values) => Promise<T>`, which looks equivalent and is not: the real
 * tag constrains its generic to a row-array, so a genuine `postgres.Sql` is NOT assignable to
 * the loose shape and every caller passing a real handle fails to typecheck. Naming the library
 * type means this cannot drift from the client it describes.
 */
type SqlTag = import('postgres').Sql;

export interface PgEvidenceStoreOptions {
  /** Injected by tests (the integration test passes its testcontainer admin handle). */
  getSql?: () => SqlTag;
}

let sharedSql: SqlTag | null = null;

async function defaultSql(): Promise<SqlTag> {
  if (sharedSql) return sharedSql;
  const mod = (await import('postgres')) as { default?: unknown };
  const pg = (mod.default ?? mod) as (url: string, opts: Record<string, unknown>) => SqlTag;
  // `max: 2` mirrors the test-runs reporter: this is instrumentation riding alongside a real
  // workload, and it must not compete with it for the 6-connection-per-host budget.
  sharedSql = pg(getHarnessAdminUrl(), { max: 2, connect_timeout: 5, onnotice: () => {} });
  return sharedSql;
}

export function createPgEvidenceStore(options: PgEvidenceStoreOptions = {}): EvidenceStore {
  const getSql = options.getSql ? async () => options.getSql!() : defaultSql;

  return {
    async write(scope: AttributionScope, rows: readonly BufferedEvidence[]) {
      if (rows.length === 0) return { written: 0, unmatchedSurfaces: 0 };
      const sql = await getSql();

      // ── 1. Resolve (kind, surfaceId) -> testing_surfaces.id, one query per kind ──────────
      // Retired surfaces are EXCLUDED: evidence for a surface that no longer exists would
      // resurrect nothing and only inflate the numbers a gate reads.
      const byKind = new Map<string, Set<string>>();
      for (const r of rows) {
        let ids = byKind.get(r.kind);
        if (!ids) {
          ids = new Set<string>();
          byKind.set(r.kind, ids);
        }
        ids.add(r.surfaceId);
      }

      const surfaceRef = new Map<string, number>();
      for (const [kind, ids] of byKind) {
        const found = await sql<{ id: string | number; surface_id: string }[]>`
          SELECT id, surface_id
            FROM harness_shared.testing_surfaces
           WHERE workspace_id  = ${scope.workspaceId}
             AND harness_slug  = ${scope.harnessSlug}
             AND kind          = ${kind}
             AND surface_id    = ANY(${[...ids]}::text[])
             AND retired_at IS NULL
        `;
        for (const row of found) surfaceRef.set(`${kind}\n${row.surface_id}`, Number(row.id));
      }

      // ── 2. Upsert one row per binding ───────────────────────────────────────────────────
      let written = 0;
      let unmatchedSurfaces = 0;

      for (const r of rows) {
        const ref = surfaceRef.get(`${r.kind}\n${r.surfaceId}`);
        if (ref === undefined) {
          unmatchedSurfaces += 1;
          continue;
        }

        const details = {
          ...r.details,
          runGroupId: r.runGroupId,
          calls: r.calls,
          firstSeenAt: new Date(r.firstSeenMs).toISOString(),
          lastSeenAt: new Date(r.lastSeenMs).toISOString(),
        };

        // The ON CONFLICT target restates `coverage_evidence_dedup`'s expressions VERBATIM
        // (migration 846, lines 151-155) — inference against an expression index only matches
        // on an exact expression, so this text and that text must stay identical.
        await sql`
          INSERT INTO harness_shared.coverage_evidence
            (surface_ref, evidence_kind, verdict, generated, test_file, test_case, test_run_id, details)
          VALUES
            (${ref}, 'traffic', ${r.verdict}, ${r.generated}, ${r.testFile}, ${r.testCase},
             NULL, ${JSON.stringify(details)}::jsonb)
          ON CONFLICT (
            surface_ref, evidence_kind,
            COALESCE(test_file, ''), COALESCE(test_case, ''), COALESCE(test_run_id, -1)
          ) DO UPDATE
             SET verdict     = EXCLUDED.verdict,
                 generated   = EXCLUDED.generated,
                 details     = EXCLUDED.details,
                 observed_at = now()
        `;
        written += 1;
      }

      // PRODUCER-SIDE PUSH for the `/admin/testing` Coverage panel — one invalidation per
      // FLUSH, not per row. This is the write that actually moves the number a reader cares
      // about (evidence is the numerator of every coverage ratio), so without it the panel
      // would refresh on remount only — the `accounts.pool` failure documented on
      // `QueryEntry.backingTables`, where a live-looking panel sat stale for ~7 weeks.
      //
      // Guarded on `written > 0`: a flush that matched no surfaces changed nothing, and
      // pushing there would invalidate every subscriber to say so.
      // The import is DYNAMIC and must stay that way: sync-sse declares itself a host-only
      // module that opens a long-lived PG LISTEN connection at load. This store is reached
      // from the attribution flush inside ordinary TEST processes, so a static import would
      // open that connection in every one of them.
      if (written > 0) {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('testing.coverage');
      }

      return { written, unmatchedSurfaces };
    },
  };
}
