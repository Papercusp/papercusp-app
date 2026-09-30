/**
 * blocked-work-items-source — the I/O half of the blocked work-items attention
 * source (curated-signal-cards-2026-07-17 P-001).
 *
 * Reads work-items of EVERY kind parked at `status = 'blocked'` off the single
 * cross-kind `harness_shared.work_items` VIEW, so neither the feature-family nor
 * the issue-family dialect is missed.
 *
 * WHY THIS EXISTS: the curated digest's `🚧 Blocked` chat line already scans
 * exactly this table (`curation/deps.ts readBlockedWorkItems()`, shipped in
 * curation-signal-gaps P-001), but NO attention source read `status='blocked'` —
 * source #11 reads only needs-human. So a blocked work-item surfaced as chat
 * text with no card anywhere to drill into, while a blocked PLAN item (source
 * #1) got a proper Alert card. This closes that asymmetry.
 *
 * The blocker REASON is derived with the same `activeExternalBlockers` helper
 * the curation reader uses, deliberately: the card and the chat line must agree
 * on why something is blocked, or the deep-link from one to the other reads as
 * two different facts.
 *
 * Split into its own module (rather than inline `getOrgPg().sql` in the
 * plans:attention handler) so the read has a mockable module path like every
 * other attention source — inline dynamic imports inside the handler's
 * Promise.all fan-out do NOT reliably intercept under `vi.mock`
 * (attention-parallel-db-org-mock-race-2026-07-17).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeExternalBlockers } from '../external-blockers';
import { activeWorkspaceId } from '../workspace-registry';

/** One blocked work-item row, as the attention mapper consumes it. */
export interface BlockedWorkItemRow {
  feature_id: string;
  title: string | null;
  /** The resolved "why it is blocked" line (external blockers, else summary). */
  reason: string;
  harness_slug: string | null;
  item_kind: string | null;
  taken_by: string | null;
  /** Last-updated timestamp of the row — drives the Inbox card date
   *  (inbox-pane-active-scope-dates-filters-2026-07-19). */
  updated_ts: string | null;
}

export const BLOCKED_WORK_ITEMS_LIMIT = 300;

export async function readBlockedWorkItems(opts?: {
  workspaceId?: string;
  /** Restrict to one harness_slug; null/undefined = all. */
  harness?: string | null;
  limit?: number;
}): Promise<BlockedWorkItemRow[]> {
  const { sql } = getOrgPg();
  const wid = opts?.workspaceId ?? activeWorkspaceId();
  const hf = opts?.harness ?? null;
  const limit = opts?.limit ?? BLOCKED_WORK_ITEMS_LIMIT;
  const rows = await sql<
    {
      feature_id: string;
      title: string | null;
      summary: string | null;
      harness_slug: string | null;
      item_kind: string | null;
      taken_by: string | null;
      payload: unknown;
      updated_ts: string | null;
    }[]
  >`
    SELECT feature_id, title, summary, harness_slug, item_kind, taken_by, payload, updated_ts
      FROM harness_shared.work_items
     WHERE (workspace_id = ${wid} OR workspace_id = 'default')
       AND (${hf}::text IS NULL OR harness_slug = ${hf})
       AND status = 'blocked'
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT ${limit}
  `;
  return rows.map((r) => {
    const active = activeExternalBlockers(r.payload);
    const reason =
      active.length > 0
        ? active.map((b) => b.summary).join('; ')
        : r.summary?.trim() || 'marked blocked';
    return {
      feature_id: r.feature_id,
      title: r.title,
      reason,
      harness_slug: r.harness_slug,
      item_kind: r.item_kind,
      taken_by: r.taken_by,
      updated_ts: r.updated_ts,
    };
  });
}
