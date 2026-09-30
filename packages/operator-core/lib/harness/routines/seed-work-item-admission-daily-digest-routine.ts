/**
 * Seed the guarded P-012 daily full-corpus admission digest.
 *
 * The action self-gates on a completed bulk stage, so an early fire records a
 * blocked ledger row without making an LLM call.  The :37 offset keeps it away
 * from the promoter (:00/:30) and hourly delta sweep (:07) model work.
 *
 *   tsx seed-work-item-admission-daily-digest-routine.ts
 *   tsx seed-work-item-admission-daily-digest-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_DAILY_DIGEST_MAX_TOKENS,
  WORK_ITEM_ADMISSION_DAILY_DIGEST,
} from '../../work-items-admission-daily-digest';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = WORK_ITEM_ADMISSION_DAILY_DIGEST;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 37 2 * * *' };
  const payload = { maxTokens: DEFAULT_DAILY_DIGEST_MAX_TOKENS };
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
    `[seed-work-item-admission-daily-digest-routine] ${SLUG}: seeded durable daily :37 digest ` +
      `(${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-work-item-admission-daily-digest-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
