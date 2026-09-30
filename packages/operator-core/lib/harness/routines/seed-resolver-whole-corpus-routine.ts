/**
 * Seed the P-007 whole-corpus resolver pass (silent-intake-central-resolution-2026-09-01).
 *
 * Off-peak :52 offset — distinct from the promoter (:00/:30), the hourly
 * delta-sweep (:07), and the daily digest (:37).
 *
 *   tsx seed-resolver-whole-corpus-routine.ts
 *   tsx seed-resolver-whole-corpus-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { RESOLVER_WHOLE_CORPUS_NAME } from './resolver-whole-corpus-action';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = RESOLVER_WHOLE_CORPUS_NAME;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 52 2 * * *' };
  const payload = {};
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
    `[seed-resolver-whole-corpus-routine] ${SLUG}: seeded durable daily :52 whole-corpus resolver pass ` +
      `(${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-resolver-whole-corpus-routine] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
