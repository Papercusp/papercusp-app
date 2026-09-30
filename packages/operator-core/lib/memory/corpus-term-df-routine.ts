/**
 * corpus-term-df-routine — the refresh cadence for the P-018 / D-064 corpus
 * document-frequency table.
 *
 * A `harness_shared.routines` row with `target_role='system:corpus-term-df'`,
 * `tier='durable'` — a `trigger_kind='cron'` row fired by the DBOS
 * `routinesTick` (`listDueCronRoutines`, Postgres-backed `next_fire_at`).
 * Mirrors `seed-sql-read-census-routine.ts`'s durable-cron seed shape.
 *
 * WI-1406487: this row was originally `tier='ephemeral'` (a bounded
 * in-process `managedSetInterval`, armed per-host by
 * `lib/dbos/ephemeral-executor.ts`) at a 6h `interval_sec`. That is
 * STRUCTURALLY UNFIREABLE at this cadence: the ephemeral executor's timer is
 * re-armed from zero on every bg-host restart, and this box's measured
 * longest continuous bg-host uptime (336min) is shorter than the 360min
 * interval — so the timer has never once reached its own deadline. The
 * durable tier is immune to this: `next_fire_at` is a Postgres column, so a
 * restart between ticks loses nothing — `routinesTick` picks the row back up
 * on the next 30s sweep and fires it the moment `next_fire_at` is due,
 * exactly as it does for `sql-read-census` and every other multi-hour
 * durable cadence in this file's sibling seeds.
 *
 * ⚠ CADENCE IS DELIBERATELY SLOW, and slower than it "could" be. The refresh
 * folds tens of thousands of documents through `corpusTerms`, but that is not
 * why — what matters is that DF only feeds a RANKING among ~100 candidate terms.
 * A term's position in that ordering does not turn over on the timescale the
 * corpus grows, so a faster cadence would buy no ranking change and spend real
 * CPU on a shared box. Staleness here is bounded, not eliminated, on purpose.
 */
import type { Sql } from 'postgres';

export const CORPUS_TERM_DF_ROUTINE_NAME = 'corpus-term-df';
export const CORPUS_TERM_DF_TARGET = 'system:corpus-term-df';

/**
 * Every 6 hours, offset to minute 7 (clear of the box's :00/:15/:35/:45
 * cron-tick cluster — see seed-sql-read-census-routine.ts's note on picking
 * an off-clock minute). Fires at 00:07 / 06:07 / 12:07 / 18:07 host-local
 * (`computeNextFireAt` evaluates crontab in the host timezone, not UTC — say
 * local, mean local). See the cadence note above — this is a ranking signal,
 * not a freshness-critical one, so a fixed 6h period is deliberately coarse.
 */
export const DEFAULT_CORPUS_TERM_DF_CRON = '7 */6 * * *';

export interface CorpusTermDfRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  /** The harness install slug this row belongs to. */
  installSlug: string;
  /** Override the default 6-hourly cron (test seam; production callers omit
   *  this and get DEFAULT_CORPUS_TERM_DF_CRON). Standard 5- or 6-field
   *  crontab, per computeNextFireAt / cron-parser. */
  cron?: string;
  sampleDocs?: number;
  /** Defaults ACTIVE: the table is additive — until it is first populated the
   *  lookup returns null and the leg keeps its original length ordering, so
   *  there is nothing to stage dark. */
  active?: boolean;
}

function routineId(installSlug: string, name: string): string {
  return `rt_${installSlug}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Upsert the workspace's `system:corpus-term-df` durable cron routine. Idempotent
 * on (install_slug, name) — a bare re-materialize never clobbers a human-edited
 * `active` toggle; pass `active` explicitly to change it.
 */
export async function upsertCorpusTermDfRoutine(
  sql: Sql,
  input: CorpusTermDfRoutineInput,
): Promise<{ id: string }> {
  const id = routineId(input.installSlug, CORPUS_TERM_DF_ROUTINE_NAME);
  const cron = input.cron ?? DEFAULT_CORPUS_TERM_DF_CRON;
  const triggerConfig = JSON.stringify({
    cron,
    ...(input.sampleDocs != null ? { sample_docs: input.sampleDocs } : {}),
  });

  // `tier='durable'`: this row rides the DBOS `routinesTick` /
  // `listDueCronRoutines` (`active=TRUE AND trigger_kind='cron' AND
  // tier='durable'`), whose due-gate is the Postgres `next_fire_at` column —
  // survives a bg-host restart, unlike the ephemeral executor's in-process
  // timer this row used to run on (WI-1406487). `next_fire_at = now()` seeds
  // it due-on-the-next-tick; the loop engine's own reschedule step
  // (schedule-next.ts, computeNextFireAt) advances it to the next 6h slot
  // after each fire. On conflict, `next_fire_at` IS re-applied (unlike
  // `active`) so a tier migration or a cron-string change actually takes
  // effect on the next boot's re-seed rather than being silently ignored.
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${input.installSlug}, ${CORPUS_TERM_DF_ROUTINE_NAME}, 'cron',
      ${triggerConfig}::text::jsonb, ${CORPUS_TERM_DF_TARGET},
      'skip', 'skip-old', ${input.active ?? true}, 'durable', now(), ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      next_fire_at   = EXCLUDED.next_fire_at,
      -- active is deliberately NOT re-applied: a bare re-seed must never clobber
      -- an operator's runtime pause of this routine (EI-19301170070808928).
      updated_at     = now()
  `;

  return { id };
}
