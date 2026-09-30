/**
 * plan-parts/reconcile — the flag-gated LOCAL capture (send side) for per-part
 * plan federation (plan-federation-regrain-2026-06-13 P-005 capture + P-007 backfill).
 *
 * For each plan, decompose harness_plans.content into parts (parts.ts) and write
 * the CHANGED parts into harness_plan_parts with origin='local' (capturePlanParts),
 * so the capture trigger (mig 271) federates them per-part. Idempotent: the diff in
 * capturePlanParts means a re-run with unchanged content writes nothing — so the
 * FIRST run over a never-decomposed plan IS the P-007 backfill, and later runs are
 * incremental capture of edits.
 *
 * DARK: gated on papercusp-plan-part-federation. With the flag OFF
 * ensurePlanPartsReconciledOnce no-ops, so harness_plan_parts stays empty and
 * nothing federates — the live whole-blob path is byte-untouched.
 *
 * Best-effort everywhere: never throws (a per-plan failure folds into the result),
 * mirroring harness/git-sync/git-sync-reconcile.ts's posture so it can never wedge boot.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { PgPlanPartsStore, type PlanPartsStore } from './store';
import { capturePlanParts } from './federation';

export interface PlanContentRow {
  harness_slug: string;
  plan_slug: string;
  content: string;
}

export interface ReconcilePlanPartsDeps {
  workspaceId: string;
  sql?: Sql;
  /** Test seam — load the plans to decompose (default: non-archived harness_plans). */
  loadPlans?: (sql: Sql, workspaceId: string) => Promise<PlanContentRow[]>;
  /** Test seam — the per-(ws,harness) store factory (default: PgPlanPartsStore). */
  storeFor?: (sql: Sql, workspaceId: string, harnessSlug: string) => PlanPartsStore;
  /** Test seam — the local-capture timestamp (default: Date.now). Local edits are
   *  "now", so they win LWW over older remote state. */
  now?: () => number;
}

export interface ReconcilePlanPartsResult {
  plansScanned: number;
  partsWritten: number;
  errors: number;
}

async function defaultLoadPlans(sql: Sql, workspaceId: string): Promise<PlanContentRow[]> {
  return (await sql`
    SELECT harness_slug, plan_slug, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND archived = false
  `) as unknown as PlanContentRow[];
}

/**
 * Decompose every plan in a workspace into per-part rows (origin='local'),
 * writing only the changed parts. Never throws.
 */
export async function reconcilePlanParts(deps: ReconcilePlanPartsDeps): Promise<ReconcilePlanPartsResult> {
  const result: ReconcilePlanPartsResult = { plansScanned: 0, partsWritten: 0, errors: 0 };
  const sql = deps.sql ?? getOrgPg().sql;
  const storeFor = deps.storeFor ?? ((s, ws, h) => new PgPlanPartsStore(s, ws, h));
  const now = deps.now ?? (() => Date.now());

  let plans: PlanContentRow[];
  try {
    plans = await (deps.loadPlans ?? defaultLoadPlans)(sql, deps.workspaceId);
  } catch {
    result.errors++;
    return result;
  }

  for (const p of plans) {
    result.plansScanned++;
    try {
      const store = storeFor(sql, deps.workspaceId, p.harness_slug);
      const ops = await capturePlanParts(store, p.plan_slug, p.content, now(), 'local');
      result.partsWritten += ops.length;
    } catch {
      result.errors++;
    }
  }
  return result;
}

// ── Once-per-process boot trigger (mirrors git-sync-reconcile's posture) ────────
let _reconciledOnce = false;

/**
 * Fire the plan-parts reconcile once per process for the given workspaces,
 * detached + flag-gated. Synchronous + void: the caller never awaits it and it
 * never throws, so it can NEVER block or fail boot. With the flag OFF it is a
 * no-op (DARK). `seams` is the test seam; the boot site passes nothing.
 */
export function ensurePlanPartsReconciledOnce(
  workspaceIds: string[],
  seams?: Partial<Omit<ReconcilePlanPartsDeps, 'workspaceId'>> & { isFlagOn?: () => Promise<boolean> },
): void {
  if (_reconciledOnce) return;
  _reconciledOnce = true;
  void (async () => {
    try {
      const isFlagOn =
        seams?.isFlagOn ??
        (async () => {
          const { getFlag } = await import('@papercusp/flags/server');
          return getFlag(FLAGS.PLAN_PART_FEDERATION, 'system');
        });
      if (!(await isFlagOn())) return; // DARK: flag off → never run
      for (const workspaceId of workspaceIds) {
        await reconcilePlanParts({ workspaceId, ...seams });
      }
    } catch {
      /* best-effort: never wedge boot */
    }
  })();
}

/** Test-only — reset the once-flag. */
export function __resetPlanPartsReconcileOnceForTests(): void {
  _reconciledOnce = false;
}
