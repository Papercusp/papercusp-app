/**
 * store.ts — deferral-interest PG glue (self-learning-frontier P-042 / FB-14).
 *
 *   - readDeferralEdges: timestamped canonical dependency + polymorphic coord edges touching a set of
 *     issues, in TWO batched queries (no N+1 — the performance-docs rule and
 *     issueLinkCounts' precedent). issueLinkCounts reads present-time DEGREE;
 *     the backfill needs each edge's created_at to window it against the
 *     deferral period, hence this sibling read instead of a repoint.
 *   - saveDeferralModel / loadLatestDeferralModel: append-only model versions
 *     on harness_shared.deferral_pricing_model (migration 252) — INSERT only
 *     (UPDATE/DELETE are revoked at the GRANT level), latest-per-workspace on
 *     the read side, structurally guarded on the way out (a junk jsonb row
 *     degrades to "no model", never throws into the ranker).
 *
 * Timestamp params cross as ISO strings, never JS Date (the live org client
 * rejects Date params — agent-insights/db-org-client-rejects-js-date-params).
 */

import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { ISSUE_KIND } from '../issues-engineer';
import type { TimedEdge } from './outcomes';
import { isDeferralPricingModel, type DeferralPricingModel } from './model';

function toMs(ts: string | Date): number {
  return ts instanceof Date ? ts.getTime() : Date.parse(ts);
}

/**
 * Every relevant edge touching the given issues, with creation time:
 * outbound `blocks` (canonical work-item blocks plus polymorphic non-work blocks) + inbound non-tag references
 * (work pointing at it) — the same edge semantics issueLinkCounts counts.
 */
export async function readDeferralEdges(sql: Sql, issueIds: readonly string[]): Promise<TimedEdge[]> {
  if (issueIds.length === 0) return [];
  const ids = issueIds as string[];
  const [outRows, inRows] = await Promise.all([
    sql<{ issue_id: string; rel: string; created_at: string | Date }[]>`
      SELECT blocker_ref AS issue_id, dep_type AS rel, created_at
        FROM harness_shared.work_item_deps
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND blocker_kind = ${ISSUE_KIND}
         AND blocker_ref = ANY(${ids})
         AND dep_type = 'blocks'
      UNION ALL
      SELECT src_ref AS issue_id, rel, created_at
        FROM harness_shared.coord_links
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND src_kind = ${ISSUE_KIND}
         AND src_ref = ANY(${ids})
         AND rel = 'blocks'
         AND dst_kind NOT IN ('issue', 'feature')`,
    sql<{ issue_id: string; rel: string; created_at: string | Date }[]>`
      SELECT dst_ref AS issue_id, rel, created_at
        FROM harness_shared.coord_links
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND dst_kind = ${ISSUE_KIND}
         AND dst_ref = ANY(${ids})
         AND rel NOT IN ('tagged', 'blocks')`,
  ]);
  return [
    ...outRows.map<TimedEdge>((r) => ({ issueId: r.issue_id, direction: 'out', rel: r.rel, atMs: toMs(r.created_at) })),
    ...inRows.map<TimedEdge>((r) => ({ issueId: r.issue_id, direction: 'in', rel: r.rel, atMs: toMs(r.created_at) })),
  ];
}

/** Append one trained model version (history — never overwrites a prior fit). */
export async function saveDeferralModel(
  sql: Sql,
  workspaceId: string,
  model: DeferralPricingModel,
  createdBy = 'system:deferral-interest-refit',
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.deferral_pricing_model
      (workspace_id, trained_at, model, sample_items, sample_weeks, created_by)
    VALUES (${workspaceId}, ${model.trainedAt}, ${JSON.stringify(model)}::text::jsonb,
            ${model.totalItems}, ${model.totalWeeks}, ${createdBy})`;
}

/** Latest trained model for the workspace; null when none (or a junk row). */
export async function loadLatestDeferralModel(sql: Sql, workspaceId: string): Promise<DeferralPricingModel | null> {
  const rows = await sql<{ model: unknown }[]>`
    SELECT model FROM harness_shared.deferral_pricing_model
     WHERE workspace_id = ${workspaceId}
     ORDER BY trained_at DESC, id DESC
     LIMIT 1`;
  const candidate = rows[0]?.model;
  return isDeferralPricingModel(candidate) ? candidate : null;
}
