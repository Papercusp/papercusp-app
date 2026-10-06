/**
 * Seed the always-on durable plan clean-up sweep (plan-cleanup-system-repair-2026-10-01
 * P-004) — `system:plan-cleanup-sweep` → `plan-cleanup-sweep-action.ts`.
 *
 * DAILY at 09:41:17 HOST-LOCAL time, NOT UTC: `computeNextFireAt` (./cron.ts) evaluates
 * the crontab in the host process's zone (America/New_York on the dev box, so 13:41:17
 * UTC under EDT). The hour is an arbitrary off-peak offset; only the daily cadence
 * matters. The cadence is derived from coverage, not picked: one fire
 * carries at most MAX_RUN_PLANS (200) plans, least-recently-scanned first, and the open
 * population is ~750 plans (2026-10-01), so a daily fire re-scans every open plan about
 * every 4 days. Each fire's deterministic pass is cheap; a resolver (model turns) is
 * launched only when judgment residue remains, so a weekly cadence would just let debt
 * sit and an hourly one would mostly re-scan fresh plans. The odd offset keeps it off
 * the top-of-hour cluster.
 *
 * `tier: 'durable'` — the sweep writes plan/claim state and may spawn a resolver; it
 * must be claimed ONCE through `routinesTick`, never per host.
 *
 * Seeded ACTIVE: finished work never ships dark, and the sweep is gated at fire time by
 * the same `papercusp-plan-cleanup` flag as the Plans-pane button.
 *
 *   tsx seed-plan-cleanup-sweep-routine.ts             # seed ACTIVE
 *   tsx seed-plan-cleanup-sweep-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { PLAN_CLEANUP_SWEEP } from './plan-cleanup-sweep-action';
import { MAX_RUN_PLANS } from '../../plan-cleanup/start-run';

const SLUG = process.env.PLAN_CLEANUP_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = PLAN_CLEANUP_SWEEP;
const TARGET_ROLE = `system:${NAME}`;
/** sec min hour dom mon dow — daily at 09:41:17 host-local (not UTC; see the header). */
const CRON = '17 41 9 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, max_plans: MAX_RUN_PLANS };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${NAME}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            ${TARGET_ROLE}, '{}'::jsonb, 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      tier = EXCLUDED.tier,
      workspace_id = EXCLUDED.workspace_id,
      -- active intentionally NOT re-applied on conflict: a re-seed must never
      -- clobber an operator's runtime pause/resume.
      updated_at = now()
  `;
  console.log(
    `[seed-plan-cleanup-sweep-routine] seeded "${NAME}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, max_plans=${MAX_RUN_PLANS}).`,
  );
  announceRoutineSeeded(
    'seed-plan-cleanup-sweep-routine',
    'packages/operator-core/lib/harness/routines/plan-cleanup-sweep-action.ts',
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-plan-cleanup-sweep-routine] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
