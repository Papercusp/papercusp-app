/**
 * Seed the always-on post-close completion-claim recheck (WI-2142447).
 *
 * Cadence: every 6 hours at :25, off both the hourly :07 admission-delta sweep and the
 * daily 03:15 dead-citation sweep. More often than daily because the measured drift rate on
 * this tree is a 69-MINUTE half-life on a load-bearing claim about a named array
 * (EI-22175397357614106); less often than hourly because the pass reads and parses source
 * per claim, and a claim that went false four hours ago is not more wrong than one that
 * went false four minutes ago — nothing downstream reacts to it faster than a person reads.
 *
 *   tsx seed-completion-claim-recheck-routine.ts
 *   tsx seed-completion-claim-recheck-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { COMPLETION_CLAIM_RECHECK } from './completion-claim-recheck-action';

const SLUG = process.env.COMPLETION_CLAIM_RECHECK_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = COMPLETION_CLAIM_RECHECK;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 25 */6 * * *' };
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
    `[seed-completion-claim-recheck-routine] ${SLUG}: seeded durable 6-hourly :25 ` +
      `completion-claim recheck (${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-completion-claim-recheck-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
