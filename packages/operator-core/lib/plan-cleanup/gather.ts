/**
 * plan-cleanup/gather — the I/O half of the deterministic clean-up scanner
 * (cleanup-report-flows-2026-08-24 P-003). Reads the rows scanner.ts scans and
 * hands them over as plain inputs; ALL judgment lives in the pure scan.
 *
 * Reuse-first: the hard parts are NOT re-derived here —
 *   - plan-item ↔ work-item coverage (edges across the workspace-split link
 *     plane + payload.plan_item stamps, liveness-fused) comes from the
 *     canonical {@link getAllPlanItemCoverage} map (plan-item-coverage.ts),
 *     which already dodges the fixed-workspace edge trap and the postgres-js
 *     jsonb binding quirk documented there;
 *   - claim-holder liveness mirrors stale-claims.ts's reaper predicate
 *     verbatim (coord_presence heartbeat ∪ running spawned_agents aliases), so
 *     an orphaned-claim finding can never disagree with what the reaper would
 *     actually reap.
 *
 * Membership contract (Requirements): `planSlugs` is a CLICK-TIME SNAPSHOT of
 * exactly the plans the pane was showing — required, never re-derived from a
 * filter here.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getAllPlanItemCoverage } from '../plan-item-coverage';
import { planItemRef } from '../issue-blocks-merge';
import {
  DEFAULT_CLAIM_GRACE_MS,
  type CleanupPlanInput,
  type CleanupPlanItemInput,
  type CleanupScanInputs,
  type LinkedWorkItemInput,
  type PlanItemClaimInput,
} from './scanner';

export interface CleanupGatherScope {
  workspaceId: string;
  harnessSlug: string;
  /** Click-time snapshot: exactly the plans the pane was showing. */
  planSlugs: string[];
  /** Holder-liveness window for the claim read (default mirrors the reaper). */
  claimGraceMs?: number;
}

interface PlanRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  title: string | null;
  status: string | null;
  op_status: string | null;
  op_priority: number | null;
  created_at_ms: number | null;
  archived: boolean;
  updated_at_ms: number | null;
  now_state: string | null;
  now_next: string | null;
  items: unknown;
}

interface RawPlanItem {
  id?: unknown;
  text?: unknown;
  status?: unknown;
  blockedBy?: unknown;
}

function toPlanItems(items: unknown): CleanupPlanItemInput[] {
  if (!Array.isArray(items)) return [];
  const out: CleanupPlanItemInput[] = [];
  for (const raw of items as RawPlanItem[]) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue;
    out.push({
      id: raw.id,
      text: typeof raw.text === 'string' ? raw.text : '',
      status: typeof raw.status === 'string' && raw.status !== '' ? raw.status : 'todo',
      blockedBy: Array.isArray(raw.blockedBy)
        ? raw.blockedBy.filter((b): b is string => typeof b === 'string' && b !== '')
        : [],
    });
  }
  return out;
}

/**
 * Gather every scanner input for the snapshot of plans. Pure read — no writes,
 * no locks; the resolver re-verifies each candidate at current state before it
 * ever acts, so a row changing under this read costs nothing but a stale
 * candidate the re-verify discards.
 */
