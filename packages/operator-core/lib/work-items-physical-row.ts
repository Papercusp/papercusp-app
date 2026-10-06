/**
 * Physical-row pinning for issue-family work-item writes (WI-10006010).
 *
 * A LEAF module, for the same reason as `work-items-orphan-author.ts`: its callers are the
 * write paths in `work-items.ts` / `issues-engineer.ts`, and their unit tests mock those
 * modules wholesale — a helper defined there would be `undefined` at the call sites it
 * protects.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The physical identity of a `harness_shared.work_items` row is
 * `(workspace_id, harness_slug, feature_id)`. The same `feature_id` legitimately exists
 * under more than one `harness_slug`: a re-homed item and the stale copy a federation peer
 * re-sent (`operator:<ws>` beside `papercusp`), a pot-member copy, test fixtures. Measured
 * 2026-10-03: 100 such ids in one store, 14 with a non-terminal side.
 *
 * The issue-family state writer and the four origin self-heals keyed every UPDATE on
 * `feature_id` alone, so a close of ONE row rewrote every twin. Observed: closing 11
 * `operator:papercusp-workspace` rows as `dropped` flipped 3 sibling `papercusp` rows that
 * other agents had closed `done/committed` to `dropped/proposed`, and stamped the closer's
 * id as `terminal_owner` on all 11.
 *
 * THE RULE
 * --------
 * Every state write and origin heal touches exactly ONE physical row, chosen once:
 *   1. the row whose `harness_slug` matches the harness the caller named, if any;
 *   2. otherwise the most recently updated row (tie-broken by slug, so the choice is
 *      deterministic) — the SAME row `getIssue` returns for a read, so the row a caller
 *      inspects and the row it writes cannot disagree.
 * A sibling row is never written.
 */
import type { getOrgPg } from '@papercusp/db-org';

/** Strip the `harness:` scope prefix a caller may pass. */
function bareHarness(harness: string): string {
  return harness.startsWith('harness:') ? harness.slice('harness:'.length) : harness;
}

/**
 * Normalise a caller-supplied harness to a usable selector: blank, `*` (the "any harness"
 * wildcard) and null all mean "no preference".
 */
export function harnessPreference(harness: string | null | undefined): string | null {
  if (!harness) return null;
  const trimmed = harness.trim();
  if (!trimmed || trimmed === '*') return null;
  return trimmed;
}

/**
 * Does the physical `harness_slug` belong to the harness a caller named? Physical slugs are
 * stored both bare (`papercusp`) and prefixed (`harness:papercusp`), and a caller may pass
 * either form or a non-harness physical slug verbatim (`operator:papercusp-workspace`).
 */
export function harnessSlugMatches(slug: string, harness: string): boolean {
  if (slug === harness) return true;
  const want = bareHarness(harness);
  return slug === want || slug === `harness:${want}`;
}

/**
 * Pick the one physical slug a write may touch, from candidate slugs ALREADY ORDERED by read
 * preference (most recent first). Returns null when there is no row at all.
 */
export function pickPhysicalSlug(
  orderedSlugs: readonly string[],
  harness?: string | null,
): string | null {
  if (orderedSlugs.length === 0) return null;
  const want = harnessPreference(harness);
  if (want) {
    const named = orderedSlugs.find((slug) => harnessSlugMatches(slug, want));
    if (named !== undefined) return named;
  }
  return orderedSlugs[0] ?? null;
}

/** The org pool or a transaction handle (`boundedOrgTxn` passes the same type). */
type SlugReader = ReturnType<typeof getOrgPg>['sql'];

/**
 * Resolve the single issue-family physical row a write for `(workspaceId, id)` may touch.
 * Returns its `harness_slug`, or null when the id has no issue-family row in that workspace
 * (the caller's own lookup then reports not-found exactly as before).
 */
export async function resolveIssuePhysicalSlug(
  sql: SlugReader,
  workspaceId: string,
  id: string,
  harness?: string | null,
): Promise<string | null> {
  if (!workspaceId || !id) return null;
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${id}
       AND item_kind IN ('bug', 'change', 'task')
     ORDER BY updated_ts DESC NULLS LAST, harness_slug ASC`;
  return pickPhysicalSlug(
    rows.map((r) => r.harness_slug),
    harness,
  );
}
