/**
 * Zero-promotion detector (unified-work-item-ledger-2026-06-21 P-009).
 *
 * The recurrence guard for the promotion gap (P-003): a plan that is started +
 * eligible and carries OPEN plan-items but has ZERO work-items means plan→work-item
 * promotion silently produced nothing for it. Historically that starved placement and
 * left the Queen idle before P-003; with the Mug/Kettle tier RETIRED nothing places
 * work from plans any more, so the surviving cost is ATTRIBUTION — directly-filed
 * work carries no source_plan_slug and cannot be joined back to the plan. The finding
 * is worded and ranked for that smaller harm (EI-20119196410091151); do not restore
 * the old "nothing to place" phrasing, which invites minting duplicate work-items for
 * items already in flight. This module is the PURE detection core (a filter over
 * per-plan counts); it has NO I/O, so it is fully unit-testable.
 *
 * Wiring (LIVE — WI-707): registered as the `papercusp-zero-promotion` collector in
 * `defaultPapercuspCollectors` (watchdog.ts), with `'zero-promotion'` in the
 * WatchdogSource union. `collectZeroPromotionSignals` below still self-gates on the
 * `papercusp-plan-workitem-promotion` flag (early-return [] when OFF) so it stays
 * inert if promotion is ever turned back dark — but the flag is NOT in DARK_FLAGS
 * (libs/flags/src/types.ts), so per the flag-default-inversion (P-011) it defaults
 * ON: promotion, this detector, and its watchdog signal are all live in production.
 */

/** Per-plan counts the detector reasons over (one row per started+eligible plan). */
export interface PlanPromotionCount {
  planSlug: string;
  harnessSlug: string;
  /** Plan-items that are NOT done/dropped (what promotion would mint work for). */
  openItemCount: number;
  /** Of those open items, how many are already `wip`. When every open item is wip the
   *  work is in-flight and OWNED, so the residual cost is attribution only — minting
   *  work-items there would duplicate work someone is already doing. Optional so the
   *  pure detector stays callable from tests/callers that do not supply it. */
  wipItemCount?: number;
  /** Work-items whose source_plan_slug is this plan (any non-terminal state). */
  workItemCount: number;
  /** An open SPEC TRIAD filing explains this intentional zero-conversion. */
  specTriadBlocked?: boolean;
}

/** A zero-promotion finding, shaped to map directly onto a WatchdogSignal at the
 *  (attended) collector site. Its own type so this pure module needs no import
 *  from the large watchdog.ts (and no dependency on the WatchdogSource union). */
export interface ZeroPromotionFinding {
  source: 'zero-promotion';
  /** dedup key — the plan slug. */
  key: string;
  title: string;
  body: string;
  /** `minor`, not `major`: with the Mug/Kettle tier retired nothing places work from
   *  plans any more, so zero promotion no longer starves a placement loop — it costs
   *  ATTRIBUTION (directly-filed work carries no source_plan_slug). A real but small
   *  reporting gap, and severity is what triage ranks on (EI-20119196410091151). */
  severity: 'minor';
  /** harness:<slug> so triage keys off the owning hive. */
  scope: string;
  findingClass: 'promotion:zero-conversion';
}

/**
 * Find plans that are started+eligible with open items but ZERO work-items. Pure:
 * the caller supplies the counts (read from PG behind the promotion flag). A plan
 * with no open items, or with at least one work-item, is healthy → no finding.
 */
export function detectZeroPromotion(plans: readonly PlanPromotionCount[]): ZeroPromotionFinding[] {
  return plans
    .filter((p) => p.openItemCount > 0 && p.workItemCount === 0 && !p.specTriadBlocked)
    .map((p) => {
      // Every open item already wip ⇒ the work is in flight and OWNED. This is the case
      // where the old "nothing to place" wording was most misleading: it reads as starved
      // input and invites "make promotion fire", which on a nearly-finished plan mints
      // work-items for work that is already being done (EI-20119196410091151).
      const allWip = p.wipItemCount !== undefined && p.wipItemCount === p.openItemCount;
      return {
        source: 'zero-promotion' as const,
        key: p.planSlug,
        title: `Started plan has open items but zero work-items: ${p.planSlug}`,
        body:
          `Plan ${p.planSlug} (${p.harnessSlug}) has ${p.openItemCount} open plan-item(s) but 0 work-items. ` +
          `Work delivered under this plan will not be attributable to it: items filed directly ` +
          `(improvements:capture / work_items:create) carry no source_plan_slug, so the plan cannot be ` +
          `joined to the work that delivered it. ` +
          (allWip
            ? `All ${p.openItemCount} open item(s) are already wip — in flight and owned. Do NOT mint ` +
              `work-items for them; the gap here is attribution only.`
            : `If these items are genuinely unstarted, promotion producing zero work-items is worth a look.`) +
          ` (unified-work-item-ledger P-003/P-009.)`,
        severity: 'minor' as const,
        scope: `harness:${p.harnessSlug}`,
        findingClass: 'promotion:zero-conversion' as const,
      };
    });
}

