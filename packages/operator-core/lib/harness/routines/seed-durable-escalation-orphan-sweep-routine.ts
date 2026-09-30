/**
 * Seed the always-on durable-escalation orphan sweep (WI-1741477).
 *
 * Daily at 04:40 — deliberately sparse, and off both the dead-citation sweep's 03:15 and the
 * admission-delta sweep's hourly :07 offset. The cadence is set by what the signal actually
 * does: each emitter is judged against its OWN p95 close time, which for the slowest emitters
 * measured is ~336h. Sampling a multi-day signal every few minutes would burn a ledger scan
 * per tick to re-observe the same state, so the item that commissioned this specified hours,
 * not minutes.
 *
 *   tsx seed-durable-escalation-orphan-sweep-routine.ts
 *   tsx seed-durable-escalation-orphan-sweep-routine.ts --inactive
 *
 * ⚠ WRITING THIS SCRIPT IS NOT RUNNING IT. A seed script that is never executed leaves the
 * handler registered with no `harness_shared.routines` row, which never fires — the exact
 * defect this whole action was commissioned to detect, reproduced in its own bring-up. The
 * action is declared `scheduling: 'standing'` (the default), so `validateActiveRoutines`
 * reports a missing row as an `unscheduledSystemActions` offender, and
 * `bespoke-active-seeds-check.ts` carries the paired entry.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DURABLE_ESCALATION_ORPHAN_SWEEP } from './durable-escalation-orphan-sweep-action';

const SLUG =
  process.env.DURABLE_ESCALATION_ORPHAN_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const name = DURABLE_ESCALATION_ORPHAN_SWEEP;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: '0 40 4 * * *' };
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
    `[seed-durable-escalation-orphan-sweep-routine] ${SLUG}: seeded durable daily 04:40 ` +
      `durable-escalation orphan sweep (${active ? 'ACTIVE' : 'inactive'}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-durable-escalation-orphan-sweep-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
