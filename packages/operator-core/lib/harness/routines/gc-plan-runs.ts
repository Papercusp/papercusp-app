/**
 * Retention / GC for scheduled plan runs (P-027, D-015).
 *
 * Plan: scheduled-recurring-plans-2026-06-16.
 *
 * An hourly plan accrues runs forever. Policy (D-015): keep the `plan_runs` LEDGER row
 * forever (cheap; it's the Runs-tab history), but GC each run's HEAVY artifacts once the
 * run is beyond the last-N for its template OR older than T days:
 *   • the instance plan (harness_plans row, slug = instance_plan_slug) — a per-run copy;
 *   • the transcript (plan_run_turns);
 *   • the run-scoped work_items (harness_features_consolidated, payload.plan_run.runId) —
 *     safe to delete: scheduled runs FRONTIER-MINT work items (no coord_links/implements
 *     edges, unlike convert-at-pickup), so nothing dangles.
 * Only terminal runs (done/failed/archived) are GC'd — never a running run. The DELETEs are
 * idempotent (a re-GC of an already-swept run is a no-op). `sql` is a seam.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export const KEEP_LAST_N_DEFAULT = 50;
export const MAX_AGE_DAYS_DEFAULT = 90;

export interface GcResult {
  /** Runs whose heavy artifacts were swept this pass. */
  gcRuns: number;
  instancePlans: number;
  workItems: number;
  transcriptTurns: number;
}

/**
 * Sweep heavy artifacts of old scheduled runs. Keeps the last `keepLastN` runs per template
 * and anything newer than `maxAgeDays`; GCs the rest. `now` is injectable for tests.
 */
export async function gcScheduledPlanRuns(
  opts: { sql?: Sql; harnessSlug?: string; keepLastN?: number; maxAgeDays?: number; now?: number } = {},
): Promise<GcResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const keepN = opts.keepLastN ?? KEEP_LAST_N_DEFAULT;
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeDays ?? MAX_AGE_DAYS_DEFAULT) * 86_400_000;
  const harnessFilter = opts.harnessSlug ? db`AND harness_slug = ${opts.harnessSlug}` : db``;

  // Candidate runs: terminal scheduled runs beyond the last-N for their template, OR older
  // than the age cutoff. ROW_NUMBER per (harness, template) newest-first.
  const candidates = await db<Array<{ id: number; instance_plan_slug: string | null }>>`
    WITH ranked AS (
      SELECT id, harness_slug, instance_plan_slug, launched_at,
             ROW_NUMBER() OVER (PARTITION BY harness_slug, plan_slug ORDER BY launched_at DESC) AS rn
        FROM harness_shared.plan_runs
       WHERE run_type = 'scheduled' AND status IN ('done', 'failed', 'archived') ${harnessFilter}
    )
    SELECT id, instance_plan_slug FROM ranked
     WHERE rn > ${keepN} OR launched_at < ${cutoff}
  `;
  if (candidates.length === 0) return { gcRuns: 0, instancePlans: 0, workItems: 0, transcriptTurns: 0 };

  const ids = candidates.map((c) => c.id);
  const idStrs = ids.map((i) => String(i));
  const instanceSlugs = candidates.map((c) => c.instance_plan_slug).filter((s): s is string => !!s);

  const turns = await db`DELETE FROM harness_shared.plan_run_turns WHERE plan_run_id = ANY(${ids}) RETURNING id`;
  const wis = await db`
    DELETE FROM harness_shared.harness_features_consolidated
     WHERE payload -> 'plan_run' ->> 'runId' = ANY(${idStrs}) RETURNING feature_id`;
  let plans = 0;
  if (instanceSlugs.length > 0) {
    const p = await db`DELETE FROM harness_shared.harness_plans WHERE plan_slug = ANY(${instanceSlugs}) RETURNING plan_slug`;
    plans = (p as unknown as unknown[]).length;
  }

  return {
    gcRuns: candidates.length,
    instancePlans: plans,
    workItems: (wis as unknown as unknown[]).length,
    transcriptTurns: (turns as unknown as unknown[]).length,
  };
}
