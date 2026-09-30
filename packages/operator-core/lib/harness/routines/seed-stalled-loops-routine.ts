/**
 * Seed the `sweep-stalled-loops` routine — WI-6639 (root cause: an ARMED engine loop
 * that stops producing turns is never noticed or acted on; handler in
 * `stalled-loops-action.ts`, sweep in `stalled-loops-guard.ts`).
 *
 *   - `sweep-stalled-loops` (every 5 min): disarm ACTIVE `loop-%` routines whose
 *     `computeTurnsStalled` verdict is true, then broadcast a single fleet-wide
 *     notice naming every disarmed owner. SQL + one best-effort broadcast; spawns
 *     no agent. Idempotent (an already-disarmed loop never matches `active = true`
 *     again, so a re-sweep finds nothing for it).
 *
 * Confirmed live cost of NOT running this (2026-07-28): 15 sessions carried an
 * ARMED loop with no tool call in 37h-158h (three for a session that had already
 * ENDED), and nothing in the system ever noticed or acted on it — `turnsStalled`'s
 * only consumer was the read-only `loop:status` tool, which nobody was asking about
 * a session that was, by definition, no longer running.
 *
 * CADENCE (EI-22061372138351689). Originally hourly. `computeTurnsStalled` already
 * withholds the verdict until `turnsStalledFloorMs` (>=30min) has elapsed since the
 * last real turn, so an hourly sweep stacks a SECOND, uncontrolled delay on top of
 * that floor: a loop that stalls moments after one sweep waits up to ~60 more
 * minutes for the next one before recovery even starts. Measured live: a session
 * whose last turn completed at 11:21:12Z sat black-holed — fires landing, no turn
 * following, no reachability — until the next hourly tick at ~12:07-12:09Z, ~48
 * minutes after the floor alone would have sufficed. The sweep itself is cheap (a
 * handful of SELECT/UPDATEs, idempotent, at most one best-effort broadcast per
 * pass — see siblings like gate-watcher's every-2-min and claim-integrity-sweep's
 * every-10-min cadence), so there is no cost reason to hold it to an hour. Every 5
 * minutes bounds the sweep's OWN contribution to <=5 min, leaving the 30-min floor
 * as the dominant (and already well-reasoned) term.
 *
 * NOT flag-gated (pure liveness housekeeping over a signal already computed and
 * displayed by loop:status — no owner-authority surface; mirrors gc-dead-loops).
 * Seeded ACTIVE by default: computeTurnsStalled is deliberately conservative
 * (≥3 fires, a generous multiple-of-interval floor, exempt on any recent presence
 * activity), so there is nothing here for a human to eyeball first, same reasoning
 * as seed-gc-dead-loops-routine.ts.
 *
 *   tsx seed-stalled-loops-routine.ts                # seed + enable (default)
 *   tsx seed-stalled-loops-routine.ts --inactive      # seed but leave disabled
 *   tsx seed-stalled-loops-routine.ts --dry-run       # report only, disarm/broadcast nothing
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.STALLED_LOOPS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 5 minutes — a handful of SELECT/UPDATEs plus at most one best-effort
 *  broadcast per pass (EI-22061372138351689: was hourly at :07, which stacked up
 *  to ~60 extra minutes of pure sweep-cadence delay on top of the verdict's own
 *  30-min floor before a dead loop's recovery even started). */
const CRON = '0 */5 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'sweep-stalled-loops';
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
            'system:sweep-stalled-loops', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-stalled-loops-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every-5-min sweep disarming turns-stalled loop-<ownerId> routine rows` +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-stalled-loops-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
