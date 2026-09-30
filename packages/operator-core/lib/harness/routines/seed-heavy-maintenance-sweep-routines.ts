/**
 * Seed the two expensive maintenance sweeps extracted from routinesTick by
 * WI-10000846 as independently dispatched durable routines.
 *
 * - scout-signal-accumulator-sweep: every 2 minutes, matching the sweep's
 *   existing 120-second self-throttle.
 * - dead-target-reaper-sweep: every 10 minutes, matching the minimum spacing
 *   between the two agreeing observations required before it parks anything.
 *
 * The second offsets differ so both do not become due on the same scheduler
 * pass. Both remain active-by-default; --inactive seeds a new installation
 * dark for controlled bring-up. Re-seeding never overwrites an operator pause.
 *
 *   tsx seed-heavy-maintenance-sweep-routines.ts
 *   tsx seed-heavy-maintenance-sweep-routines.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.HEAVY_MAINTENANCE_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

const ROUTINES = [
  {
    name: 'scout-signal-accumulator-sweep',
    targetRole: 'system:scout-signal-accumulator-sweep',
    cron: '0 */2 * * * *',
  },
  {
    name: 'dead-target-reaper-sweep',
    targetRole: 'system:dead-target-reaper-sweep',
    cron: '30 */10 * * * *',
  },
] as const;

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const workspaceId = activeWorkspaceId();
  const { sql } = getOrgPg();

  for (const routine of ROUTINES) {
    const id = `rt_${SLUG}_${routine.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const triggerConfig = JSON.stringify({ cron: routine.cron });
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, tier, next_fire_at)
      VALUES (
        ${id}, ${SLUG}, ${workspaceId}, ${routine.name}, 'cron',
        ${triggerConfig}::text::jsonb, ${routine.targetRole}, ${'{}'}::text::jsonb,
        'skip', 'skip-old', ${active}, 'durable', now()
      )
      ON CONFLICT (install_slug, name) DO UPDATE SET
        trigger_kind = EXCLUDED.trigger_kind,
        trigger_config = EXCLUDED.trigger_config,
        target_role = EXCLUDED.target_role,
        tier = EXCLUDED.tier,
        -- active intentionally NOT re-applied on conflict: a re-seed must never
        -- clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
  }

  console.log(
    `[seed-heavy-maintenance-sweep-routines] seeded ${ROUTINES.length} durable routine(s) for ` +
      `"${SLUG}" (ws=${workspaceId}, active=${active})`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-heavy-maintenance-sweep-routines] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
