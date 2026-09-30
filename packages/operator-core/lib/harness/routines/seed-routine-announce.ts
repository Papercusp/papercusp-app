/**
 * Shared print helper for every `seed-*.ts` routine script — EI-19281184378946951.
 *
 * SEEDING THE ROW IS ONLY HALF OF SHIPPING A ROUTINE. `system:<action>` handlers are
 * dispatched by `routinesTick`, which runs ONLY in bg-host (`PAPERCUSP_BACKGROUND_WORKERS=1`).
 * `:3070`/`:3170` boot request-only and never invoke it, and a DEPLOY DOES NOT CARRY IT
 * (EI-11120). So against a bg-host started BEFORE this code landed, the routine still fires
 * on schedule — `next_fire_at`/`last_fired_at` advance normally — but finds no registered
 * handler and silently does nothing, presenting as a perfectly healthy active row (the
 * EI-18741229858124453 class). Measured directly on 2026-08-01: `gc-verify-instances` seeded
 * ACTIVE, fired on schedule, reaped zero — because bg-host was 4 days stale.
 *
 * `dev:pipeline_position { path }` diagnoses this precisely and unprompted (its `serving`
 * stage reports whether the running process predates the code), but nothing POINTS a reader
 * at it, because from the outside a seeded routine that fires looks like it worked.
 *
 * This was hand-copied into `seed-gc-verify-instances-routine.ts` (WI-6684) and
 * `seed-gc-desktop-sessions-routine.ts` (WI-40868), and — being hand-copied prose, not a
 * shared call — was silently absent from `seed-gc-dead-loops-routine.ts` and every other
 * `seed-*.ts` in this directory. This helper is the single source of that warning so a new
 * seed script gets it by calling one function instead of remembering to paste it.
 *
 * Call this as the LAST statement in `main()`, after the seed `INSERT ... ON CONFLICT` has
 * succeeded — it is purely informational (stdout only, no I/O), so it cannot itself fail the
 * seed.
 */
export function announceRoutineSeeded(scriptTag: string, actionPath: string): void {
  console.log(
    `[${scriptTag}] ⚠ NOT LIVE YET unless bg-host is running this code. ` +
      'A routine handler loads on RESTART, never on deploy (EI-11120): ' +
      "dev:restart { target: 'bg-host', confirm: true, authorize: true, reason: '...' }. " +
      `Verify with dev:pipeline_position { path: "${actionPath}" } — ` +
      'its `serving` stage reports whether bg-host predates the code.',
  );
}
