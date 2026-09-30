/**
 * Run-level cost attribution + the per-plan cost cap (P-013 / D-018).
 *
 * Plan: scheduled-recurring-plans-2026-06-16. v1 (D-012) stored a per-plan
 * `costCapCents` + warned at author time; this is the deferred HARD enforcement
 * (D-018): attribute a scheduled run's actual spend and auto-pause the schedule
 * when a run breaches the cap — the cost sibling of the failure-streak auto-pause.
 *
 * Cost attribution chain (no per-spawn cost column exists; cost lives in the
 * usage-samples table, keyed by the spawn run_id):
 *   run's work_items (payload.plan_run.runId)
 *     → spawned_agents      (by feature_id → run_id)
 *     → agent_usage_samples (by run_id → cost_usd; samples are deltas, so SUM)
 * matching how the rest of the codebase prices a run (selection-core, bee-instance,
 * external-bench all SUM agent_usage_samples.cost_usd).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { disarmPlanSchedule } from './arm-plan-schedule';

/**
 * Total attributed spend (in cents, rounded) for one scheduled run — the sum of
 * every usage sample of every spawn of every work_item the run minted. 0 when the
 * run minted nothing / nothing was priced yet.
 */
export async function computeRunCostCents(opts: {
  sql?: Sql;
  harnessSlug: string;
  runId: number;
}): Promise<number> {
  const db = opts.sql ?? getOrgPg().sql;
  const rows = await db<Array<{ cost_usd: number }>>`
    SELECT COALESCE(SUM(aus.cost_usd), 0)::float8 AS cost_usd
      FROM harness_shared.harness_features_consolidated wi
      JOIN harness_shared.spawned_agents sa
        ON sa.harness_slug = wi.harness_slug AND sa.feature_id = wi.feature_id
      JOIN harness_shared.agent_usage_samples aus
        ON aus.harness_slug = sa.harness_slug AND aus.run_id = sa.run_id
     WHERE wi.harness_slug = ${opts.harnessSlug}
       AND wi.payload -> 'plan_run' ->> 'runId' = ${String(opts.runId)}
  `;
  const usd = rows[0]?.cost_usd ?? 0;
  return Math.round(usd * 100);
}

/**
 * Read a template's authored per-plan cost cap (schedule.costCapCents). Null when
 * unscheduled / no cap set.
 */
async function readCostCapCents(db: Sql, harnessSlug: string, planSlug: string): Promise<number | null> {
  const r = await db<Array<{ cap: number | null }>>`
    SELECT (schedule ->> 'costCapCents')::int AS cap
      FROM harness_shared.harness_plans
     WHERE harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}`;
  const cap = r[0]?.cap;
  return cap != null && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Cost auto-pause (P-013 / D-018): if a freshly-settled run's attributed spend
 * breaches the template's `costCapCents`, disarm the schedule (a runaway/expensive
 * run stops the routine from firing again). Per-run, not cumulative — bounds each
 * scheduled run's spend. Only acts on a currently-armed template with a cap set.
 * The disarmed state IS the notification (Runs tab / Calendar show it paused).
 */
export async function autoPauseOnCostBreach(opts: {
  sql?: Sql;
  harnessSlug: string;
  planSlug: string;
  runId: number;
}): Promise<{ paused: boolean; costCents: number; capCents: number | null }> {
  const db = opts.sql ?? getOrgPg().sql;

  const tpl = await db<Array<{ workspace_id: string; schedule_active: boolean }>>`
    SELECT workspace_id, schedule_active FROM harness_shared.harness_plans
     WHERE harness_slug = ${opts.harnessSlug} AND plan_slug = ${opts.planSlug}`;
  if (!tpl[0] || !tpl[0].schedule_active) return { paused: false, costCents: 0, capCents: null };

  const capCents = await readCostCapCents(db, opts.harnessSlug, opts.planSlug);
  if (capCents == null) return { paused: false, costCents: 0, capCents: null };

  const costCents = await computeRunCostCents({ sql: db, harnessSlug: opts.harnessSlug, runId: opts.runId });
  if (costCents <= capCents) return { paused: false, costCents, capCents };

  await disarmPlanSchedule({
    sql: db,
    workspaceId: tpl[0].workspace_id,
    harnessSlug: opts.harnessSlug,
    templateSlug: opts.planSlug,
  });
  console.warn(
    `[plan-run] auto-paused schedule '${opts.planSlug}' (${opts.harnessSlug}) — run #${opts.runId} cost ${costCents}¢ exceeded cap ${capCents}¢`,
  );
  return { paused: true, costCents, capCents };
}
