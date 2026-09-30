/**
 * insights_first_visit helpers — Phase 8 P-074.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 P-074 + D-029.
 *
 * Read/write the LOCAL `harness_shared.insights_first_visit` table:
 *
 *   SELECT seen_at_ts FROM ... WHERE (workspace_id, harness_slug, user_id) = ...
 *
 * Read returns:
 *   - null   → first visit (caller should force-route to /insights)
 *   - epoch  → already seen (caller can render the user's chosen tab)
 *
 * Mark inserts/updates the row with NOW().
 *
 * Pure logic — injectable runQuery; defensive against missing table.
 */

export interface FirstVisitOpts {
  workspace_id: string;
  harness_slug: string;
  user_id: string;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface SeenRow {
  seen_at_ts: string | Date | null;
}

/**
 * Returns null when the user has not yet seen Insights for this
 * (workspace, harness), or an epoch ms when they have. Missing table
 * also returns null so a fresh install routes new contributors
 * straight to /insights.
 */
export async function getInsightsFirstVisit(
  opts: FirstVisitOpts,
): Promise<number | null> {
  const { workspace_id, harness_slug, user_id, runQuery } = opts;
  try {
    const rows = await runQuery<SeenRow>(
      `SELECT seen_at_ts
         FROM harness_shared.insights_first_visit
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND user_id = $3
        LIMIT 1`,
      [workspace_id, harness_slug, user_id],
    );
    if (rows.length === 0) return null;
    const ts = rows[0]?.seen_at_ts;
    if (ts == null) return null;
    if (ts instanceof Date) return ts.getTime();
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  } catch {
    return null;
  }
}

/**
 * Insert / update the row with NOW(). Idempotent — re-marking is a
 * no-op for the user-visible behavior (the route stops force-routing).
 */
export async function markInsightsSeen(opts: FirstVisitOpts): Promise<void> {
  const { workspace_id, harness_slug, user_id, runQuery } = opts;
  try {
    await runQuery(
      `INSERT INTO harness_shared.insights_first_visit
        (workspace_id, harness_slug, user_id, seen_at_ts)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (workspace_id, harness_slug, user_id)
       DO UPDATE SET seen_at_ts = EXCLUDED.seen_at_ts`,
      [workspace_id, harness_slug, user_id],
    );
  } catch {
    // best-effort — if the table is missing the next-visit force-route
    // is the right user-facing fallback anyway.
  }
}

/**
 * Decision helper: should the caller force-route this user to
 * /insights? Returns true iff first visit (no row OR null timestamp).
 */
export async function shouldForceRouteToInsights(
  opts: FirstVisitOpts,
): Promise<boolean> {
  const seen = await getInsightsFirstVisit(opts);
  return seen === null;
}
