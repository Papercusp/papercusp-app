/**
 * Helpers for Next.js route handlers to do workspace-scoped reads/writes.
 *
 * Existing routes that use `getOrgPg()` from `@papercusp/db-org` use the
 * harness_admin role which BYPASSES RLS by design (for migrations). For
 * application-code reads against `harness_shared.*`, those routes need
 * to migrate to `withWorkspace()` so the app-role connection sees only
 * the active workspace's rows.
 *
 * Migration recipe for an existing route:
 *
 *   // Before:
 *   const { sql } = getOrgPg();
 *   const rows = await sql`SELECT * FROM harness_shared.projects`;
 *
 *   // After:
 *   const rows = await routeWithWorkspace(async (tx) => {
 *     return await tx`SELECT * FROM harness_shared.projects`;
 *   });
 *
 * The wrapper resolves the active workspace from the registry, opens a
 * transaction, sets `app.workspace_id`, and runs the callback. Bare-pool
 * `db` references inside the callback are forbidden (eslint-rule).
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import type { Sql } from 'postgres';

/**
 * Run a route handler's body inside the active workspace's GUC.
 *
 * Use this for any cross-harness read/write against harness_shared.*
 * tables. Per-harness queries via getHarnessPg(slug) are fine without
 * this wrapper — they read from harness_<slug> schemas which are
 * scoped by name.
 */
export async function routeWithWorkspace<T>(
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withWorkspace(activeWorkspaceId(), fn);
}