/**
 * The PG read that feeds the pure detector (unified-work-item-ledger P-009). Counts,
 * per STARTED + non-archived plan in the workspace, its OPEN plan-items (the JSONB
 * `items` array, status NOT done/dropped) and its work-items (by `source_plan_slug`,
 * ANY state — a single ever-minted work-item, even since completed, proves promotion
 * ran, so this is the conservative "promotion never produced placeable work" signal
 * and not a per-item gap detector). An open SPEC TRIAD filing is also read as an
 * intentional promotion hold, because the promotion runner refuses that plan and
 * the filing is the claimable exit. The detector then keeps only plans with open
 * items + zero work-items and no active triad hold.
 *
 * Gated by `papercusp-plan-workitem-promotion`: while promotion is dark it produces
 * nothing by design, so firing would be pure noise → return a 'dark' note and no
 * signals. Now that the flag is ON, a finding means promotion genuinely broke for
 * that plan (the recurrence guard for the P-003 silent-zero class).
 *
 * One workspace-scoped query, LIMITed — cheap enough for the per-tick watchdog.
 */
export async function collectZeroPromotionSignals(
  workspaceId: string,
): Promise<{ signals: ZeroPromotionFinding[]; note?: string }> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const { systemDistinctId } = await import('../../flag-distinct-id');
  const enabled = await getFlag(FLAGS.PLAN_WORKITEM_PROMOTION, systemDistinctId());
  if (!enabled) return { signals: [], note: 'dark: papercusp-plan-workitem-promotion OFF' };

  const { getOrgPg } = await import('@papercusp/db-org');
  const { SPEC_TRIAD_NON_TERMINAL_STATUSES } = await import(
    '../../agent-tools/plans/spec-triad-filing'
  );
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      harness_slug: string;
      plan_slug: string;
      open_items: number;
      wip_items: number;
      work_items: number;
      spec_triad_blocked: boolean;
    }[]
  >`
    WITH started AS (
      SELECT harness_slug, plan_slug, items
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND op_status = 'started'
         AND COALESCE(archived, false) = false
    ),
    open_counts AS (
      SELECT s.harness_slug, s.plan_slug,
             COUNT(*) FILTER (
               WHERE COALESCE(it->>'status', 'todo') NOT IN ('done', 'dropped')
             )::int AS open_items,
             COUNT(*) FILTER (
               WHERE COALESCE(it->>'status', 'todo') = 'wip'
             )::int AS wip_items
        FROM started s
        LEFT JOIN LATERAL jsonb_array_elements(COALESCE(s.items, '[]'::jsonb)) it ON true
       GROUP BY s.harness_slug, s.plan_slug
    ),
    wi_counts AS (
      SELECT source_plan_slug AS plan_slug, harness_slug, COUNT(*)::int AS work_items
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug IS NOT NULL
       GROUP BY source_plan_slug, harness_slug
    )
    SELECT o.harness_slug, o.plan_slug, o.open_items, o.wip_items,
           COALESCE(w.work_items, 0) AS work_items,
           EXISTS (
             SELECT 1
               FROM harness_shared.work_items triad
              WHERE triad.workspace_id = ${workspaceId}
                AND triad.harness_slug = o.harness_slug
                AND triad.payload->>'specTriadPlan' =
                    ${workspaceId} || '/' || o.harness_slug || '/' || o.plan_slug
                AND triad.status = ANY(${SPEC_TRIAD_NON_TERMINAL_STATUSES})
           ) AS spec_triad_blocked
      FROM open_counts o
      LEFT JOIN wi_counts w
        ON w.plan_slug = o.plan_slug AND w.harness_slug = o.harness_slug
     WHERE o.open_items > 0
     ORDER BY o.open_items DESC
     LIMIT 50
  `;
  const counts: PlanPromotionCount[] = rows.map((r) => ({
    planSlug: r.plan_slug,
    harnessSlug: r.harness_slug,
    openItemCount: Number(r.open_items),
    wipItemCount: Number(r.wip_items),
    workItemCount: Number(r.work_items),
    specTriadBlocked: r.spec_triad_blocked,
  }));
  return { signals: detectZeroPromotion(counts) };
}
