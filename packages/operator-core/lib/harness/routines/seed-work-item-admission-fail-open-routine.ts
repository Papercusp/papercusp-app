/**
 * Seed the independent deterministic P-004 fail-open/liveness guard.
 * Offset from the 30-minute model promoter so killing that row cannot also
 * suppress the escape hatch that admits over-age pending work.
 *
 *   tsx seed-work-item-admission-fail-open-routine.ts
 *   tsx seed-work-item-admission-fail-open-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_PROMOTER_LIVENESS_MINUTES,
  DEFAULT_PROMOTER_TICK_MINUTES,
  WORK_ITEM_ADMISSION_FAIL_OPEN,
} from '../../work-items-admission-promoter';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = WORK_ITEM_ADMISSION_FAIL_OPEN;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 15,45 * * * *' };
  const payload = {
    tickMinutes: DEFAULT_PROMOTER_TICK_MINUTES,
    staleMinutes: DEFAULT_PROMOTER_LIVENESS_MINUTES,
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
    `[seed-work-item-admission-fail-open-routine] ${SLUG}: seeded offset fail-open/liveness guard ` +
      `(${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-work-item-admission-fail-open-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