export async function gatherCleanupInputs(scope: CleanupGatherScope): Promise<CleanupScanInputs> {
  if (scope.planSlugs.length === 0) {
    return { plans: [], linkedWorkItems: [], claims: [], goalWorklist: null };
  }
  const { sql } = getOrgPg();

  // ── 1. the plans themselves (items jsonb → plain item rows) ──────────────
  const planRows = await sql<PlanRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, title, status, op_status, op_priority, archived,
           (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS created_at_ms,
           (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_at_ms,
           now_state, now_next, items
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ANY(${scope.planSlugs})
       AND is_legacy = false`;

  const plans: CleanupPlanInput[] = planRows.map((r) => ({
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    title: r.title,
    status: r.status,
    opStatus: r.op_status,
    opPriority: r.op_priority,
    createdAtMs: r.created_at_ms,
    archived: r.archived,
    updatedAtMs: r.updated_at_ms,
    nowState: r.now_state,
    nowNext: r.now_next,
    items: toPlanItems(r.items),
  }));

  // ── 2. coverage links per item (edges + stamps, liveness-fused) ──────────
  const coverage = await getAllPlanItemCoverage();
  const linkedWorkItems: LinkedWorkItemInput[] = [];
  const linkedIds = new Set<string>();
  for (const plan of plans) {
    for (const item of plan.items) {
      const cov = coverage.get(planItemRef(plan.planSlug, item.id));
      if (!cov) continue;
      for (const link of cov.links) {
        linkedWorkItems.push({
          planSlug: plan.planSlug,
          itemId: item.id,
          workItemId: link.workItemId,
          state: null, // resolved from the base table below
          terminal: link.terminal,
          hasCompletion: false, // resolved below
          link: link.rel,
        });
        linkedIds.add(link.workItemId);
      }
    }
  }

  // ── 3. resolve linked work-items' state + completion evidence ────────────
  // One base-table read (harness_shared.work_items is the unified row-space
  // across both families, migration 374). A feature_id is unique only per
  // (workspace, harness); an ambiguous cross-scope id resolves to its newest
  // row here — acceptable for CANDIDATE emission because the resolver
  // re-verifies by the family-correct lookup before acting.
  if (linkedIds.size > 0) {
    const wiRows = await sql<{ feature_id: string; status: string; has_completion: boolean; updated_ts: string | number | null }[]>`
      SELECT feature_id, status, (completion_ref IS NOT NULL) AS has_completion, updated_ts
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${[...linkedIds]})`;
    const byId = new Map<string, { status: string; hasCompletion: boolean; updatedTs: number }>();
    for (const row of wiRows) {
      const ts = Number(row.updated_ts ?? 0);
      const prev = byId.get(row.feature_id);
      if (!prev || ts > prev.updatedTs) {
        byId.set(row.feature_id, { status: row.status, hasCompletion: row.has_completion, updatedTs: ts });
      }
    }
    for (const link of linkedWorkItems) {
      const wi = byId.get(link.workItemId);
      if (wi) {
        link.state = wi.status;
        link.hasCompletion = wi.hasCompletion;
      }
    }
  }

  // ── 4. claims + holder liveness (verbatim mirror of stale-claims.ts's
  //       live_holder CTE, read-only) ───────────────────────────────────────
  const graceSec = Math.max(1, Math.round((scope.claimGraceMs ?? DEFAULT_CLAIM_GRACE_MS) / 1000));
  const claimRows = await sql<{ plan_slug: string; item_id: string; owner: string; expires_at_ms: number; holder_alive: boolean }[]>`
    WITH live_holder AS (
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
         AND a.alias IS NOT NULL AND a.alias <> ''
    )
    SELECT c.plan_slug, c.item_id, c.owner,
           (EXTRACT(EPOCH FROM c.expires_ts) * 1000)::float8 AS expires_at_ms,
           EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = c.owner) AS holder_alive
      FROM harness_shared.plan_item_claims c
     WHERE c.workspace_id = ${scope.workspaceId}
       AND c.harness_slug = ${scope.harnessSlug}
       AND c.plan_slug = ANY(${scope.planSlugs})`;

  const claims: PlanItemClaimInput[] = claimRows.map((r) => ({
    planSlug: r.plan_slug,
    itemId: r.item_id,
    owner: r.owner,
    expiresAtMs: r.expires_at_ms,
    holderAlive: r.holder_alive,
  }));

  // ── 5. featured active standing goal + its typed worklist CAS envelope ──
  // Multiple standing goals are legal; P-012 targets the bundled first-party
  // Work-on-everything instance. If several instances are active, the most
  // recently updated one is the currently steered instance (same board rule).
  const goalRows = await sql<Array<{
    id: string;
    refs: unknown;
    version: number | string | null;
  }>>`
    SELECT id,
           COALESCE(properties->'worklist'->'value', '[]'::jsonb) AS refs,
           COALESCE((properties->'worklist'->>'version')::int, 0) AS version
      FROM harness_shared.goals
     WHERE workspace_id = ${scope.workspaceId}
       AND status = 'active'
       AND standing = true
       AND metadata->>'goalPackageRef' = 'work-on-everything'
       AND property_schema ? 'worklist'
     ORDER BY updated_at DESC, id ASC
     LIMIT 1`;
  const goal = goalRows[0];
  const goalWorklist = goal
    ? {
        goalId: goal.id,
        refs: Array.isArray(goal.refs)
          ? goal.refs.filter((ref): ref is string => typeof ref === 'string')
          : [],
        version: Number(goal.version ?? 0),
      }
    : null;

  return { plans, linkedWorkItems, claims, goalWorklist };
}
