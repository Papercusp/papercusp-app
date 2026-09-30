/**
 * cell-scope.ts — the per-Swarm-cell PG binding for the hermetic 2-swarm
 * composition rig (shared-hive-loop-e2e-testing-2026-06-10, Phase 1).
 *
 * The composition tests run TWO Swarm cells (own PG each) in ONE process, but
 * the production work-item functions (`work-items.ts` claimNextWorkItem /
 * releaseWorkItem / setWorkItemPriority …) reach Postgres through the
 * process-global `getOrgPg()`. This AsyncLocalStorage carries "which cell's PG
 * is current" through every await, so a test file can mock `@papercusp/db-org`
 * once and route each cell's REAL production claim/steer SQL to that cell's
 * own database — even when both cells run CONCURRENTLY (the whole point of the
 * composition tests; a swap-a-global approach would cross-wire interleaved
 * promises).
 *
 * Deliberately a LEAF module (no app-graph imports) so a `vi.mock` factory can
 * import it without cycles:
 *
 *   vi.mock('@papercusp/db-org', async () => {
 *     const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
 *     const { currentCellSql } = await import('./cell-scope');
 *     return { ...actual, getOrgPg: () => ({ sql: currentCellSql() ?? actual.getOrgPg().sql }) };
 *   });
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';

const cellSqlStorage = new AsyncLocalStorage<postgres.Sql>();

/** The PG client of the cell currently in scope, or undefined outside any cell. */
export function currentCellSql(): postgres.Sql | undefined {
  return cellSqlStorage.getStore();
}

/** Run `fn` with `sql` as the current cell's PG (propagates through awaits). */
export function runWithCellSql<T>(sql: postgres.Sql, fn: () => Promise<T>): Promise<T> {
  return cellSqlStorage.run(sql, fn);
}
