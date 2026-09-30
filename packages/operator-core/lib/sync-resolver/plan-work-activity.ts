/**
 * planWorkActivity.list — plan slug → last-WORK timestamp, the ⚒ half of the
 * PlansPane dual-timestamp pair and the HUD plan cards' "agents last moved"
 * signal (plan-visibility-revamp-2026-08-23 P-001, plan decision D-003).
 *
 * "Last work" is deliberately DISTINCT from the plan's own `updated` (the ✎
 * half, which moves on any plan-DOC edit): it is the most recent moment any
 * WORK-ITEM attributed to the plan (`source_plan_slug`) moved —
 * `GREATEST(updated_ts, last_progress_at)`, MAXed per plan. `updated_ts` is
 * epoch MILLISECONDS (verified live: max ≈ 1.7875e12) and `last_progress_at`
 * is timestamptz; both normalize to epoch ms here so the wire row carries one
 * comparable number. Postgres `GREATEST` ignores NULL arguments, so an item
 * that never recorded progress still contributes its `updated_ts`.
 *
 * Observation-lane rows are EXCLUDED (`lane IS DISTINCT FROM 'observation'`):
 * `harness_shared.work_items` also holds agents' end-of-turn reflection notes
 * under `lane='observation'`, and counting those as plan WORK would bump the ⚒
 * timestamp on plans nobody actually worked — the same over-count the
 * work_items tooling's `includeObservations:false` default exists to prevent
 * (measured 2026-08-17: 518 real filings vs 1001 unfiltered rows).
 *
 * One aggregate row per plan across the WHOLE workspace (the PlansPane lists
 * one workspace at a time and joins this map client-side by slug, exactly like
 * `needsYouByPlan` / `liveByPlan`). A plan with NO work-items simply has no
 * row — the pane renders the dim "never worked" em-dash from the map miss, so
 * absence is signal, not an error.
 *
 * Invalidation: `harness_shared.work_items` carries `emit_change_notify`, and
 * table-to-query-names.ts bridges its `.changed` to this name (full-bust — the
 * query is workspace-keyed, not row-keyed, so no per-row scope can match).
 * Declared as `backingTables` on the registry entry so the
 * resolver → table → invalidation chain stays guard-checked end to end.
 */
import type { Sql } from 'postgres';

/** One wire row: a plan that has at least one attributed work-item. */
export interface PlanWorkActivityRow {
  /** The plan's slug (`work_items.source_plan_slug`). */
  slug: string;
  /** Epoch ms of the most recent work-item movement attributed to the plan. */
  lastWorkAtMs: number;
}

/**
 * Coerce a Postgres bigint aggregate (which the postgres.js driver returns as
 * a string, and tests may supply as number/bigint) to finite positive epoch
 * ms, else null. Exported for the unit tests.
 */
export function coerceEpochMs(v: unknown): number | null {
  if (v == null) return null;
  const n =
    typeof v === 'bigint'
      ? Number(v)
      : typeof v === 'number'
        ? v
        : typeof v === 'string' && v.trim() !== ''
          ? Number(v)
          : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface RawRowish {
  slug?: unknown;
  last_work_at_ms?: unknown;
}

/**
 * Map raw SQL rows to wire rows, dropping anything unusable (empty slug, null
 * or non-numeric timestamp) rather than shipping a row the client would have
 * to defend against. Pure — this is the unit-tested seam.
 */
export function mapPlanWorkActivityRows(rows: readonly unknown[]): PlanWorkActivityRow[] {
  const out: PlanWorkActivityRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as RawRowish;
    const slug = typeof r.slug === 'string' ? r.slug.trim() : '';
    const lastWorkAtMs = coerceEpochMs(r.last_work_at_ms);
    if (!slug || lastWorkAtMs === null) continue;
    out.push({ slug, lastWorkAtMs });
  }
  return out;
}

/**
 * One aggregate query: slug → max(GREATEST(updated_ts, last_progress_at)) in
 * epoch ms, workspace-scoped, observation lane excluded. The `HAVING` skips a
 * group whose every member has neither timestamp (all-NULL `GREATEST` → NULL
 * max), so the wire never carries a row without a usable timestamp.
 */
export async function listPlanWorkActivity(opts: {
  workspaceId?: string | null;
  sql?: Sql;
}): Promise<PlanWorkActivityRow[]> {
  let sql = opts.sql;
  let workspaceId = opts.workspaceId ?? null;
  if (!sql) {
    const { getOrgPg } = await import('@papercusp/db-org');
    sql = getOrgPg().sql;
  }
  if (workspaceId == null || workspaceId === '') {
    // The pane lists the ACTIVE workspace's plans; scope the aggregate the same
    // way rather than a silent cross-workspace read (the WI-148 lesson).
    const { activeWorkspaceId } = await import('../workspace-registry');
    workspaceId = activeWorkspaceId();
  }
  const rows = (await sql.unsafe(
    `SELECT source_plan_slug AS slug,
            max(GREATEST(updated_ts, (extract(epoch FROM last_progress_at) * 1000)::bigint)) AS last_work_at_ms
       FROM harness_shared.work_items
      WHERE workspace_id = $1
        AND source_plan_slug IS NOT NULL AND source_plan_slug <> ''
        AND lane IS DISTINCT FROM 'observation'
      GROUP BY source_plan_slug
     HAVING max(GREATEST(updated_ts, (extract(epoch FROM last_progress_at) * 1000)::bigint)) IS NOT NULL`,
    [workspaceId],
  )) as unknown as unknown[];
  return mapPlanWorkActivityRows(rows);
}
