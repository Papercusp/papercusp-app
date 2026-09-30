/**
 * Seed the `psu-pty-host-events-ingest` routine —
 * psu-pty-turn-boundary-generalization-2026-09-22, P-007.
 *
 *   - `psu-pty-host-events-ingest` (every 30 min): drain the per-owner psu-pty host JSONL
 *     write-ahead logs into `harness_shared.psu_pty_host_events`, then apply retention to
 *     BOTH tiers (rows older than 90d, files older than 14d). Local file reads plus one
 *     bounded batch insert; spawns no agent and touches no live host.
 *
 * WHY A SEED EXISTS AT ALL. The action seam (`psu-pty-host-events-ingest-action.ts`) only
 * REGISTERS `system:psu-pty-host-events-ingest`; it does not put it on a cadence. Without a
 * row in `harness_shared.routines` nothing ever fires it, so the table stays empty, the
 * delivery-success rate stays uncomputable, and the file population stays unbounded — i.e.
 * exactly the P-007 gap the ingest was written to close, still open while every piece of
 * code needed to close it sits in the tree looking finished. Registration is not a schedule;
 * this file is the difference (measured 2026-09-22: `routines:list { q: 'psu-pty' }`
 * returned 0 rows while the action, the migration and the ingest were all present).
 *
 * NOT flag-gated, mirroring seed-pty-host-wedge-routine: this is a local-file→Postgres
 * janitor over telemetry the hosts already write. It has no owner-authority surface, spawns
 * nothing, and cannot perturb a host it reads. Seeded ACTIVE by default — a telemetry sink
 * that must be hand-enabled is a sink that stays empty until someone remembers it.
 *
 * DELETION SAFETY is the ingest's own invariant, restated here because it is the one thing a
 * scheduler could make dangerous: a file is deleted only after its rows are durably
 * committed. An expired file whose ingest FAILED is retained and counted in
 * `filesRetainedUningested`, never deleted — losing rows that exist nowhere else is strictly
 * worse than an unbounded directory, and the count makes that state visible instead of
 * inferred from a file total that stops falling.
 *
 *   tsx seed-psu-pty-host-events-ingest-routine.ts              # seed + enable (default)
 *   tsx seed-psu-pty-host-events-ingest-routine.ts --inactive   # seed but leave disabled
 *   tsx seed-psu-pty-host-events-ingest-routine.ts --dry-run    # report only, mutate nothing
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PSU_PTY_HOST_EVENTS_INGEST_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

/**
 * Every 30 minutes at :17 and :47 past — deliberately offset from the other janitors so the
 * cadence cannot contend with them: sweep-wedged-pty-hosts (:03/:23/:43), sweep-stalled-loops
 * (:07), gc-plan-runs (:12), gc-dead-loops (daily :18). Six-field cron (sec min hour dom mon
 * dow), matching its siblings.
 *
 * 30 minutes rather than the wedge sweep's 20: this one is a janitor over an at-rest file
 * population, not an active-outage detector. Nothing degrades if a batch of rows lands half an
 * hour later, whereas every pass a WEDGE goes unreported is another 20 minutes of an agent
 * silently not working. Matching the faster cadence would buy nothing and add contention.
 */
const CRON = '0 17,47 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'psu-pty-host-events-ingest';
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
            'system:psu-pty-host-events-ingest', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a re-seed
      -- must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-psu-pty-host-events-ingest-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, ` +
      `active=${active}) — 30-minute ingest of psu-pty host delivery telemetry into ` +
      `harness_shared.psu_pty_host_events, with row + file retention` +
      (dryRun ? ', dry_run=true' : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      '[seed-psu-pty-host-events-ingest-routine] FAILED:',
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  });
