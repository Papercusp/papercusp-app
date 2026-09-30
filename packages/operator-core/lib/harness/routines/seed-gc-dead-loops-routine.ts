/**
 * Seed the `gc-dead-loops` routine — agents-system-pane-split-2026-07-26 P-007
 * (root cause: `loop:arm` materialises one `loop-<ownerId>` routine row per looping
 * session, `loop:end` and the dead-man sweep only DEACTIVATE it, and nothing in the
 * tree ever deleted one; handler in `gc-dead-loops-action.ts`, sweep in
 * `gc-dead-loops.ts`).
 *
 *   - `gc-dead-loops` (daily): delete INACTIVE `loop-%` routine rows whose owning
 *     session has been silent past the retention window. SQL-only; spawns no agent,
 *     makes no network call. Idempotent (a re-sweep finds nothing).
 *
 * Confirmed live cost of NOT running this (2026-07-26): 770 loop rows in the
 * papercusp workspace, 750 of them dead, accruing ~30/day since June — enough that
 * the owner-facing automation pane read as an unusable wall of dead rows, which is
 * what prompted the whole Agents/System split.
 *
 * NOT flag-gated (pure retention housekeeping, same class as gc-plan-runs and
 * telemetry-retention — no owner-authority surface). Seeded ACTIVE by default: the
 * sweep only ever touches rows that are ALREADY inactive AND whose session has been
 * gone for two weeks, so there is nothing here for a human to eyeball first.
 *
 *   tsx seed-gc-dead-loops-routine.ts                     # seed + enable (default)
 *   tsx seed-gc-dead-loops-routine.ts --inactive          # seed but leave disabled
 *   tsx seed-gc-dead-loops-routine.ts --retention-days 30 --max-per-run 200
 *   tsx seed-gc-dead-loops-routine.ts --dry-run           # report only, delete nothing
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - retention_days (default 14, gc-dead-loops.ts's DEAD_LOOP_RETENTION_DAYS_DEFAULT)
 *   - max_per_run    (default 500, DEAD_LOOP_MAX_PER_RUN_DEFAULT)
 *   - dry_run        (default false)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';

const SLUG = process.env.GC_DEAD_LOOPS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at :18 past midnight UTC — a handful of SELECT/DELETEs, and loop rows
 *  accrue at ~30/day, so a daily sweep keeps the table flat without ever being a
 *  large delete. Offset from gc-plan-runs (:12) so the two janitors do not contend. */
const CRON = '0 18 0 * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const retentionDays = argNumber('--retention-days');
  const maxPerRun = argNumber('--max-per-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gc-dead-loops';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(retentionDays ? { retention_days: retentionDays } : {}),
    ...(maxPerRun ? { max_per_run: maxPerRun } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:gc-dead-loops', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gc-dead-loops-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily sweep of dead loop-<ownerId> routine rows` +
      (retentionDays ? `, retention_days=${retentionDays}` : '') +
      (maxPerRun ? `, max_per_run=${maxPerRun}` : '') +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
  announceRoutineSeeded(
    'seed-gc-dead-loops-routine',
    'packages/operator-core/lib/harness/routines/gc-dead-loops-action.ts',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gc-dead-loops-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
