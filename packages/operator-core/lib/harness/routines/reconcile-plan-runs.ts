/**
 * Run completion tracking for scheduled plan runs.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (Phase 5 data; unblocks P-012/P-013).
 *
 * A `system:plan-run` fire mints a `plan_runs` row at status='running' + work_items the
 * harness dispatcher executes. Nothing settles the run when those work_items finish —
 * this reconcile does: for each running SCHEDULED run, once ALL its work_items
 * (payload.plan_run.runId = the run) are terminal, it sets the run's `outcome`
 * (success | partial | failed), `status` (done | failed), and `finished_at` (→ duration).
 * A run with no work_items (a prose plan) settles immediately as success.
 *
 * Idempotent + cheap (indexed by hfc_source_plan_run_idx, mig 300). Called before the
 * plans:runs read (the v1 poll, mirroring sweepPlanRuns) and by the routine tick.
 * `sql` is a seam (admin pool in prod, testcontainers client in tests).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { disarmPlanSchedule } from './arm-plan-schedule';
import { autoPauseOnCostBreach } from './plan-run-cost';
import { routineStorageSlug } from '../../pot-membership';
import { retireRunInstancePlan } from './retire-run-instance-plan';
// The orphan threshold has ONE definition; this module drives the same reclaim on the
// tick rather than re-deciding what "orphaned" means (see sweepOrphanedPlanRuns below).
import { PLAN_RUN_ORPHAN_FAIL_MS } from '../../agent-tools/plans/runs';

/** Work-item states that count as a finished execution. */
const TERMINAL = ['passed', 'done', 'resolved', 'closed', 'deprecated', 'dropped', 'failed'];
const PASSED = ['passed', 'done', 'resolved', 'closed'];
const FAILED = ['failed', 'dropped', 'deprecated'];

export type RunOutcome = 'success' | 'partial' | 'failed';

export interface ReconcileResult {
  /** Runs settled this pass. */
  reconciled: number;
  /** Per-settled-run outcomes (for the caller / P-012 auto-pause). */
  settled: Array<{ runId: number; harnessSlug: string; planSlug: string; outcome: RunOutcome }>;
}

/**
 * Settle every running scheduled run whose work_items have all terminated.
 * `harnessSlug` optionally scopes the pass to one harness.
 */
export async function reconcileScheduledPlanRuns(
  opts: { sql?: Sql; harnessSlug?: string } = {},
): Promise<ReconcileResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const harnessFilter = opts.harnessSlug ? db`AND harness_slug = ${opts.harnessSlug}` : db``;
  const running = await db<
    Array<{
      id: number;
      harness_slug: string;
      plan_slug: string;
      workspace_id: string;
      instance_plan_slug: string | null;
      launched_at: string | number | null;
    }>
  >`
    SELECT id, harness_slug, plan_slug, workspace_id, instance_plan_slug, launched_at
      FROM harness_shared.plan_runs
     WHERE run_type = 'scheduled' AND status = 'running' ${harnessFilter}
  `;

  const settled: ReconcileResult['settled'] = [];
  for (const run of running) {
    const wis = await db<Array<{ status: string }>>`
      SELECT status FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${run.harness_slug}
         AND payload -> 'plan_run' ->> 'runId' = ${String(run.id)}
    `;
    // Still in flight — leave it running.
    if (wis.length > 0 && !wis.every((w) => TERMINAL.includes(w.status))) continue;

    // Zero work-items is success ONLY for a genuinely item-less (prose) plan. An
    // instance that still has open items but no work-items means promotion never
    // completed — the fire threw, or died, between its seed transaction and
    // promotion. Reading that as success is how every refused plan-cleanup sweep
    // fire was recorded done/success (WI-10004731). Wait out the grace window so
    // an in-flight promotion is never raced, then settle it failed.
    let unpromoted = false;
    if (wis.length === 0) {
      const openItems = await countOpenInstanceItems(db, run);
      if (openItems > 0) {
        const launchedAt = run.launched_at == null ? null : Number(run.launched_at);
        if (launchedAt != null && Date.now() - launchedAt < PLAN_RUN_PROMOTION_GRACE_MS) continue;
        unpromoted = true;
      }
    }

    const passed = wis.filter((w) => PASSED.includes(w.status)).length;
    const failed = wis.filter((w) => FAILED.includes(w.status)).length;
    const outcome: RunOutcome = unpromoted
      ? 'failed'
      : wis.length === 0 || failed === 0
        ? 'success'
        : passed === 0
          ? 'failed'
          : 'partial';
    const status = outcome === 'failed' ? 'failed' : 'done';
    const now = Date.now();

    // A scheduled fire creates two lifecycle rows: the plan_runs ledger above and an
    // ephemeral `<template>@run-…` harness_plans instance. Keep the instance in sync
    // with the ledger when the run settles. The UI projection deliberately drops
    // terminal instances, so leaving this row active makes every finished run remain
    // visible (and causes unbounded coord.plans growth).
    //
    // plan_runs stores the raw install slug while harness_plans is Hive-scoped. Resolve
    // the latter with the same mapping used by plan-run-action before updating it.
    //
    // Retire through `retireRunInstancePlan`, never a bare `UPDATE … status='superseded'`:
    // that left every never-promoted `plan_items` row open forever (28 phantom-open items
    // on 10 superseded instances, WI-10005040). The helper closes the items with the status.
    if (run.instance_plan_slug) {
      const planStorageSlug = await routineStorageSlug(run.harness_slug, run.workspace_id);
      await retireRunInstancePlan(db, {
        workspaceId: run.workspace_id,
        planStorageSlug,
        instanceSlug: run.instance_plan_slug,
        templateSlug: run.plan_slug,
        outcome,
      });
    }

    await db`
      UPDATE harness_shared.plan_runs
         SET status = ${status}, outcome = ${outcome}, finished_at = ${now}, updated_at = ${now}
             ${unpromoted ? db`, note = ${'promotion never completed: the instance has open items but the run minted no work-items'}` : db``}
       WHERE id = ${run.id}
    `;
    settled.push({ runId: run.id, harnessSlug: run.harness_slug, planSlug: run.plan_slug, outcome });
  }
  return { reconciled: settled.length, settled };
}

