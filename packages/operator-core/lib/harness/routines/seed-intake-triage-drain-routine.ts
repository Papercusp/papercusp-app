/**
 * Seed the durable intake-triage drain (observation-candidate-acceptance-promotion-2026-09-30,
 * P-008 / D-020). It drains awaiting observations/candidates as `intake-triage` runs, apart
 * from the Inbox resolver and from accepted implementation work.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { INTAKE_TRIAGE_DRAIN, INTAKE_TRIAGE_DRAIN_CAP } from './intake-triage-drain-action';

const SLUG = process.env.INTAKE_TRIAGE_DRAIN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = INTAKE_TRIAGE_DRAIN;
const TARGET_ROLE = `system:${NAME}`;
/**
 * Second 41, minute 7, every hour. Hourly, not every 15 minutes like the Inbox resolver:
 * one intake run takes up to 200 rows and holds its single-flight slot until the owner
 * reviews it, so a faster cadence would only add skipped fires.
 */
const CRON = '41 7 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, cap: INTAKE_TRIAGE_DRAIN_CAP };
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
    `[seed-intake-triage-drain-routine] seeded "${NAME}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${INTAKE_TRIAGE_DRAIN_CAP}).`,
  );
  announceRoutineSeeded(
    'seed-intake-triage-drain-routine',
    'packages/operator-core/lib/harness/routines/intake-triage-drain-action.ts',
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-intake-triage-drain-routine] FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
