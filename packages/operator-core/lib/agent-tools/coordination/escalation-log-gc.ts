/**
 * escalation-log-gc.ts — physical retention GC for the coord_event_log
 * `escalations` surface (sibling of notify-gc.ts).
 *
 * Plan: infra-fail-fast-build-integrity-2026-06-19, item C3/P-011 ("coord_event_log
 * retention — no cap on escalations/messages"). The escalations surface is the
 * dominant coord_event_log growth driver — ~35k rows, the bulk being operational
 * escalation lifecycle churn (raise + auto-reconciled resolution events, ~5k/day
 * during infra instability). The pre-existing archiveResolvedEscalations() (WI-239)
 * is a LOGICAL archive — it writes an extra `escalation_resolved` event, which
 * *adds* rows; nothing physically reclaims the surface, so it grows unbounded.
 *
 * This is that missing physical reclaim — a daily DBOS tick (periodic-workflows)
 * that DELETES resolved, fully-aged escalation FAMILIES.
 *
 * SAFETY (why this can't corrupt the escalations dashboard):
 *   • FAMILY-ATOMIC. Open/resolved state is derived at read time by folding the
 *     sibling `escalation_resolved` events against their `escalation` raise row
 *     (escalations.ts loadEscalations/foldEscalations). Deleting a resolution event
 *     while keeping its raise row would RESURRECT the escalation as "open" in the
 *     fold. So we delete the WHOLE family (the raise row + every resolution sibling)
 *     keyed by the open msg_id — the fold then sees neither, never resurrecting it.
 *   • RESOLVED-ONLY. A family is eligible only if it has ≥1 resolution event, so an
 *     OPEN (unresolved) escalation is never touched.
 *   • FULLY-AGED. Eligible only when the family's NEWEST event is older than the
 *     retention window — a recently-active escalation is never touched.
 *   • OPERATOR-SCOPE ONLY (harness_slug IS NULL). Harness-scoped coord rows federate
 *     (migration 150's DELETE trigger), so deleting one would propagate the deletion
 *     to peers. Restricting to harness_slug IS NULL means the DELETE never fires that
 *     trigger — no federated deletion. (All operational escalations are operator-scope.)
 *
 * Returns the number of rows deleted. Best-effort caller (the tick) tolerates errors.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Default retention for RESOLVED escalations — matches archiveResolvedEscalations's
 *  14-day TTL convention (escalations.ts), so the logical archive + physical reclaim
 *  share one horizon. */
export const ESCALATION_GC_RETENTION_DAYS = 14;

/** Max families deleted per run — a safety bound so a pathological first run can't
 *  take an oversized lock on the hot coord_event_log table; steady-state daily
 *  volume is far below this, and a backlog drains over a few ticks. */
export const ESCALATION_GC_FAMILY_LIMIT = 5000;

export async function gcResolvedEscalationFamilies(
  retentionDays = ESCALATION_GC_RETENTION_DAYS,
  familyLimit = ESCALATION_GC_FAMILY_LIMIT,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH fam AS (
      -- Group every escalations event by its escalation's open id (raise rows key on
      -- msg_id; resolution rows key on related_msg_id). Keep families that are
      -- RESOLVED and whose ENTIRE event set is older than the retention window.
      SELECT open_id
        FROM (
          SELECT COALESCE(body->>'related_msg_id', msg_id) AS open_id,
                 bool_or(body->>'kind' = 'escalation_resolved') AS has_resolved,
                 max(ts) AS newest_ts
            FROM harness_shared.coord_event_log
           WHERE surface = 'escalations'
             AND harness_slug IS NULL
           GROUP BY 1
        ) g
       WHERE g.has_resolved
         AND g.newest_ts < now() - make_interval(days => ${retentionDays})
       LIMIT ${familyLimit}
    ),
    d AS (
      DELETE FROM harness_shared.coord_event_log e
       WHERE e.surface = 'escalations'
         AND e.harness_slug IS NULL
         AND COALESCE(e.body->>'related_msg_id', e.msg_id) IN (SELECT open_id FROM fam)
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
