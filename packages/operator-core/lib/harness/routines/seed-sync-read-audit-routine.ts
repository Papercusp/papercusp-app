/**
 * Seed the `sync-read-audit` routine (EI-19457924854150358).
 *
 * The sync-read payload audit (`sync-resolver/sync-read-audit.ts`) decides whether a
 * sync read has outgrown its byte ceiling. Nothing ran it: its own source says "run on
 * demand", which in practice meant "run when an agent happens to look". `plans.list`
 * drifted past its allowlisted ceiling and sat there ~12h until an unrelated
 * investigation tripped over it. Every byte cut on `no-http-anywhere-2026-07-28`
 * ratchets a ceiling DOWN so the win cannot silently drift back — a promise that was
 * unenforced, because the ratchet was a number in a comment that only a human
 * re-measuring by hand could check.
 *
 * ── Why this reuses `system:precompute-derived-reads` instead of a new action ────
 * That action ALREADY reads `only` from its `trigger_config` and forwards it to
 * `refreshDerivedReads({ only })`, and `refreshDerivedReads` already runs an
 * `excludeFromDefaultSweep` producer when it is named explicitly. So the entire
 * "give this producer its own cadence" requirement is satisfied by a SECOND ROUTINE
 * ROW against the SAME target_role — no sibling action, no duplicated dispatch seam.
 * A new `system:sync-read-audit` action would have been a parallel mechanism for
 * something the existing one already does.
 *
 * ── Why a separate routine at all, rather than just letting the sweep run it ─────
 * `syncReads.audit` is registered `excludeFromDefaultSweep: true`. Producers run
 * SEQUENTIALLY and the shared 2-min routine is `concurrency: 'skip'`, so a
 * minutes-scale producer in that pass holds the loop long enough to starve the
 * 90s-ttl `serviceHealth` for several ticks. Separate routine rows have independent
 * `concurrency: 'skip'` locks, so this audit can take as long as it needs without
 * ever blocking the sweep's head of line. THAT is the isolation being bought here —
 * not a lower frequency.
 *
 * HOURLY fire, ~12h effective cadence. The signal is content drift (plans grow
 * ~45-50/week), not code drift, so a twice-daily reading is ample — but the SCHEDULE
 * must not be the thing that delivers it. The producer's 12h ttl is the real cadence
 * governor (the ttl is the don't-recompute-twice guard); the cron only decides how
 * many CHANCES it gets to find the snapshot due.
 *
 * ⚠ It fired DAILY until 2026-08-08, and in that shape it never completed ONCE —
 * `syncReads.audit` wrote no snapshot for the ~5 days it was armed (CANCELLED 3/3 on
 * Aug 6/7/8). A fire is enqueued on the non-critical `routines` queue; bg-host restarts
 * here several times an hour (PG-pool-starvation shedding fires CRITICAL-queue routines
 * only), each restart recovers the still-ENQUEUED workflow, `recovery_attempts` reaches
 * 3, and DBOS cancels it with an EMPTY error. `catchup:'skip-old'` means a lost fire is
 * never retried — so a DAILY routine loses the entire day, while `last_fired_at` still
 * advances and the routines table looks healthy (fact:
 * daily-routine-fires-die-to-recovery-cancel; same signature as EI-396, different cause).
 *
 * A 2-min routine self-heals on its next tick, which is exactly why this class of bug
 * only bites LOW-FREQUENCY routines. Hourly buys ~12 independent chances per ttl window
 * at zero extra compute: every fire inside a fresh 12h window is a cheap SELECT that
 * finds the snapshot still fresh and returns.
 *
 * Seeded ACTIVE: pure measurement — it spawns no agent, makes no network call, and
 * writes only to its own snapshot row. It WARNS and must never block a deploy
 * (no-http-anywhere-2026-07-28#D-009/#D-011: a budget warns, an invariant blocks, and
 * the remedy for a blind instrument is a red spec, not a blocked deploy).
 *
 *   tsx seed-sync-read-audit-routine.ts             # seed + enable (default)
 *   tsx seed-sync-read-audit-routine.ts --inactive  # seed but leave disabled
 *   tsx seed-sync-read-audit-routine.ts --backfill  # also force one immediate run
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SYNC_READ_AUDIT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/**
 * Hourly at :30. Six-field cron (leading seconds), matching the sibling routines.
 * The producer's 12h ttl — not this cron — sets the real recompute cadence; the extra
 * fires exist so a single lost/cancelled fire cannot cost a whole ttl window (see the
 * header note on the daily shape that never completed once).
 */
const CRON = '0 30 * * * *';
/** The one producer this routine drives — it is excluded from the default sweep. */
const PRODUCER_KEY = 'syncReads.audit';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const backfill = process.argv.includes('--backfill');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'sync-read-audit';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // `only` is what makes this routine drive the excluded producer and NOTHING else —
  // without it this row would re-run the entire default sweep on a second cadence.
  const triggerConfig = { cron: CRON, only: [PRODUCER_KEY] };

  // The next :30, NOT now(). The sibling precompute routine seeds `now()`, which is
  // harmless at a 2-minute cadence — but this producer is a minutes-scale audit, so
  // `now()` would make the act of SEEDING (or of any re-seed, e.g. a deploy) silently
  // kick off a heavy compute immediately. Seeding should install a schedule, not
  // trigger a run. `--backfill` remains the explicit way to ask for one now.
  const nextFire = new Date();
  nextFire.setUTCSeconds(0, 0);
  nextFire.setUTCMinutes(30);
  if (nextFire.getTime() <= Date.now()) nextFire.setUTCHours(nextFire.getUTCHours() + 1);

  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:precompute-derived-reads', 'skip', 'skip-old', ${active}, ${nextFire.toISOString()})
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- next_fire_at IS re-applied, unlike 'active' below. A re-seed that changes the
      -- CRON but leaves the old next_fire_at in place installs a schedule that does not
      -- take effect until the next fire under the OLD cadence — worthless precisely when
      -- the cadence is being changed BECAUSE fires are being lost (2026-08-08: the
      -- daily-to-hourly move would not have applied until the next day's fire, itself the
      -- fire most likely to be cancelled). Always within 1h, so it cannot starve the row.
      next_fire_at = EXCLUDED.next_fire_at,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-sync-read-audit-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `cron ${CRON}, only=[${PRODUCER_KEY}].`,
  );

  if (backfill) {
    const { refreshDerivedReads } = await import('../../derived-reads/registry');
    await import('../../derived-reads/producers');
    const outcomes = await refreshDerivedReads({
      workspaceId: ws,
      harnessSlug: SLUG,
      force: true,
      only: [PRODUCER_KEY],
    });
    for (const o of outcomes) {
      console.log(
        `[seed-sync-read-audit-routine] backfill ${o.key}: ` +
          (o.error ? `FAILED — ${o.error}` : `${o.computeMs}ms`),
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-sync-read-audit-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
