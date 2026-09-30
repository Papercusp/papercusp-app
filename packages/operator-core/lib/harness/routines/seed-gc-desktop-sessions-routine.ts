/**
 * Seed the `gc-desktop-sessions` routine — agent-virtual-desktops-2026-08-23
 * P-005 / WI-40868.
 *
 *   - `gc-desktop-sessions` (every 10 min): apply the desktop lifecycle ladder to
 *     live DesktopSession rows — demote an unused desktop to `idle`, FREEZE its
 *     cgroup when it stays unused, and reap it once it has been frozen and
 *     untouched for a further TTL. Process + bookkeeping only; spawns no agent,
 *     makes no network call. Idempotent.
 *
 * WHY IT EXISTS: WI-5978 measured three idle QEMU guests holding 12.8 cores — 11%
 * of this 128-core box — continuously for 5 to 9 days, against a fourth guest that
 * had been up LONGER and cost 0.1 cores. The control proves they were spinning,
 * not working, and a guest whose idle loop never reaches HLT cannot be talked out
 * of it from inside. The host can stop it: `cgroup.freeze`.
 *
 * ⚠ SEEDING IS THE POINT OF THIS FILE. A registered handler with no routine row is
 * green code that never executes — every test passes and the sweep has literally
 * never run. That is exactly how `gc-dead-loops` shipped dark for a week
 * (EI-18752496371939475) and it is a live risk here, because the thing this sweep
 * prevents is invisible until someone measures a load average. Run this.
 *
 * EVERY 10 MINUTES, not hourly: the cost being prevented accrues per core-second.
 * gc-verify-instances is hourly because a leaked /tmp dir costs disk, which is
 * cheap to let pile up for an hour; a spinning guest costs a core for that hour.
 * Each pass is one indexed SELECT over live rows plus, at most, a handful of
 * cgroup writes.
 *
 * NOT flag-gated (host housekeeping, same class as gc-verify-instances and
 * gc-dead-loops). Seeded ACTIVE by default: every destructive path is guarded by a
 * per-kind TTL, a per-run cap, a protected-display refusal (`:0`/`:1`/`:2`), a
 * refusal to touch `scope='workspace'` desktops, and host-local scoping — and the
 * first two rungs of the ladder (`idle`, `freeze`) are fully reversible.
 *
 *   tsx seed-gc-desktop-sessions-routine.ts                # seed + enable (default)
 *   tsx seed-gc-desktop-sessions-routine.ts --inactive     # seed but leave disabled
 *   tsx seed-gc-desktop-sessions-routine.ts --dry-run      # classify + report, actuate nothing
 *   tsx seed-gc-desktop-sessions-routine.ts --max-per-run 10
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - max_per_run (default 25, DESKTOP_GC_MAX_PER_RUN_DEFAULT)
 *   - dry_run     (default false)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';

const SLUG = process.env.GC_DESKTOP_SESSIONS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 10 minutes at :07 past — offset from gc-plan-runs (:12), gc-dead-loops
 *  (:18) and gc-verify-instances (:24) so the janitors never contend for a tick. */
const CRON = '0 7,17,27,37,47,57 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const maxPerRun = argNumber('--max-per-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gc-desktop-sessions';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(maxPerRun ? { max_per_run: maxPerRun } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:gc-desktop-sessions', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gc-desktop-sessions-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `10-minute desktop lifecycle sweep (idle → freeze → reap)` +
      (maxPerRun ? `, max_per_run=${maxPerRun}` : '') +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
  // Seeding the row is only HALF of shipping a routine — see seed-routine-announce.ts for
  // why.
  announceRoutineSeeded(
    'seed-gc-desktop-sessions-routine',
    'packages/operator-core/lib/harness/routines/gc-desktop-sessions-action.ts',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gc-desktop-sessions-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
