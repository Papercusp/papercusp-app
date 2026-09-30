/**
 * needs-human-work-items-source — the I/O half of the needs-human work-items
 * attention source (owner-inbox-single-pane-2026-07-17 P-005a).
 *
 * Reads needs-human work-items of EVERY kind — feature/chunk
 * (`status = 'needs-human'`) and bug/change/task (`payload.needsHuman`) — off
 * the single cross-kind `harness_shared.work_items` VIEW (unify-work-items
 * D-010(b)) rather than either per-kind reader, so neither family's dialect
 * is missed.
 *
 * Split out of the plans:attention handler so the read has a mockable module
 * path like every other attention source (operator-report-source,
 * triage-store, …). Inline `getOrgPg().sql` in the handler let the unit test
 * leak through to the live database: `vi.mock('@papercusp/db-org')` does not
 * reliably intercept a dynamic import fired inside the handler's Promise.all
 * fan-out (attention-parallel-db-org-mock-race-2026-07-17), and the hoisted
 * shared-import mitigation was not sufficient. Mock THIS module's path
 * instead — path-mocked helper modules are the pattern the rest of the
 * handler's sources already follow.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { observationLaneExclusionSql } from '../work-items';

/** One raw needs-human work-item row, as the attention mapper consumes it. */
export interface NeedsHumanWorkItemRow {
  feature_id: string;
  title: string | null;
  summary: string | null;
  harness_slug: string | null;
  item_kind: string | null;
  taken_by: string | null;
  /** Raw payload so reminder producers can render the structured owner ask
   *  (question / askedBy / unblock action) instead of a title-only nag. */
  payload: unknown;
  /** Last-updated timestamp of the row — drives the Inbox card date
   *  (inbox-pane-active-scope-dates-filters-2026-07-19). */
  updated_ts: string | null;
  /** Migration 896's lifecycle clock. Unlike updated_ts, metadata writes do
   *  not reset this age, so weekly stale reminders measure the current state
   *  episode rather than arbitrary row churn. NULL means legacy/unknown age. */
  state_changed_at: string | null;
  /** The row's lifecycle status. Selected so the shape can EXPRESS finishedness:
   *  before WI-5981 this column was not read at all, so no consumer downstream was
   *  even capable of filtering a completed item out of the owner's inbox. */
  status: string | null;
}

export const NEEDS_HUMAN_LIMIT = 300;

export async function readNeedsHumanWorkItems(opts?: {
  workspaceId?: string;
  /** Restrict to one harness_slug; null/undefined = all. */
  harness?: string | null;
  limit?: number;
  /** Optional lifecycle-age cutoff. Supplying it turns this into a stale read;
   *  legacy rows with unknown (NULL) state age are deliberately excluded. */
  stateChangedBefore?: string | Date;
  /** Stale reminder consumers want the oldest state episodes first. The owner
   *  inbox keeps its existing newest-updated ordering by default. */
  oldestFirst?: boolean;
}): Promise<NeedsHumanWorkItemRow[]> {
  const { sql } = getOrgPg();
  const wid = opts?.workspaceId ?? activeWorkspaceId();
  const hf = opts?.harness ?? null;
  const limit = opts?.limit ?? NEEDS_HUMAN_LIMIT;
  const stateChangedBefore =
    opts?.stateChangedBefore instanceof Date
      ? opts.stateChangedBefore.toISOString()
      : opts?.stateChangedBefore ?? null;
  const orderBy = opts?.oldestFirst
    ? sql`state_changed_at ASC NULLS LAST, feature_id ASC`
    : sql`updated_ts DESC NULLS LAST, feature_id ASC`;
  return await sql<NeedsHumanWorkItemRow[]>`
    SELECT feature_id, title, summary, harness_slug, item_kind, taken_by, payload,
           updated_ts, state_changed_at, status
      FROM harness_shared.work_items
     WHERE (workspace_id = ${wid} OR workspace_id = 'default')
       AND (${hf}::text IS NULL OR harness_slug = ${hf})
       -- WI-5981: a FINISHED item must never demand the owner's attention. Without
       -- this, every row that ever carried payload.needsHuman stayed in the inbox
       -- forever: measured live on papercusp 2026-07-26, 161 of 249 matching rows
       -- (65%) were already terminal (done 143 · dropped 11 · closed 7), so ~2 of
       -- every 3 cards in the owner's decision feed were completed work. The tier
       -- mapper scores these 'decision', and the Inbox scope predicate keeps every
       -- Decision REGARDLESS OF AGE, so nothing downstream could ever age them out.
       -- DERIVE the set from ANY_FAMILY_TERMINAL_STATES (both families are read
       -- here) — never re-list the words: EI-18653071581558556 is the same bug
       -- class, where a hand-copied union drifted and scored ~88% of finished
       -- units as phantom failures. The 'needs-human' status is not terminal, so
       -- the feature-family leg below is unaffected.
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       -- EI-21675115869134466: an agent's own end-of-turn NOTE is not an owner
       -- decision. D-005 makes payload.lane = 'observation' "never work-queue
       -- material", and migration 864 -- which retired this very payload.needsHuman
       -- dialect -- already carries a lane IS DISTINCT FROM 'observation' conjunct
       -- in its cohort. This read did not, so the rows 864 was RIGHT to skip were
       -- re-admitted here and sat in the owner's inbox indefinitely: measured live
       -- 2026-08-28, 3 of the 7 non-needs-human rows this source returned
       -- (EI-11718, EI-6512, EI-7149) were observation notes. DERIVE the predicate
       -- from observationLaneExclusionSql -- the same SSOT the claim path and
       -- diagnoseClaimNextMiss share -- never a hand-copied lane literal; a
       -- hand-copied union is exactly how EI-18653071581558556 drifted.
       AND ${observationLaneExclusionSql(sql, 'payload')}
       AND (
         ${stateChangedBefore}::timestamptz IS NULL
         OR (state_changed_at IS NOT NULL AND state_changed_at <= ${stateChangedBefore}::timestamptz)
       )
       AND (
         status = 'needs-human'
         OR (
           item_kind IN ('bug', 'change', 'task')
           AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
         )
       )
     -- Deterministic newest-first under the cap. The bare LIMIT had no ORDER BY,
     -- so once the row count crossed NEEDS_HUMAN_LIMIT the retained subset was
     -- whatever Postgres happened to return — real owner decisions would vanish
     -- silently and unreproducibly. (At 249 rows we were already at 83% of the
     -- cap, and the 161 terminal rows above were what would have pushed it over.)
     ORDER BY ${orderBy}
     LIMIT ${limit}
  `;
}
