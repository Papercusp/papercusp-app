/**
 * Seed the `gc-verify-instances` routine — WI-6684.
 *
 * Owner ask 2026-08-01: "how do we fix this from recurring — a cleanup sweep that would
 * detect this?" Root cause: `scripts/verify-tauri-headless.sh --boot-only` returns
 * WITHOUT teardown by design, so the caller owes a `stop.sh` it never runs if it dies,
 * is compacted, or simply forgets. Nothing enforced it. Measured that day: 288 work
 * dirs, 300 GB (each carries a ~1GB frozen SPA snapshot), /tmp 80% full, and one
 * instance still running after 8 days holding a display, a webview and a sidecar.
 *
 *   - `gc-verify-instances` (hourly): tear down and delete /tmp/verify-tauri-headless.*
 *     dirs older than the TTL, by running each dir's OWN stop.sh. Filesystem +
 *     process cleanup only; spawns no agent, makes no network call. Idempotent.
 *
 * ⚠ SEEDING IS THE POINT OF THIS FILE. A registered handler with no routine row is
 * green code that never executes — every test passes and the sweep has literally never
 * run. That is exactly how `gc-dead-loops` shipped dark for a week (EI-18752496371939475,
 * filed after finding my own P-007 deliverable had never fired once). Run this.
 *
 * HOURLY, not daily: the leak accrues per verify run, and the fleet verifies often. At
 * ~1GB per run an hourly sweep keeps /tmp flat, and each pass is a readdir plus a few
 * removals — cheaper than the daily alternative that lets 24 dirs pile up first.
 *
 * NOT flag-gated (pure host housekeeping, same class as gc-dead-loops and
 * telemetry-retention). Seeded ACTIVE by default: every destructive path is guarded by
 * a TTL, a protected-display refusal, and a per-run cap, and the sweep only ever runs
 * teardown scripts the harness itself generated.
 *
 *   tsx seed-gc-verify-instances-routine.ts                  # seed + enable (default)
 *   tsx seed-gc-verify-instances-routine.ts --inactive       # seed but leave disabled
 *   tsx seed-gc-verify-instances-routine.ts --ttl-hours 24 --max-per-run 100
 *   tsx seed-gc-verify-instances-routine.ts --dry-run        # report only, delete nothing
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - ttl_hours   (default 6, gc-verify-instances.ts's VERIFY_INSTANCE_TTL_HOURS_DEFAULT)
 *   - max_per_run (default 50, VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT)
 *   - tmp_dirs    (string array; default /tmp, os.tmpdir() and every checkout's .papercusp/tmp)
 *   - dry_run     (default false)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';

const SLUG = process.env.GC_VERIFY_INSTANCES_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :24 past — offset from gc-plan-runs (:12) and gc-dead-loops (:18) so the
 *  janitors never contend for the same tick. */
const CRON = '0 24 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const ttlHours = argNumber('--ttl-hours');
  const maxPerRun = argNumber('--max-per-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gc-verify-instances';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(ttlHours ? { ttl_hours: ttlHours } : {}),
    ...(maxPerRun ? { max_per_run: maxPerRun } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:gc-verify-instances', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gc-verify-instances-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly sweep of abandoned verify-tauri-headless work dirs` +
      (ttlHours ? `, ttl_hours=${ttlHours}` : '') +
      (maxPerRun ? `, max_per_run=${maxPerRun}` : '') +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
  // Seeding the row is only HALF of shipping a routine — see seed-routine-announce.ts for
  // why. Observed exactly that failure mode on 2026-08-01: seeded, fired, reaped zero,
  // because bg-host was 4 days stale.
  announceRoutineSeeded(
    'seed-gc-verify-instances-routine',
    'packages/operator-core/lib/harness/routines/gc-verify-instances-action.ts',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gc-verify-instances-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
