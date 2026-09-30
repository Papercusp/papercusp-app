/**
 * Seed the always-on dead-citation sweep (EI-21894865709918325).
 *
 * Sparse daily cadence (03:15, off the admission-delta-sweep's hourly :07 offset): doc/metadata
 * citation drift accumulates slowly and the check is cheap but non-urgent, unlike the hourly
 * root-cause burst detector this deliberately does not compete with.
 *
 *   tsx seed-dead-citation-sweep-routine.ts
 *   tsx seed-dead-citation-sweep-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DEAD_CITATION_SWEEP } from './dead-citation-sweep-action';

const SLUG = process.env.DEAD_CITATION_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = DEAD_CITATION_SWEEP;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 15 3 * * *' };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${workspaceId}, ${name}, 'cron',
            ${JSON.stringify(triggerConfig)}::text::jsonb, ${`system:${name}`},
            ${'{}'}::text::jsonb, 'skip', 'skip-old',
            ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()`;
  console.log(
    `[seed-dead-citation-sweep-routine] ${SLUG}: seeded durable daily 03:15 dead-citation sweep ` +
      `(${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-dead-citation-sweep-routine] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
