/**
 * Seed the always-on P-011 hourly root-cause delta sweep.
 *
 * The :07 offset avoids competing with the admission promoter's :00/:30 model
 * work while preserving the owner's hourly detection cadence.
 *
 *   tsx seed-work-item-admission-delta-sweep-routine.ts
 *   tsx seed-work-item-admission-delta-sweep-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_DELTA_CLUSTER_EXEMPLARS,
  DEFAULT_DELTA_TITLE_WINDOW_HOURS,
  DEFAULT_DELTA_WINDOW_MINUTES,
  WORK_ITEM_ADMISSION_DELTA_SWEEP,
} from '../../work-items-admission-delta-sweep';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = WORK_ITEM_ADMISSION_DELTA_SWEEP;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 7 * * * *' };
  const payload = {
    recentWindowMinutes: DEFAULT_DELTA_WINDOW_MINUTES,
    titleWindowHours: DEFAULT_DELTA_TITLE_WINDOW_HOURS,
    clusterExemplarsPerShard: DEFAULT_DELTA_CLUSTER_EXEMPLARS,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${workspaceId}, ${name}, 'cron',
            ${JSON.stringify(triggerConfig)}::text::jsonb, ${`system:${name}`},
            ${JSON.stringify(payload)}::text::jsonb, 'skip', 'skip-old',
            ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      tier = EXCLUDED.tier,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()`;
  console.log(
    `[seed-work-item-admission-delta-sweep-routine] ${SLUG}: seeded durable hourly :07 delta sweep ` +
      `(${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-work-item-admission-delta-sweep-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
