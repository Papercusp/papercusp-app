/**
 * Git-export outbox GC (plan harness-state-storage-unification-2026-06-01, P-008).
 *
 * The capture trigger fires for EVERY write to a sync:'git' table, but the drain
 * loop only runs for harnesses in the persistent registry (boot resolves them).
 * Ephemeral / non-registry harnesses — gym-smoke + contract-test throwaways —
 * write git-table rows that are captured but never drained, so their outbox rows
 * accumulate stuck-unexported forever (found 600+ during the P-003 live-verify).
 *
 * This GC deletes outbox rows whose (workspace_id, harness_slug) is NOT a live
 * registry harness. Run it once at boot with the resolved harness list.
 *
 * SAFETY: a no-op when the live list is empty (never GC-everything on a failed /
 * partial registry resolve), and the set difference is computed in JS over the
 * outbox's own distinct (ws, slug) pairs — each delete uses scalar params (avoids
 * the postgres-js array-binding footgun), so a registry harness's pending exports
 * are never touched.
 */
import type postgres from 'postgres';

export interface GcOrphanResult {
  deleted: number;
  /** the orphan `${ws}::${slug}` pairs that were GC'd (for the boot log). */
  orphans: string[];
}

export async function gcOrphanOutboxRows(
  sql: postgres.Sql,
  liveHarnesses: { workspaceId: string; harnessSlug: string }[],
): Promise<GcOrphanResult> {
  // Guard: never delete everything if the caller couldn't resolve the registry.
  if (liveHarnesses.length === 0) return { deleted: 0, orphans: [] };

  const SEP = '\x00';
  const liveSet = new Set(liveHarnesses.map((h) => `${h.workspaceId}${SEP}${h.harnessSlug}`));

  const pairs = await sql<{ workspace_id: string; harness_slug: string }[]>`
    SELECT DISTINCT workspace_id, harness_slug FROM harness_shared.git_export_outbox`;

  const orphans = pairs.filter((p) => !liveSet.has(`${p.workspace_id}${SEP}${p.harness_slug}`));

  let deleted = 0;
  for (const o of orphans) {
    const res = await sql`
      DELETE FROM harness_shared.git_export_outbox
       WHERE workspace_id = ${o.workspace_id} AND harness_slug = ${o.harness_slug}`;
    deleted += res.count;
  }
  return { deleted, orphans: orphans.map((o) => `${o.workspace_id}::${o.harness_slug}`) };
}
