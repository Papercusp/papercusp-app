/**
 * Seed the daily work-item admission bulk-dedup DRIVER (WI-10004722, plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-005).
 *
 * The staged bulk dedup (`system:work-item-admission-bulk-dedup`) only ever ran
 * when someone called `work_items:bulk_dedup` by hand. After 2026-09-05 nobody did,
 * so the census went stale and the daily digest sat blocked on
 * `census-coverage-mismatch` for 18 straight days. This row is the recurring half:
 * each fire arms ONE stage-bounded run unless a pass is already in flight
 * (`work-item-admission-bulk-dedup-driver-action.ts`). Registered in
 * BESPOKE_ACTIVE_SEEDS in the same change, so a missing row is loud.
 *
 * Cadence: daily at 00:17 in the operator's LOCAL zone (04:17Z at UTC-4) — offset
 * from the admission promoter (:00/:30), the hourly delta sweep (:07), the daily
 * digest (02:37) and the durable-park audit (03:47), and early enough that a
 * two-stage run normally finishes before the digest reads the latest bulk stage.
 *
 * ⚠ Cron fields are evaluated in the operator's LOCAL zone, not UTC (see the note in
 * seed-work-item-durable-park-audit-routine.ts).
 *
 * Spend: `maxStages` bounds each day's strong-model shard judgements. Raise it in the
 * routine's payload_template, not in code, if the census needs to converge faster.
 *
 *   tsx seed-work-item-admission-bulk-dedup-driver-routine.ts
 *   tsx seed-work-item-admission-bulk-dedup-driver-routine.ts --inactive
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_DRIVER_MAX_STAGES,
  WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER,
} from '../../work-items-admission-bulk-dedup-enqueue';

const SLUG = process.env.WORK_ITEM_ADMISSION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 00:17 in the operator's LOCAL zone — see the cadence note above. */
const CRON = '0 17 0 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  const payload = { maxStages: DEFAULT_DRIVER_MAX_STAGES };
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
    `[seed-work-item-admission-bulk-dedup-driver-routine] ${SLUG}: seeded durable daily 00:17 local ` +
      `bulk-dedup driver, maxStages=${DEFAULT_DRIVER_MAX_STAGES} (${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-work-item-admission-bulk-dedup-driver-routine] FAILED:', error);
    process.exit(1);
  });
