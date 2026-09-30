/**
 * Seed the always-on P-022 daily durable-park audit — the REPORT-FIRST backstop.
 *
 * The audit engine (`work-items-durable-park-audit.ts`) and its system action
 * (`work-item-durable-park-audit-action.ts`) have existed and been green since
 * P-020/P-021, but no `harness_shared.routines` row was ever created for them, so
 * the audit had never once ticked on its own. That is the same "the seed script
 * exists, its header says ACTIVE, nobody ever ran it" class the sibling
 * `bespoke-active-seeds-check.ts` was written to make detectable — which is why
 * this routine is registered there in the SAME change that adds this file.
 *
 * REPORT-ONLY BY CONSTRUCTION. The payload deliberately carries no `mode`, so the
 * action takes its audit branch and never `runWorkItemDurableParkReconciliation`.
 * Per D-018/D-022/D-023 a durable park is never cleared by age, parker death, or
 * model judgment: the scheduled run only ever REPORTS, and any clear goes through
 * explicit reconcile decisions on the evidence-matrix/fingerprint/CAS path.
 *
 * Cadence: the schedule is the BOUNDED BACKSTOP, not the primary resolution path
 * (P-022). It runs daily at 03:47 America/New_York — offset from the admission
 * promoter (:00/:30), the hourly delta sweep (:07) and the daily digest (02:37) so
 * the four never contend for the same tick.
 *
 * ⚠ These cron fields are evaluated in the operator's LOCAL zone, not UTC. Verified
 * on the live row at seed time: cron `0 47 3 * * *` produced next_fire_at
 * `2026-08-28T07:47:00Z` (= 03:47 America/New_York, UTC-4), and the sibling
 * `unclaimed-work-digest` (`0 0 9 * * *`) likewise resolves to 13:00Z. Reading these
 * hours as UTC is a silent 4-hour error when correlating a run against a UTC ledger
 * timestamp.
 *
 *   tsx seed-work-item-durable-park-audit-routine.ts
 *   tsx seed-work-item-durable-park-audit-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_AGENT_REVIEW_OVERDUE_HOURS,
  WORK_ITEM_DURABLE_PARK_AUDIT,
} from '../../work-items-durable-park-audit';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 03:47 in the operator's LOCAL zone (07:47Z at UTC-4) — see the cadence note above. */
const CRON = '0 47 3 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = WORK_ITEM_DURABLE_PARK_AUDIT;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  // No `mode` key: the action's audit branch is the report-only one. Adding
  // `mode: 'reconcile'` here would turn the backstop into an unattended mutator.
  const payload = { reviewOverdueHours: DEFAULT_AGENT_REVIEW_OVERDUE_HOURS };
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
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()`;
  console.log(
    `[seed-work-item-durable-park-audit-routine] ${SLUG}: seeded durable daily 03:47 local ` +
      `report-only durable-park audit (${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-work-item-durable-park-audit-routine] FAILED:', error);
    process.exit(1);
  });