/**
 * How long a scheduled run may sit with zero work-items before reconcile treats
 * its promotion as never completed. Promotion runs right after the seed
 * transaction commits, so a few seconds is normal; ten minutes is generous.
 */
export const PLAN_RUN_PROMOTION_GRACE_MS = 10 * 60_000;

/** Non-terminal items on a run's instance plan (0 for a prose plan or a missing instance). */
async function countOpenInstanceItems(
  db: Sql,
  run: { harness_slug: string; workspace_id: string; instance_plan_slug: string | null },
): Promise<number> {
  if (!run.instance_plan_slug) return 0;
  const planStorageSlug = await routineStorageSlug(run.harness_slug, run.workspace_id);
  const rows = await db<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_plans p,
           jsonb_array_elements(COALESCE(p.items, '[]'::jsonb)) AS item
     WHERE p.workspace_id = ${run.workspace_id}
       AND p.harness_slug = ${planStorageSlug}
       AND p.plan_slug = ${run.instance_plan_slug}
       AND COALESCE(item ->> 'status', 'todo') NOT IN ('done', 'dropped')
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Reclaim ORPHANED scheduled runs on the tick — a run left `running` by a process that
 * died before it could settle.
 *
 * `sweepPlanRuns` (agent-tools/plans/runs.ts) already implements this transition, but its
 * ONLY caller is the `plans:runs` read — "that read *is* the v1 poll, so no background
 * timer is needed". That assumption fails in exactly the case the sweep exists for: when a
 * run is orphaned because nobody is around, nobody is calling `plans:runs` either, so the
 * row stays `running` indefinitely. That is not merely a stale row, because
 * `runScheduledPlanFire` (plan-run-action.ts, concurrency='skip') refuses to mint a new run
 * while ANY run of the same template is `running` — so ONE unreclaimed orphan silently
 * disables the whole schedule, and the routine keeps ticking and minting nothing.
 *
 * Measured instance (2026-08-16): `blender-steward-heartbeat-2026-08-11` is the recovery
 * heartbeat whose entire job is to relaunch a dead Blender GOAL steward. The steward died;
 * run 958 was therefore never executed and stayed `running` from 2026-08-15T06:01; every
 * later fire skipped (routines.last_fired_at advanced to 2026-08-16T00:02:07Z with zero runs
 * minted) — so the recovery mechanism was disabled precisely while the thing it recovers was
 * down, and stayed down ~21h. The failure is also SELF-CONCEALING: reading the Runs tab is
 * what repairs it, so it cannot be observed without being fixed by the act of observing.
 *
 * This is the same wiring defect the tick call site already documents one layer down
 * ("reconcile-plan-runs.ts was implemented + tested but never wired"), recurring on the
 * function that reconcile itself cannot cover: reconcile settles runs whose work_items all
 * TERMINATED, and an orphan's work_item never terminates.
 *
 * Ordering: callers reconcile FIRST and sweep the residue, so a genuinely-finished run is
 * settled with a real `outcome` and only the true orphans are force-failed (status only —
 * the same shape `sweepPlanRuns` writes).
 */
export async function sweepOrphanedPlanRuns(
  opts: { sql?: Sql; harnessSlug?: string; now?: number } = {},
): Promise<{ failed: number }> {
  const db = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now();
  const harnessFilter = opts.harnessSlug ? db`AND harness_slug = ${opts.harnessSlug}` : db``;
  const rows = await db<Array<{ id: number }>>`
    UPDATE harness_shared.plan_runs
       SET status = 'failed', updated_at = ${now}
     WHERE run_type = 'scheduled'
       AND status = 'running'
       AND updated_at < ${now - PLAN_RUN_ORPHAN_FAIL_MS} ${harnessFilter}
    RETURNING id
  `;
  return { failed: rows.length };
}

/** Default consecutive-failure threshold before a schedule auto-pauses (D-011). */
export const DEFAULT_FAILURE_STREAK = 3;

/**
 * Failure auto-pause (P-012, D-011): if a template's last `k` SETTLED scheduled runs all
 * failed, disarm its schedule (stop a broken routine from firing forever). Only acts on a
 * currently-armed template. The auto-paused state IS the notification — the schedule shows
 * disarmed + the failed-run streak in the Runs tab / Calendar.
 */
export async function autoPauseOnFailureStreak(opts: {
  sql?: Sql;
  harnessSlug: string;
  planSlug: string;
  k?: number;
}): Promise<{ paused: boolean; failures: number }> {
  const db = opts.sql ?? getOrgPg().sql;
  const k = opts.k ?? DEFAULT_FAILURE_STREAK;

  const tpl = await db<Array<{ workspace_id: string; schedule_active: boolean }>>`
    SELECT workspace_id, schedule_active FROM harness_shared.harness_plans
     WHERE harness_slug = ${opts.harnessSlug} AND plan_slug = ${opts.planSlug}`;
  if (!tpl[0] || !tpl[0].schedule_active) return { paused: false, failures: 0 };

  const recent = await db<Array<{ outcome: string | null }>>`
    SELECT outcome FROM harness_shared.plan_runs
     WHERE harness_slug = ${opts.harnessSlug} AND plan_slug = ${opts.planSlug}
       AND run_type = 'scheduled' AND status IN ('done', 'failed')
     ORDER BY launched_at DESC
     LIMIT ${k}`;
  const failures = recent.filter((r) => r.outcome === 'failed').length;

  if (recent.length >= k && failures === k) {
    await disarmPlanSchedule({
      sql: db,
      workspaceId: tpl[0].workspace_id,
      harnessSlug: opts.harnessSlug,
      templateSlug: opts.planSlug,
    });
    console.warn(
      `[plan-run] auto-paused schedule '${opts.planSlug}' (${opts.harnessSlug}) — ${k} consecutive failed runs`,
    );
    return { paused: true, failures };
  }
  return { paused: false, failures };
}

/**
 * One settle+govern pass for the routine tick / plans:runs read: reconcile completions,
 * then auto-pause a template on either guardrail —
 *   - cost breach (P-013 / D-018): a freshly-settled run (any outcome) whose attributed
 *     spend exceeds the per-plan costCapCents; and
 *   - failure streak (P-012 / D-011): a freshly-failed run completing K consecutive fails.
 * Cost is checked first (a successful-but-expensive run still pauses); a template paused on
 * cost is not re-checked for the streak.
 *
 * NOTE (Task-#8, 2026-07-03): the interval-LOOP rebase (reconcileLoopRoutines) no longer
 * rides here. It used to run at the tail of this function — position #10 of 11 serial
 * tick sweeps — where pool starvation starved it and armed loops sat parked ~17 min
 * between 60s wakes. It is now its OWN `loop-rebase-sweep` step immediately after the
 * fire loop in routinesTickImpl (routines-workflow.ts). Do not re-add it here.
 */
export async function reconcileAndGovern(
  opts: { sql?: Sql; harnessSlug?: string; failureStreakK?: number } = {},
): Promise<{ reconciled: number; paused: string[]; orphaned: number }> {
  const db = opts.sql ?? getOrgPg().sql;
  const { settled } = await reconcileScheduledPlanRuns({ sql: db, harnessSlug: opts.harnessSlug });
  const paused: string[] = [];
  for (const s of settled) {
    // Cost-breach pause — independent of outcome (a successful run can be too expensive).
    const c = await autoPauseOnCostBreach({
      sql: db,
      harnessSlug: s.harnessSlug,
      planSlug: s.planSlug,
      runId: s.runId,
    });
    if (c.paused) {
      paused.push(s.planSlug);
      continue; // already disarmed — don't double-process the streak
    }
    // Failure-streak pause — failed runs only.
    if (s.outcome !== 'failed') continue;
    const r = await autoPauseOnFailureStreak({
      sql: db,
      harnessSlug: s.harnessSlug,
      planSlug: s.planSlug,
      k: opts.failureStreakK,
    });
    if (r.paused) paused.push(s.planSlug);
  }

  // Orphan reclamation rides the SAME tick — see sweepOrphanedPlanRuns. Deliberately last:
  // reconcile above settles every run whose work_items terminated (recording a real
  // `outcome`), so what remains `running` past the threshold is a true orphan. Without this
  // the reclaim only ever happens when a human opens the Runs tab, and one orphan wedges the
  // template's whole schedule via concurrency='skip'.
  const orphaned = await sweepOrphanedPlanRuns({ sql: db, harnessSlug: opts.harnessSlug });

  return { reconciled: settled.length, paused, orphaned: orphaned.failed };
}
