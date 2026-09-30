import { withDbCallDeadline } from '@papercusp/db-org';

/**
 * routine-tick-overlap-guard.ts — EI-9935: prevent routinesTickImpl invocations
 * from running CONCURRENTLY.
 *
 * WHY. routinesTickImpl (routines-workflow.ts) is registered as a DBOS scheduled
 * workflow on a 30s crontab. DBOS's scheduler fires on that cadence regardless
 * of whether the PRIOR invocation has finished — nothing previously stopped a
 * new tick from starting while an earlier one was still mid-flight.
 *
 * CONFIRMED LIVE (2026-07-12 00:15-00:30 EDT, EI-9935 investigation — queried
 * dbos.workflow_status directly): individual ticks that normally complete in
 * ~15-20s ballooned to 58-93s under host/PG-pool contention, and — because
 * nothing prevented overlap — MULTIPLE ticks ran CONCURRENTLY (e.g. the
 * 00:19:32 tick was still running when the 00:20:01 and 00:20:31 ticks both
 * started; negative gaps between one tick's start and the PRIOR tick's finish
 * were observed repeatedly through the window). Each concurrent invocation
 * independently walks the same ~17-step serial PG-touching sweep chain
 * (routinesTickImpl's doc comment), so overlap directly COMPOUNDS the very PG
 * contention that slowed the first tick — a self-amplifying pile-up. This
 * starves due routines (including armed su loop wakes) of their fire window
 * long enough to trip the infra-liveness `dead-routines` >10m alarm even
 * though the tick "engine" was never actually dead, just increasingly
 * overlapped and slow.
 *
 * RELATION TO THE EXISTING PRESSURE SHEDS. loopPressure()/poolPressure()
 * (tick-load-shed.ts, pool-pressure.ts — landed for the similar-shaped
 * 2026-07-01/02 incident) gate whether a NEW tick invocation proceeds PAST ITS
 * OWN START, based on pressure measured at that instant. They do not — and
 * were never meant to — stop a SECOND tick from starting once a first one is
 * already past that gate and simply running long; the observed overlap window
 * above happened WITH those guards already live, because each individual tick
 * start still read pressure as survivable at the moment it checked. This
 * module adds the missing invariant directly: a new tick defers (a shed, not
 * an error) whenever another routinesTick invocation is genuinely still in
 * flight — independent of what pressure looks like at this instant.
 *
 * STALE-SAFE. Only treats a PENDING routinesTick row as "in flight" for up to
 * `staleMs` (default 5 min — several multiples of the worst observed 93s), so
 * a crashed/never-completed row (its executor died mid-tick, status stuck at
 * PENDING) cannot permanently wedge the scheduler. DBOS's own
 * recovery/executor-reaper machinery is the eventual source of truth for a
 * genuinely dead workflow row; this is only a shed heuristic.
 */

export const ROUTINE_TICK_OVERLAP_STALE_MS = Math.max(
  1,
  Number(process.env.PAPERCUSP_ROUTINES_TICK_OVERLAP_STALE_MS) || 5 * 60_000,
);

/**
 * Keep the overlap probe shorter than the scheduler's cadence. The DB-side
 * statement timeout below protects a checked-out connection; this caller-side
 * deadline also covers pool acquisition and a dead endpoint, either of which
 * can otherwise leave routinesTick wedged before PostgreSQL gets to run the
 * query.
 */
export const ROUTINE_TICK_OVERLAP_QUERY_DEADLINE_MS = Math.max(
  250,
  Number(process.env.PAPERCUSP_ROUTINES_TICK_OVERLAP_QUERY_DEADLINE_MS) || 5_000,
);

/**
 * The statement timeout is deliberately below the whole-call deadline, leaving
 * a small amount of room for BEGIN/connection release while preserving the
 * fail-soft caller bound. It is independently tunable for a slow-but-healthy
 * database, but can never exceed the caller deadline.
 */
export const ROUTINE_TICK_OVERLAP_STATEMENT_TIMEOUT_MS = Math.max(
  100,
  Math.min(
    ROUTINE_TICK_OVERLAP_QUERY_DEADLINE_MS - 100,
    Number(process.env.PAPERCUSP_ROUTINES_TICK_OVERLAP_STATEMENT_TIMEOUT_MS) || 3_000,
  ),
);

export interface InFlightRow {
  workflow_uuid: string;
}

export interface OverlapCheckDeps {
  /** Query any OTHER 'PENDING' routinesTick row started at/after `cutoffEpochMs`. */
  queryInFlight: (selfWorkflowId: string, cutoffEpochMs: number) => Promise<InFlightRow[]>;
  now?: () => number;
  /** Injectable for deterministic tests; production uses the DB call deadline. */
  withDeadline?: typeof withDbCallDeadline;
}

/** Pure decision from a query result — exported for a trivial no-DB unit test. */
export function shouldShedForOverlap(rows: InFlightRow[]): boolean {
  return rows.length > 0;
}

/**
 * True when another routinesTick invocation is genuinely still in flight (the
 * caller should shed / skip this tick). FAIL-SOFT: any query error resolves to
 * false — a probe failure must never wedge the scheduler (mirrors
 * poolPressure()'s fail-soft contract; absence of a clean signal never sheds).
 */
export async function anotherRoutinesTickInFlight(
  selfWorkflowId: string,
  deps: OverlapCheckDeps,
  staleMs: number = ROUTINE_TICK_OVERLAP_STALE_MS,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  try {
    const rows = await (deps.withDeadline ?? withDbCallDeadline)(
      deps.queryInFlight(selfWorkflowId, now() - staleMs),
      {
        ms: ROUTINE_TICK_OVERLAP_QUERY_DEADLINE_MS,
        label: 'routinesTick overlap probe',
      },
    );
    return shouldShedForOverlap(rows);
  } catch {
    return false;
  }
}
