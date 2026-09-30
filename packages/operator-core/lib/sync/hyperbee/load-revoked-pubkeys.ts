/**
 * Read helper: loads all revoked public keys for a (workspace, harness) pair
 * from `harness_shared.contributors.revoked_pubkeys` (TEXT[]), unions + dedupes
 * them into a Set<string>.
 *
 * The `runQuery` seam mirrors the pattern in
 * `apps/operator/lib/endpoint-route/routes/admin/dogfood-substrate-health.ts`
 * so callers can inject a test double while production uses the real PG accessor.
 *
 * Plan: substrate-revocation-v1 Task 1 (D-001/D-002).
 */

import { getOrgPg } from '@papercusp/db-org';

export interface LoadRevokedOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Injection seam for tests. Defaults to the real PG accessor. */
  runQuery?: (q: string, params: unknown[]) => Promise<Array<{ revoked_pubkeys: string[] | null }>>;
}

export async function loadRevokedPubkeys(opts: LoadRevokedOpts): Promise<Set<string>> {
  const runQuery =
    opts.runQuery ??
    (async (q: string, p: unknown[]) => {
      const { sql } = getOrgPg();
      return (await sql.unsafe(q, p as never)) as unknown as Array<{
        revoked_pubkeys: string[] | null;
      }>;
    });

  const rows = await runQuery(
    'SELECT revoked_pubkeys FROM harness_shared.contributors WHERE workspace_id = $1 AND harness_slug = $2',
    [opts.workspaceId, opts.harnessSlug],
  );

  const set = new Set<string>();
  for (const r of rows) {
    for (const k of r.revoked_pubkeys ?? []) {
      set.add(k);
    }
  }
  return set;
}
