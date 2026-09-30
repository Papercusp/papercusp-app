/** Seed the always-on durable Inbox resolver backstop (P-009). */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { INBOX_BULK_RESOLVE, INBOX_BULK_RESOLVE_CAP } from './inbox-bulk-resolve-action';

const SLUG = process.env.INBOX_BULK_RESOLVE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = INBOX_BULK_RESOLVE;
const TARGET_ROLE = `system:${NAME}`;
/** Second 26, every 15 minutes — offset from legacy-needs-human at second 11. */
const CRON = '26 */15 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, cap: INBOX_BULK_RESOLVE_CAP };
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
    `[seed-inbox-bulk-resolve-routine] seeded "${NAME}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${INBOX_BULK_RESOLVE_CAP}).`,
  );
  announceRoutineSeeded('seed-inbox-bulk-resolve-routine', 'packages/operator-core/lib/harness/routines/inbox-bulk-resolve-action.ts');
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-inbox-bulk-resolve-routine] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
