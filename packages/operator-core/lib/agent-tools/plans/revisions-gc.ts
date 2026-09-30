/**
 * revisions-gc.ts — per-plan retention cap for the plan_revisions spine.
 *
 * Plan: infra-fail-fast-build-integrity-2026-06-19, item C4/P-012 ("plan_revisions
 * cap — full snapshots, cap N recent"). Every plans:* write appends a full
 * content_snapshot revision (revisions.ts), so a chatty plan accretes revisions
 * unbounded. Today the table is ~279MB / 11.4k rows (534 plans, avg ~21 revs,
 * max 183) — no runaway yet, but no cap either: a single hot plan (e.g. an
 * autoloop hammering plans:set-now) could balloon it. This is the durable cap.
 *
 * A daily DBOS tick (periodic-workflows) keeps the newest `keepPerPlan` revisions
 * per plan and deletes the older tail.
 *
 * SAFETY:
 *   • The CURRENT plan state is never at risk — it lives in the live plan doc
 *     (plans:get) and the newest revision is always within the kept window.
 *   • Partitioned by (workspace_id, harness_slug, plan_slug) so each plan's own
 *     chain is capped independently.
 *   • No federation side-effect: plan_revisions has NO capture/federation trigger
 *     (verified via pg_trigger), so a DELETE here never enqueues a federated op.
 *   • Trimming only touches OLD revisions beyond the (generous) window; the recent
 *     chain that plans:revisions / plans:diff actually surface stays intact. A
 *     revision adjacent to a trimmed gap shows its +/- diff-stat vs the older
 *     surviving revision instead of the exact predecessor — cosmetic, not a crash.
 *
 * (delta/gzip of older snapshots — lossless compression instead of deletion — is
 * the richer future enhancement noted on the plan item; this cap is the simple,
 * safe, no-reader-changes durable bound.)
 *
 * Returns the number of revisions deleted. Best-effort caller tolerates errors.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Default revisions kept per plan. Generous: only the few chattiest plans are
 *  trimmed today (max chain is 183), but it bounds any future runaway plan. */
export const PLAN_REVISIONS_KEEP_PER_PLAN = 100;

export async function gcOldPlanRevisions(
  keepPerPlan = PLAN_REVISIONS_KEEP_PER_PLAN,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY workspace_id, harness_slug, plan_slug
               ORDER BY seq DESC
             ) AS rn
        FROM harness_shared.plan_revisions
    ),
    d AS (
      DELETE FROM harness_shared.plan_revisions p
       USING ranked r
       WHERE p.id = r.id
         AND r.rn > ${keepPerPlan}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
