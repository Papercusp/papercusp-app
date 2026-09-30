/**
 * Seed the `sweep-wedged-pty-hosts` routine — EI-20287339148365013 (root cause: a psu-pty
 * host whose owner-composer wedges defers every wake forever, and NOTHING detects it;
 * handler in `pty-host-wedge-action.ts`, sweep in `pty-host-wedge-guard.ts`).
 *
 *   - `sweep-wedged-pty-hosts` (every 20 min): read each live host's on-disk lifecycle
 *     ledger, name the hosts whose wakes are all being deferred against a staged input
 *     line that never moves, and broadcast one fleet-wide notice. Local file reads plus at
 *     most one broadcast and one page per pass; spawns no agent and touches no host.
 *     Idempotent, and self-silencing: the broadcast is one-shot per condition episode.
 *
 * Confirmed live cost of NOT running this (measured 2026-08-12): three hosts had gone
 * wake-deaf, one for 259 minutes and another for 888, while every wake to them was acked
 * `delivered` and `coord:presence` reported them parked-and-wakeable. The episodes ended
 * only because a human eventually noticed and asked why agents were idle.
 *
 * NOT flag-gated (pure liveness observation over ledgers the hosts already write — no
 * owner-authority surface, no actuator; mirrors seed-stalled-loops-routine). Seeded ACTIVE
 * by default: the detector is deliberately conservative (a run must clear a floor ABOVE
 * the in-host breaker's own, span real wall-clock time, and hold ONE unchanging staged
 * length — a person's line moves, so a person can never accumulate a run), and it was
 * calibrated against the live population before shipping: 2 wedged found out of 93 live
 * hosts, both independently corroborated, zero false positives across the other 91.
 *
 *   tsx seed-pty-host-wedge-routine.ts                # seed + enable (default)
 *   tsx seed-pty-host-wedge-routine.ts --inactive     # seed but leave disabled
 *   tsx seed-pty-host-wedge-routine.ts --dry-run      # report only, broadcast nothing
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PTY_HOST_WEDGE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 20 minutes at :03 past — offset from gc-plan-runs (:12), sweep-stalled-loops
 *  (:07) and gc-dead-loops (daily :18) so the janitors don't contend. More frequent than
 *  its hourly siblings because the thing it watches is an ACTIVE outage: every pass a
 *  wedge goes unreported is another 20 minutes of an agent silently not working. */
const CRON = '0 3,23,43 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'sweep-wedged-pty-hosts';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(dryRun ? { dry_run: true } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:sweep-wedged-pty-hosts', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-pty-host-wedge-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `20-minute sweep naming live psu-pty hosts that can no longer receive wakes` +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-pty-host-wedge-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
